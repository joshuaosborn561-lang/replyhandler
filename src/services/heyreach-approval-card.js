/**
 * Promote one stored HeyReach reply into an approval card.
 *
 * Updates that row in place (classification, draft, status). Does not insert
 * a second pending_replies row and does not post when this inbound already
 * has a Slack card.
 */

const db = require('../db');
const { postProspectSlackCard } = require('./slack-reply-post');
const { formatCampaignDisplay } = require('../utils/campaign-display');
const {
  inboundPrefix,
  normalizeInboundText,
  sameReplySql,
  isPostedSlackTs,
} = require('./reply-dedupe');

const DRAFT_CLASSIFICATIONS = new Set(['INTERESTED', 'MEETING_PROPOSED', 'QUESTION']);

/** Any other label (OTHER, NOT_INTERESTED, WRONG_PERSON, ...) posts as an alert card with no draft. */
const CLASSIFICATION_PATTERN = /^[A-Z][A-Z_]{1,39}$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseThread(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function lastOutboundFromThread(threadContext) {
  const ctx = parseThread(threadContext);
  const messages = Array.isArray(ctx) ? ctx : (Array.isArray(ctx?.messages) ? ctx.messages : []);
  let last = '';
  for (const message of messages) {
    const role = String(message?.role || '').toLowerCase();
    if (role !== 'us' && role !== 'me') continue;
    const text = String(message.message || message.text || message.body || '').trim();
    if (text) last = text;
  }
  return last;
}

async function findPostedSibling(row, query) {
  const prefix = inboundPrefix(row.inbound_message);
  const full = normalizeInboundText(row.inbound_message);
  if (!prefix && !full) return null;
  const { rows } = await query(
    `SELECT id, slack_message_ts
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'heyreach'
        AND id <> $2
        AND slack_message_ts IS NOT NULL
        AND slack_message_ts NOT LIKE 'claiming:%'
        AND COALESCE(classification, '') <> 'FOLLOW_UP'
        AND ${sameReplySql('$3', '$4')}
      ORDER BY created_at ASC
      LIMIT 1`,
    [row.client_id, row.id, prefix, full]
  );
  return rows[0] || null;
}

async function postStoredHeyreachApprovalCard({
  replyId,
  draft,
  classification,
  reasoning,
  query = (...args) => db.query(...args),
  postFn = postProspectSlackCard,
} = {}) {
  const id = String(replyId || '').trim();
  if (!id) throw httpError(400, 'replyId is required');
  const draftText = String(draft || '').trim();
  const requested = String(classification || '').trim().toUpperCase();
  if (requested && !CLASSIFICATION_PATTERN.test(requested)) {
    throw httpError(400, 'classification must be a label like INTERESTED, QUESTION, OTHER, NOT_INTERESTED');
  }
  // A draft with no label keeps the old default (INTERESTED). No draft and no label
  // re-posts the stored label as an alert card (neutral replies have no draft).
  let cls = requested || (draftText ? 'INTERESTED' : '');
  const asDraft = DRAFT_CLASSIFICATIONS.has(cls);
  if (asDraft && !draftText) throw httpError(400, 'draft is required');

  const { rows } = await query(
    `SELECT pr.*,
            c.name AS client_name,
            c.slack_bot_token,
            c.slack_channel_id,
            c.active
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) throw httpError(404, 'stored reply not found');
  if (row.platform !== 'heyreach') throw httpError(400, 'stored reply is not a HeyReach reply');
  if (row.active === false) throw httpError(409, 'client is inactive');
  if (!row.slack_bot_token || !row.slack_channel_id) {
    throw httpError(409, 'client has no Slack channel');
  }

  if (!cls) cls = String(row.classification || '').trim().toUpperCase() || 'OTHER';
  if (DRAFT_CLASSIFICATIONS.has(cls) && !draftText) {
    throw httpError(400, 'draft is required for INTERESTED, MEETING_PROPOSED, or QUESTION');
  }
  const isDraft = DRAFT_CLASSIFICATIONS.has(cls);
  const cardReasoning = reasoning || (isDraft
    ? 'Manually promoted to an approval card from the stored LinkedIn reply.'
    : 'LinkedIn reply posted for visibility (no draft).');

  if (row.status === 'sent') {
    return { ok: true, posted: false, reason: 'already_sent', replyId: row.id };
  }
  if (isPostedSlackTs(row.slack_message_ts)) {
    return {
      ok: true,
      posted: false,
      reason: 'card_already_posted',
      replyId: row.id,
      slackMessageTs: row.slack_message_ts,
    };
  }

  const sibling = await findPostedSibling(row, query);
  if (sibling && isPostedSlackTs(sibling.slack_message_ts)) {
    return {
      ok: true,
      posted: false,
      reason: 'duplicate_card',
      replyId: row.id,
      existingReplyId: sibling.id,
      slackMessageTs: sibling.slack_message_ts,
    };
  }

  const { rows: updatedRows } = await query(
    `UPDATE pending_replies
        SET classification = $1,
            draft_reply = $2,
            status = $4,
            updated_at = now()
      WHERE id = $3
        AND status IN ('suppressed', 'pending', 'flagged', 'alert_only')
      RETURNING *`,
    [cls, isDraft ? draftText : null, row.id, isDraft ? 'pending' : 'alert_only']
  );
  const updated = updatedRows[0];
  if (!updated) {
    return { ok: false, posted: false, reason: 'not_promotable', status: row.status, replyId: row.id };
  }

  const threadContext = parseThread(updated.thread_context) || [
    { role: 'prospect', message: updated.inbound_message || '' },
  ];
  const lastOutbound = lastOutboundFromThread(updated.thread_context);
  const posted = await postFn({
    token: row.slack_bot_token,
    channelId: row.slack_channel_id,
    clientId: row.client_id,
    platform: 'heyreach',
    campaignId: updated.campaign_id,
    leadId: updated.lead_id,
    threadContext,
    isDraft,
    replyId: updated.id,
    card: {
      replyId: updated.id,
      leadName: updated.lead_name,
      leadEmail: updated.lead_email || null,
      linkedinUrl: updated.linkedin_url || undefined,
      platform: 'heyreach',
      classification: cls,
      draft: isDraft ? draftText : null,
      reasoning: cardReasoning,
      inboundMessage: updated.inbound_message,
      campaignDisplay: formatCampaignDisplay(updated.campaign_name, updated.campaign_id) || undefined,
      lastOutboundMessage: lastOutbound || undefined,
      repliedAt: updated.created_at,
    },
  });

  if (posted?.skipped) {
    return {
      ok: true,
      posted: false,
      reason: posted.reason || 'already_claimed',
      replyId: updated.id,
      slackMessageTs: posted.ts || null,
    };
  }

  return {
    ok: true,
    posted: true,
    replyId: updated.id,
    slackMessageTs: posted?.ts || null,
  };
}

module.exports = {
  postStoredHeyreachApprovalCard,
  DRAFT_CLASSIFICATIONS,
};
