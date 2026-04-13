const db = require('../db');
const { isSlackTestFixtureReply } = require('./reply-send');

function followUpHours() {
  const h = parseInt(process.env.FOLLOW_UP_REMINDER_HOURS || '24', 10);
  return Number.isFinite(h) && h > 0 ? h : 24;
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

/**
 * After we successfully send a prospect-facing message (Slack approve/edit).
 */
async function scheduleAfterOutboundSend(clientId, reply) {
  if (!reply || isSlackTestFixtureReply(reply)) return;

  const platform = reply.platform;
  if (platform !== 'smartlead' && platform !== 'heyreach') return;

  const campaignId = reply.campaign_id != null ? String(reply.campaign_id) : null;
  const leadId = reply.lead_id != null ? String(reply.lead_id) : null;
  const conversationId = platform === 'heyreach' ? heyreachConversationId(reply) : null;

  if (platform === 'smartlead' && (!campaignId || !leadId)) {
    console.warn('[FollowUp] Skip schedule — SmartLead missing campaign_id or lead_id', { replyId: reply.id });
    return;
  }
  if (platform === 'heyreach' && !leadId && !conversationId) {
    console.warn('[FollowUp] Skip schedule — HeyReach missing lead/conversation id', { replyId: reply.id });
    return;
  }

  const hours = followUpHours();
  const due = new Date(Date.now() + hours * 3600 * 1000);

  await db.query(
    `UPDATE outbound_follow_ups SET status = 'cancelled', updated_at = now()
     WHERE client_id = $1 AND platform = $2 AND status = 'pending'
       AND COALESCE(campaign_id, '') = COALESCE($3, '')
       AND COALESCE(lead_id, '') = COALESCE($4, '')
       AND COALESCE(conversation_id, '') = COALESCE($5, '')`,
    [clientId, platform, campaignId, leadId, conversationId]
  );

  await db.query(
    `INSERT INTO outbound_follow_ups
      (client_id, platform, campaign_id, lead_id, conversation_id, lead_name, lead_email, linkedin_url, source_pending_reply_id, due_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
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
      due,
    ]
  );

  console.log('[FollowUp] Scheduled', {
    clientId,
    platform,
    campaignId,
    leadId,
    conversationId,
    dueAt: due.toISOString(),
    hours,
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
  followUpHours,
  heyreachConversationId,
};
