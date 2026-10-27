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

const force = require('./force-approval-card');

const DRAFT_CLASSIFICATIONS = new Set(['INTERESTED', 'MEETING_PROPOSED', 'QUESTION']);

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

/**
 * force: true. Insert a NEW pending row copied from the source reply and post
 * a card for it, even when the source already has a card or a send failed.
 * The source row is not touched. Refuses an unsubscribed or disqualified lead.
 */
async function postForcedCard({
  row, draftText, cls, reasoning, threadTs, channelOverride, query, postFn, isDisqualifiedFn,
}) {
  const blocked = await force.findForceBlock({
    clientId: row.client_id,
    platform: 'heyreach',
    campaignId: row.campaign_id,
    leadId: row.lead_id,
    leadEmail: row.lead_email,
    linkedinUrl: row.linkedin_url,
    threadContext: row.thread_context,
    status: row.status,
    classification: row.classification,
    suppressionReason: row.suppression_reason,
    query,
    ...(isDisqualifiedFn ? { isDisqualifiedFn } : {}),
  });
  if (blocked) force.throwBlocked(blocked);

  const threadContextRaw = row.thread_context == null
    ? [{ role: 'prospect', message: row.inbound_message || '' }]
    : parseThread(row.thread_context);
  const fresh = await force.insertHeyreachCopy(query, row, {
    threadContextJson: JSON.stringify(threadContextRaw),
    classification: cls,
    draft: draftText,
  });
  if (!fresh) throw force.httpError(500, 'could not create the forced card row');

  const threadContext = parseThread(fresh.thread_context) || threadContextRaw;
  const lastOutbound = lastOutboundFromThread(fresh.thread_context);
  let posted;
  try {
    posted = await postFn({
      token: row.slack_bot_token,
      channelId: channelOverride || row.slack_channel_id,
      clientId: row.client_id,
      platform: 'heyreach',
      campaignId: fresh.campaign_id,
      leadId: fresh.lead_id,
      threadContext,
      isDraft: true,
      replyId: fresh.id,
      postInThread: false,
      threadTs: threadTs || undefined,
      claimFn: force.makeForceClaim(query),
      card: {
        replyId: fresh.id,
        leadName: fresh.lead_name,
        leadEmail: fresh.lead_email || null,
        linkedinUrl: fresh.linkedin_url || undefined,
        platform: 'heyreach',
        classification: cls,
        draft: draftText,
        reasoning,
        inboundMessage: fresh.inbound_message,
        campaignDisplay: formatCampaignDisplay(fresh.campaign_name, fresh.campaign_id) || undefined,
        lastOutboundMessage: lastOutbound || undefined,
        repliedAt: row.created_at,
      },
    });
  } catch (err) {
    await force.parkForcedRow(query, fresh.id);
    throw err;
  }
  if (posted?.skipped || !posted?.ts) {
    await force.parkForcedRow(query, fresh.id);
    return {
      ok: false,
      posted: false,
      forced: true,
      reason: posted?.reason || 'not_posted',
      replyId: fresh.id,
      sourceReplyId: row.id,
    };
  }
  console.log('[ForceCard] heyreach card posted', { sourceReplyId: row.id, replyId: fresh.id });
  return {
    ok: true,
    posted: true,
    forced: true,
    replyId: fresh.id,
    sourceReplyId: row.id,
    slackMessageTs: posted.ts,
    threadTs: threadTs || null,
    channelId: channelOverride || row.slack_channel_id,
  };
}

async function postStoredHeyreachApprovalCard({
  replyId,
  draft,
  classification = 'INTERESTED',
  reasoning = 'Manually promoted to an approval card from the stored LinkedIn reply.',
  force: forceRaw = false,
  threadTs: threadTsRaw = null,
  channelId: channelIdRaw = null,
  route = null,
  query = (...args) => db.query(...args),
  postFn = postProspectSlackCard,
  isDisqualifiedFn,
} = {}) {
  const forced = force.parseForce(forceRaw);
  const threadTs = force.parseThreadTs(threadTsRaw);
  const channelOverride = force.resolveChannelOverride({ channelId: channelIdRaw, route });
  const id = String(replyId || '').trim();
  if (!id) throw httpError(400, 'replyId is required');
  const draftText = String(draft || '').trim();
  if (!draftText) throw httpError(400, 'draft is required');
  const cls = String(classification || 'INTERESTED').trim().toUpperCase();
  if (!DRAFT_CLASSIFICATIONS.has(cls)) {
    throw httpError(400, 'classification must be INTERESTED, MEETING_PROPOSED, or QUESTION');
  }

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
  if (!row.slack_bot_token || !(channelOverride || row.slack_channel_id)) {
    throw httpError(409, 'client has no Slack channel');
  }

  if (row.status === 'sent') {
    return { ok: true, posted: false, reason: 'already_sent', replyId: row.id };
  }
  if (forced) {
    return postForcedCard({
      row, draftText, cls, reasoning, threadTs, channelOverride, query, postFn, isDisqualifiedFn,
    });
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
            status = 'pending',
            updated_at = now()
      WHERE id = $3
        AND status IN ('suppressed', 'pending', 'flagged', 'alert_only')
      RETURNING *`,
    [cls, draftText, row.id]
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
    channelId: channelOverride || row.slack_channel_id,
    clientId: row.client_id,
    platform: 'heyreach',
    campaignId: updated.campaign_id,
    leadId: updated.lead_id,
    threadContext,
    isDraft: true,
    replyId: updated.id,
    threadTs: threadTs || undefined,
    card: {
      replyId: updated.id,
      leadName: updated.lead_name,
      leadEmail: updated.lead_email || null,
      linkedinUrl: updated.linkedin_url || undefined,
      platform: 'heyreach',
      classification: cls,
      draft: draftText,
      reasoning,
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
    channelId: channelOverride || row.slack_channel_id,
  };
}

module.exports = {
  postStoredHeyreachApprovalCard,
  DRAFT_CLASSIFICATIONS,
};
