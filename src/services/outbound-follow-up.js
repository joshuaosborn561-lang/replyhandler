const db = require('../db');
const { isSlackTestFixtureReply } = require('./reply-send');
const { outboundProposesMeeting } = require('../utils/outbound-meeting-propose');

/** Default: 2h → 24h → 48h → 1 week after we propose a meeting. */
const DEFAULT_CADENCE = [2, 24, 48, 168];

/**
 * Parse FOLLOW_UP_HOURS as a comma-separated cadence (hours).
 * Single number still works (one-step). Env override replaces the whole sequence.
 */
function followUpCadenceHours() {
  const raw = process.env.FOLLOW_UP_HOURS || process.env.FOLLOW_UP_REMINDER_HOURS || '';
  if (!String(raw).trim()) return [...DEFAULT_CADENCE];

  const parts = String(raw)
    .split(/[,\s]+/)
    .map((p) => parseFloat(p))
    .filter((n) => Number.isFinite(n) && n > 0);

  return parts.length ? parts : [...DEFAULT_CADENCE];
}

/** First step only — kept for older callers/tests. */
function followUpHours() {
  return followUpCadenceHours()[0];
}

function parseThreadContext(reply) {
  if (!reply?.thread_context) return {};
  try {
    return typeof reply.thread_context === 'string'
      ? JSON.parse(reply.thread_context)
      : reply.thread_context;
  } catch {
    return {};
  }
}

function heyreachConversationId(reply) {
  const ctx = parseThreadContext(reply);
  return ctx?.heyreach?.conversationId || null;
}

function threadMatchParams(reply) {
  const platform = reply.platform;
  const campaignId = reply.campaign_id != null ? String(reply.campaign_id) : null;
  const leadId = reply.lead_id != null ? String(reply.lead_id) : null;
  const conversationId = platform === 'heyreach' ? heyreachConversationId(reply) : null;
  return { platform, campaignId, leadId, conversationId };
}

/** Cancel every pending step for this prospect thread. */
async function cancelPendingForThread(clientId, { platform, campaignId, leadId, conversationId }) {
  const result = await db.query(
    `UPDATE outbound_follow_ups SET status = 'cancelled', updated_at = now()
     WHERE client_id = $1 AND platform = $2 AND status = 'pending'
       AND COALESCE(campaign_id, '') = COALESCE($3, '')
       AND COALESCE(lead_id, '') = COALESCE($4, '')
       AND COALESCE(conversation_id, '') = COALESCE($5, '')`,
    [
      clientId,
      platform,
      campaignId != null ? String(campaignId) : null,
      leadId != null ? String(leadId) : null,
      conversationId != null ? String(conversationId) : null,
    ]
  );
  return result.rowCount || 0;
}

/**
 * After we successfully send a prospect-facing message (Slack approve/edit).
 *
 * Only starts a cadence when the outbound proposes a meeting (times / Calendly /
 * "book for you"). FOLLOW_UP sends do not restart the clock — later steps from
 * the original propose keep their due times.
 */
async function scheduleAfterOutboundSend(clientId, reply) {
  if (!reply || isSlackTestFixtureReply(reply)) return;

  const platform = reply.platform;
  if (platform !== 'smartlead' && platform !== 'heyreach') return;

  // Follow-up cards are steps in an existing sequence — do not reschedule.
  if (String(reply.classification || '').toUpperCase() === 'FOLLOW_UP') {
    console.log('[FollowUp] Skip schedule — FOLLOW_UP send keeps existing cadence', {
      replyId: reply.id,
    });
    return;
  }

  const sentText = reply.sent_reply || reply.draft_reply || '';
  if (!outboundProposesMeeting(sentText)) {
    console.log('[FollowUp] Skip schedule — outbound did not propose a meeting', {
      replyId: reply.id,
      lead: reply.lead_name,
    });
    return;
  }

  const { campaignId, leadId, conversationId } = threadMatchParams(reply);

  if (platform === 'smartlead' && (!campaignId || !leadId)) {
    console.warn('[FollowUp] Skip schedule — SmartLead missing campaign_id or lead_id', { replyId: reply.id });
    return;
  }
  if (platform === 'heyreach' && !leadId && !conversationId) {
    console.warn('[FollowUp] Skip schedule — HeyReach missing lead/conversation id', { replyId: reply.id });
    return;
  }

  const cadence = followUpCadenceHours();
  const sentAt = new Date();

  await cancelPendingForThread(clientId, { platform, campaignId, leadId, conversationId });

  for (let i = 0; i < cadence.length; i++) {
    const hours = cadence[i];
    const due = new Date(sentAt.getTime() + Math.round(hours * 3600 * 1000));
    await db.query(
      `INSERT INTO outbound_follow_ups
        (client_id, platform, campaign_id, lead_id, conversation_id, lead_name, lead_email, linkedin_url,
         source_pending_reply_id, sent_at, due_at, status, step, sequence_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13)`,
      [
        clientId,
        platform,
        campaignId,
        leadId,
        conversationId,
        reply.lead_name || null,
        reply.lead_email || null,
        reply.linkedin_url || null,
        reply.id,
        sentAt,
        due,
        i + 1,
        hours,
      ]
    );
  }

  console.log('[FollowUp] Scheduled cadence', {
    clientId,
    platform,
    campaignId,
    leadId,
    conversationId,
    steps: cadence,
    sentAt: sentAt.toISOString(),
  });
}

/**
 * Prospect replied — cancel pending follow-up for this thread.
 */
async function cancelForInboundReply({ clientId, platform, campaignId, leadId, conversationId }) {
  const camp = campaignId != null ? String(campaignId) : '';
  const lead = leadId != null ? String(leadId) : '';
  const conv = conversationId != null ? String(conversationId) : '';

  let result;
  if (platform === 'smartlead') {
    result = await db.query(
      `UPDATE outbound_follow_ups SET status = 'cancelled', updated_at = now()
       WHERE client_id = $1 AND platform = 'smartlead' AND status = 'pending'
         AND COALESCE(campaign_id, '') = $2 AND COALESCE(lead_id, '') = $3`,
      [clientId, camp, lead]
    );
  } else {
    result = await db.query(
      `UPDATE outbound_follow_ups SET status = 'cancelled', updated_at = now()
       WHERE client_id = $1 AND platform = 'heyreach' AND status = 'pending'
         AND (
           ($2::text <> '' AND COALESCE(conversation_id, '') = $2)
           OR ($3::text <> '' AND COALESCE(lead_id, '') = $3)
         )`,
      [clientId, conv, lead]
    );
  }

  const rowCount = result.rowCount || 0;
  if (rowCount > 0) {
    console.log('[FollowUp] Cancelled pending reminder(s) on inbound reply', {
      clientId,
      platform,
      rowCount,
    });
  }
}

module.exports = {
  scheduleAfterOutboundSend,
  cancelForInboundReply,
  cancelPendingForThread,
  followUpHours,
  followUpCadenceHours,
  heyreachConversationId,
  DEFAULT_CADENCE,
};
