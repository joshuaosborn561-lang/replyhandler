const db = require('../db');

/**
 * Slack "Meeting booked" — stop the follow-up cadence and record a booked
 * meeting so the runner won't nudge this prospect again.
 *
 * Unlike DQ, this does NOT exclude them as out-of-ICP; it only means the
 * meeting already happened / is set.
 */

function threadKeys(reply) {
  let conversationId = null;
  if (reply.platform === 'heyreach' && reply.thread_context) {
    try {
      const tc = typeof reply.thread_context === 'string'
        ? JSON.parse(reply.thread_context)
        : reply.thread_context;
      conversationId = tc?.heyreach?.conversationId || null;
    } catch { /* ignore */ }
  }
  return {
    platform: reply.platform,
    campaignId: reply.campaign_id != null ? String(reply.campaign_id) : null,
    leadId: reply.lead_id != null ? String(reply.lead_id) : null,
    conversationId: conversationId != null ? String(conversationId) : null,
    leadEmail: reply.lead_email ? String(reply.lead_email).trim().toLowerCase() : null,
    leadName: reply.lead_name || null,
    linkedinUrl: reply.linkedin_url || null,
  };
}

/**
 * @returns {{ cancelledFollowUps: number }}
 */
async function markMeetingBooked({
  clientId,
  reply,
  slackUserId = null,
} = {}) {
  if (!clientId || !reply) return { cancelledFollowUps: 0 };

  const keys = threadKeys(reply);

  // Record booked so booking-check / looksAlreadyBooked suppresses future nudges.
  const { rows: [existing] } = await db.query(
    `SELECT id FROM meetings
      WHERE client_id = $1
        AND pending_reply_id = $2
      LIMIT 1`,
    [clientId, reply.id]
  );

  if (existing) {
    await db.query(
      `UPDATE meetings
          SET status = 'booked',
              confirmed_time = COALESCE(confirmed_time, now()),
              updated_at = now()
        WHERE id = $1`,
      [existing.id]
    );
  } else {
    await db.query(
      `INSERT INTO meetings
        (client_id, pending_reply_id, lead_name, lead_email, linkedin_url,
         status, confirmed_time)
       VALUES ($1, $2, $3, $4, $5, 'booked', now())`,
      [
        clientId,
        reply.id,
        keys.leadName,
        reply.lead_email || null,
        keys.linkedinUrl,
      ]
    );
  }

  await db.query(
    `UPDATE pending_replies
        SET status = 'meeting_booked',
            draft_reply = NULL,
            updated_at = now()
      WHERE id = $1
        AND status IN ('pending', 'alert_only', 'flagged')`,
    [reply.id]
  );

  // Close sibling open cards for the same lead so we don't keep approving dead nudges.
  if (keys.leadId || keys.leadEmail) {
    await db.query(
      `UPDATE pending_replies
          SET status = 'meeting_booked',
              draft_reply = NULL,
              updated_at = now()
        WHERE client_id = $1
          AND platform = $2
          AND status IN ('pending', 'alert_only', 'flagged')
          AND id IS DISTINCT FROM $3
          AND (
            ($4::text <> '' AND COALESCE(lead_id, '') = $4)
            OR ($5::text <> '' AND lower(lead_email) = $5)
          )`,
      [
        clientId,
        keys.platform,
        reply.id,
        keys.leadId || '',
        keys.leadEmail || '',
      ]
    );
  }

  const { cancelPendingForThread } = require('./outbound-follow-up');
  let cancelledFollowUps = await cancelPendingForThread(clientId, {
    platform: keys.platform,
    campaignId: keys.campaignId,
    leadId: keys.leadId,
    conversationId: keys.conversationId,
  });

  if (keys.leadEmail) {
    const byEmail = await db.query(
      `UPDATE outbound_follow_ups
          SET status = 'skipped',
              skip_reason = 'meeting_booked_slack',
              updated_at = now()
        WHERE client_id = $1
          AND status = 'pending'
          AND lower(lead_email) = $2`,
      [clientId, keys.leadEmail]
    );
    cancelledFollowUps += byEmail.rowCount || 0;
  }

  console.log('[MeetingBooked] Marked booked + cancelled follow-ups', {
    clientId,
    replyId: reply.id,
    lead: keys.leadName,
    email: keys.leadEmail,
    cancelledFollowUps,
    slackUserId,
  });

  return { cancelledFollowUps };
}

module.exports = { markMeetingBooked, threadKeys };
