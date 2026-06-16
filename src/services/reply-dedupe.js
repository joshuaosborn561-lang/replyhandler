const db = require('../db');
const { postProspectSlackCard } = require('./slack-reply-post');
const { DRAFT_CLASSIFICATIONS } = require('./classifier');

function normalizeInboundText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Skip only when this exact inbound was already posted to Slack (has slack_message_ts).
 * Rows saved to DB without a Slack post must be retried.
 */
async function alreadyPostedToSlack({
  clientId,
  platform,
  campaignId,
  leadId,
  inboundMessage,
}) {
  const normalized = normalizeInboundText(inboundMessage);
  if (!normalized) return false;

  const { rows } = await db.query(
    `SELECT slack_message_ts
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND COALESCE(campaign_id, '') = COALESCE($3::text, '')
        AND COALESCE(lead_id, '') = COALESCE($4::text, '')
        AND lower(regexp_replace(inbound_message, '\\s+', ' ', 'g')) = $5
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      clientId,
      platform,
      campaignId != null ? String(campaignId) : '',
      leadId != null ? String(leadId) : '',
      normalized,
    ]
  );
  if (!rows.length) return false;
  return !!rows[0].slack_message_ts;
}

async function findUnpostedReply({
  clientId,
  platform,
  campaignId,
  leadId,
  inboundMessage,
}) {
  const normalized = normalizeInboundText(inboundMessage);
  if (!normalized) return null;

  const { rows } = await db.query(
    `SELECT *
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND COALESCE(campaign_id, '') = COALESCE($3::text, '')
        AND COALESCE(lead_id, '') = COALESCE($4::text, '')
        AND slack_message_ts IS NULL
        AND lower(regexp_replace(inbound_message, '\\s+', ' ', 'g')) = $5
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      clientId,
      platform,
      campaignId != null ? String(campaignId) : '',
      leadId != null ? String(leadId) : '',
      normalized,
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
  normalizeInboundText,
  alreadyPostedToSlack,
  findUnpostedReply,
  repostReplyRowToSlack,
  recoverUnpostedSlackCards,
};
