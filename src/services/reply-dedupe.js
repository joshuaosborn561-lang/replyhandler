const db = require('../db');
const { postProspectSlackCard } = require('./slack-reply-post');
const { applyClientDraftPolicy } = require('../utils/client-draft-policy');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');

/**
 * Collapse every Unicode space (including NBSP U+00A0) to a single ASCII space.
 *
 * Critical: Postgres POSIX `\s` does NOT match NBSP, while JavaScript `\s`
 * does. LinkedIn/HeyReach bodies often contain NBSP (e.g. before a URL).
 * If SQL keeps the NBSP and JS turns it into a normal space, dedupe never
 * matches and the poller re-posts the same card every cycle.
 */
function normalizeInboundText(text) {
  return String(text || '')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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

/**
 * Every codepoint normalizeInboundText's regex strips, mirrored for SQL.
 * Postgres POSIX `\s` matches none of these, so each needs its own `replace()`
 * before the `\s+` collapse — chr(160) and chr(8239) alone (the old list)
 * missed zero-width space (8203) and friends. A prospect's signature line with
 * invisible characters like "Pete Langlois ​ ​ ​ ​" then
 * normalized differently on the JS side vs the stored-column SQL side, so
 * dedupe never matched and the poller re-posted the same reply every cycle
 * (2026-08-05, Pete Langlois/TechEvolution — 170 duplicate cards over ~4h).
 */
const UNICODE_SPACE_CODEPOINTS = [
  160,   // NBSP
  5760,  // OGHAM SPACE MARK
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, // EN QUAD .. ZERO WIDTH SPACE
  8239,  // NARROW NBSP
  8287,  // MEDIUM MATHEMATICAL SPACE
  12288, // IDEOGRAPHIC SPACE
  65279, // ZERO WIDTH NO-BREAK SPACE / BOM
];

function stripUnicodeSpacesSql(column) {
  return UNICODE_SPACE_CODEPOINTS.reduce(
    (sql, code) => `replace(${sql}, chr(${code}), ' ')`,
    column
  );
}

const STORED_NORM_SQL = (
  `lower(trim(both from regexp_replace(` +
  `${stripUnicodeSpacesSql('inbound_message')}, ` +
  `'\\s+', ' ', 'g')))`
);

/** SQL for the same key, applied to the stored column. */
const STORED_PREFIX_SQL = `left(${STORED_NORM_SQL}, ${PREFIX_LEN})`;

/**
 * Shortest text that can safely be called "the same reply". Below this, a
 * containment match would collapse genuinely different short replies.
 */
const MIN_CONTAINMENT_LEN = 40;

/**
 * SQL that matches a stored reply against one we are considering.
 *
 * Two ways the same reply can look different between the webhook and the
 * poller, and both must count as a duplicate:
 *   - divergent tails (signature, quoted headers) → compare leading slices
 *   - one rendering truncated earlier than the other → prefix containment
 *
 * Deliberately NOT time-bounded. The same text from the same person is always
 * a duplicate; different text from the same person is always a new reply that
 * must come through, however soon it arrives.
 *
 * $p = 120-char prefix, $f = full normalised text.
 */
function sameReplySql(prefixParam, fullParam) {
  return `(
    (${prefixParam}::text <> '' AND ${STORED_PREFIX_SQL} = ${prefixParam})
    OR (
      length(${fullParam}::text) >= ${MIN_CONTAINMENT_LEN}
      AND length(${STORED_NORM_SQL}) >= ${MIN_CONTAINMENT_LEN}
      AND (
        left(${STORED_NORM_SQL}, length(${fullParam}::text)) = ${fullParam}
        OR left(${fullParam}::text, length(${STORED_NORM_SQL})) = ${STORED_NORM_SQL}
      )
    )
  )`;
}

async function alreadyPostedToSlack({
  clientId,
  platform,
  campaignId,
  leadId,
  inboundMessage,
  emailStatsId,
}) {
  // Text only — never smartlead_email_stats_id. That id is the most recent
  // outbound SENT stats id, identical across different replies to the same
  // send. Matching on it silently drops a new reply (webhook fixed in #31;
  // poller still had the OR-branch). emailStatsId kept in the signature for
  // callers; unused for matching.
  void emailStatsId;
  void campaignId;
  const normalized = inboundPrefix(inboundMessage);
  const fullNorm = normalizeInboundText(inboundMessage);
  if (!normalized) return false;

  const { rows } = await db.query(
    `SELECT id
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND ${sameReplySql('$3', '$5')}
        AND (
          $4::text = ''
          OR COALESCE(lead_id, '') = $4
        )
        AND (
          slack_message_ts IS NOT NULL
          -- A suppressed reply is a decided reply: it reached a terminal state
          -- on purpose and must never be reprocessed. It has no
          -- slack_message_ts by definition, so requiring one here meant every
          -- poll cycle re-classified and re-inserted the same suppressed reply
          -- forever. Measured 2026-08-19: 88,769 suppressed rows over 3 days
          -- for 193 distinct replies (~460x), worst offenders at 863 copies of
          -- a single reply, each copy having burned a classifier call.
          OR status = 'suppressed'
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      clientId,
      platform,
      normalized,
      leadId != null ? String(leadId) : '',
      fullNorm,
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
  void emailStatsId;
  void campaignId;
  const normalized = inboundPrefix(inboundMessage);
  const fullNorm = normalizeInboundText(inboundMessage);
  if (!normalized) return null;

  const { rows } = await db.query(
    `SELECT *
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND slack_message_ts IS NULL
        AND status IN ('pending', 'alert_only')
        AND ${sameReplySql('$3', '$5')}
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
      fullNorm,
    ]
  );
  return rows[0] || null;
}

function formatCampaignDisplayFromReply(reply) {
  return formatCampaignDisplay(campaignNameFromReply(reply), reply.campaign_id);
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
  const { shouldPostToSlackChannel } = require('../utils/slack-channel-policy');
  if (!shouldPostToSlackChannel({
    classification: reply.classification,
    inboundMessage: reply.inbound_message,
  })) {
    console.log('[Dedupe] Skip Slack recovery — not an interested-channel classification', {
      replyId: reply.id,
      classification: reply.classification,
    });
    return false;
  }

  const policy = applyClientDraftPolicy(client, reply.lead_email, {
    classification: reply.classification,
    draft: reply.draft_reply,
    reasoning: reasoningExtra || `Recovered unposted Slack card for ${reply.lead_name}.`,
  });
  if (policy.skippedDraft && reply.draft_reply) {
    await db.query(
      `UPDATE pending_replies
          SET draft_reply = NULL, status = 'alert_only', updated_at = now()
        WHERE id = $1`,
      [reply.id]
    );
  }
  const isDraft = policy.isDraft;
  const card = {
    replyId: reply.id,
    leadName: reply.lead_name,
    leadEmail: reply.lead_email,
    platform: reply.platform,
    classification: reply.classification,
    draft: policy.draft,
    reasoning: policy.reasoning,
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
        AND pr.classification IN ('INTERESTED', 'MEETING_PROPOSED', 'QUESTION')
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
  normalizeInboundText,
  sameReplySql,
  MIN_CONTAINMENT_LEN,
  STORED_PREFIX_SQL,
  STORED_NORM_SQL,
  UNICODE_SPACE_CODEPOINTS,
  alreadyPostedToSlack,
  findUnpostedReply,
  repostReplyRowToSlack,
  recoverUnpostedSlackCards,
};
