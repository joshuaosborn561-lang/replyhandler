const db = require('../db');
const { postProspectSlackCard } = require('./slack-reply-post');
const { DRAFT_CLASSIFICATIONS } = require('./classifier');

function normalizeInboundText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Dedupe key for a reply body.
 *
 * The webhook and the poller render the same reply differently — one keeps the
 * quoted "From:" header, the other expands links and image alt-text — so the
 * two texts agree for a long opening run and then diverge in the tail. Exact
 * comparison misses that; a leading slice does not. Measured on a real pair:
 * identical for 165 chars, total lengths 182 vs 350.
 *
 * Shorter than the window means the whole message is compared, so short
 * replies still need to match exactly.
 */
const PREFIX_LEN = 120;

function inboundPrefix(text) {
  return normalizeInboundText(text).slice(0, PREFIX_LEN);
}

/** SQL for the same key, applied to the stored column. */
const STORED_PREFIX_SQL = `left(lower(regexp_replace(inbound_message, '\\s+', ' ', 'g')), ${PREFIX_LEN})`;

/**
 * Skip only when this exact inbound was already posted to Slack (has slack_message_ts).
 * Rows saved to DB without a Slack post must be retried.
 *
 * Match on client + platform + inbound text, optionally scoped by lead_id when present.
 * Do NOT require campaign_id equality — GetConversationsV2 often omits/changes it, which
 * previously caused duplicate inserts every poll while Slack was failing.
 */
async function alreadyPostedToSlack({
  clientId,
  platform,
  campaignId,
  leadId,
  inboundMessage,
  emailStatsId,
}) {
  const normalized = inboundPrefix(inboundMessage);
  const stats = emailStatsId != null ? String(emailStatsId).trim() : '';
  if (!normalized && !stats) return false;

  const { rows } = await db.query(
    `SELECT slack_message_ts
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND (
          ($5::text <> '' AND COALESCE(smartlead_email_stats_id, '') = $5)
          OR ($3::text <> '' AND ${STORED_PREFIX_SQL} = $3)
        )
        AND (
          $4::text = ''
          OR COALESCE(lead_id, '') = $4
        )
        AND slack_message_ts IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      clientId,
      platform,
      normalized,
      leadId != null ? String(leadId) : '',
      stats,
    ]
  );
  return rows.length > 0;
}

async function findUnpostedReply({
  clientId,
  platform,
  campaignId,
  leadId,
  inboundMessage,
  emailStatsId,
}) {
  const normalized = inboundPrefix(inboundMessage);
  const stats = emailStatsId != null ? String(emailStatsId).trim() : '';
  if (!normalized && !stats) return null;

  const { rows } = await db.query(
    `SELECT *
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND slack_message_ts IS NULL
        AND status IN ('pending', 'alert_only')
        AND (
          ($5::text <> '' AND COALESCE(smartlead_email_stats_id, '') = $5)
          OR ($3::text <> '' AND ${STORED_PREFIX_SQL} = $3)
        )
        AND (
          $4::text = ''
          OR COALESCE(lead_id, '') = $4
        )
      ORDER BY created_at ASC
      LIMIT 1`,
    [
      clientId,
      platform,
      normalized,
      leadId != null ? String(leadId) : '',
      stats,
    ]
  );
  return rows[0] || null;
}

function formatCampaignDisplayFromReply(reply) {
  const id = reply.campaign_id != null ? String(reply.campaign_id).trim() : '';
  if (id) return `Campaign ${id}`;
  return '';
}

function lastOutboundFromThreadContext(reply) {
  let tc = reply.thread_context;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  if (!tc) return '';
  const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');
  if (reply.platform === 'smartlead') {
    return lastOutboundBodyFromSmartleadHistory(tc) || '';
  }
  const messages = Array.isArray(tc?.messages) ? tc.messages : [];
  let last = '';
  for (const m of messages) {
    const role = String(m?.role || '').toLowerCase();
    if (role === 'us' || role === 'me') {
      const t = m.message || m.text || m.body || '';
      if (String(t).trim()) last = String(t).trim();
    }
  }
  return last;
}

async function repostReplyRowToSlack(client, reply, { reasoningExtra } = {}) {
  const isDraft = DRAFT_CLASSIFICATIONS.includes(reply.classification);
  const card = {
    replyId: reply.id,
    leadName: reply.lead_name,
    leadEmail: reply.lead_email,
    platform: reply.platform,
    classification: reply.classification,
    draft: reply.draft_reply,
    reasoning: reasoningExtra || `Recovered unposted Slack card for ${reply.lead_name}.`,
    inboundMessage: reply.inbound_message,
    campaignDisplay: formatCampaignDisplayFromReply(reply),
    lastOutboundMessage: lastOutboundFromThreadContext(reply) || undefined,
  };

  await postProspectSlackCard({
    token: client.slack_bot_token,
    channelId: client.slack_channel_id,
    clientId: client.id,
    platform: reply.platform,
    campaignId: reply.campaign_id,
    leadId: reply.lead_id,
    threadContext: reply.thread_context,
    isDraft,
    replyId: reply.id,
    card,
  });
  return true;
}

/** Retry any DB rows that never made it to Slack (e.g. Slack API error after insert). */
async function recoverUnpostedSlackCards({ limit = 25 } = {}) {
  const { rows } = await db.query(
    `SELECT pr.*, c.slack_bot_token, c.slack_channel_id, c.name AS client_name
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.slack_message_ts IS NULL
        AND pr.status IN ('pending', 'alert_only')
        AND c.active IS DISTINCT FROM false
        AND pr.created_at > now() - interval '7 days'
      ORDER BY pr.created_at ASC
      LIMIT $1`,
    [limit]
  );

  let recovered = 0;
  for (const row of rows) {
    const client = {
      id: row.client_id,
      name: row.client_name,
      slack_bot_token: row.slack_bot_token,
      slack_channel_id: row.slack_channel_id,
    };
    try {
      await repostReplyRowToSlack(client, row, {
        reasoningExtra: 'Recovered: reply was saved but never posted to Slack.',
      });
      recovered++;
      console.log('[ReplyDedupe] Recovered unposted Slack card', {
        replyId: row.id, client: client.name, lead: row.lead_name,
      });
    } catch (err) {
      console.error('[ReplyDedupe] Failed to recover unposted card', {
        replyId: row.id, lead: row.lead_name, err: err.message,
      });
    }
  }
  return { recovered, scanned: rows.length };
}

module.exports = {
  inboundPrefix,
  STORED_PREFIX_SQL,
  normalizeInboundText,
  alreadyPostedToSlack,
  findUnpostedReply,
  repostReplyRowToSlack,
  recoverUnpostedSlackCards,
};
