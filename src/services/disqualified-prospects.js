/**
 * Manual DQ from Slack — exclude a prospect from follow-up nudges.
 */

const db = require('../db');

function heyreachConversationIdFromReply(reply) {
  let tc = reply?.thread_context;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  return tc?.heyreach?.conversationId || null;
}

function threadKeys(reply) {
  const platform = reply.platform;
  const campaignId = reply.campaign_id != null ? String(reply.campaign_id) : null;
  const leadId = reply.lead_id != null ? String(reply.lead_id) : null;
  let conversationId = null;
  if (platform === 'heyreach') {
    conversationId = heyreachConversationIdFromReply(reply);
  }
  return {
    platform,
    campaignId,
    leadId,
    conversationId: conversationId != null ? String(conversationId) : null,
    leadEmail: reply.lead_email ? String(reply.lead_email).trim().toLowerCase() : null,
    linkedinUrl: reply.linkedin_url || null,
    leadName: reply.lead_name || null,
  };
}

/**
 * True when this prospect was manually DQ'd for the client.
 */
async function isDisqualified(clientId, {
  platform,
  campaignId,
  leadId,
  conversationId,
  leadEmail,
  linkedinUrl,
} = {}) {
  if (!clientId) return false;
  const email = leadEmail ? String(leadEmail).trim().toLowerCase() : '';
  const camp = campaignId != null ? String(campaignId) : '';
  const lead = leadId != null ? String(leadId) : '';
  const conv = conversationId != null ? String(conversationId) : '';
  const li = linkedinUrl ? String(linkedinUrl).trim() : '';

  if (!email && !lead && !conv && !li) return false;

  const { rows } = await db.query(
    `SELECT id
       FROM disqualified_prospects
      WHERE client_id = $1
        AND (
          ($2::text <> '' AND lower(lead_email) = $2)
          OR (
            platform = $3
            AND $4::text <> ''
            AND COALESCE(lead_id, '') = $4
            AND (
              $3 = 'heyreach'
              OR COALESCE(campaign_id, '') = $5
            )
          )
          OR (
            platform = 'heyreach'
            AND $6::text <> ''
            AND COALESCE(conversation_id, '') = $6
          )
          OR (
            $7::text <> ''
            AND linkedin_url IS NOT NULL
            AND linkedin_url = $7
          )
        )
      LIMIT 1`,
    [clientId, email, platform || '', lead, camp, conv, li]
  );
  return rows.length > 0;
}

async function isReplyDisqualified(clientId, reply) {
  const keys = threadKeys(reply);
  return isDisqualified(clientId, keys);
}

/**
 * Record DQ, cancel pending follow-up cadence steps, mark the reply row.
 * @returns {{ cancelledFollowUps: number, already: boolean }}
 */
async function markDisqualified({
  clientId,
  reply,
  reason = 'slack_dq',
  slackUserId = null,
} = {}) {
  if (!clientId || !reply) return { cancelledFollowUps: 0, already: false };

  const keys = threadKeys(reply);
  const already = await isDisqualified(clientId, keys);

  if (!already) {
    await db.query(
      `INSERT INTO disqualified_prospects
        (client_id, platform, campaign_id, lead_id, conversation_id,
         lead_email, linkedin_url, lead_name, source_pending_reply_id,
         reason, created_by_slack_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        clientId,
        keys.platform,
        keys.campaignId,
        keys.leadId,
        keys.conversationId,
        keys.leadEmail,
        keys.linkedinUrl,
        keys.leadName,
        reply.id || null,
        reason,
        slackUserId,
      ]
    );
  }

  await db.query(
    `UPDATE pending_replies
        SET status = 'disqualified',
            draft_reply = NULL,
            updated_at = now()
      WHERE id = $1
        AND status IN ('pending', 'alert_only', 'flagged')`,
    [reply.id]
  );

  // Also drop any other open approval cards for the same thread.
  if (keys.leadId || keys.conversationId || keys.leadEmail) {
    await db.query(
      `UPDATE pending_replies
          SET status = 'disqualified',
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

  // Lazy require avoids a cycle with outbound-follow-up (which checks DQ on schedule).
  const { cancelPendingForThread } = require('./outbound-follow-up');
  const cancelledFollowUps = await cancelPendingForThread(clientId, {
    platform: keys.platform,
    campaignId: keys.campaignId,
    leadId: keys.leadId,
    conversationId: keys.conversationId,
  });

  // Also cancel by email when lead_id matching alone might miss older rows.
  if (keys.leadEmail) {
    const byEmail = await db.query(
      `UPDATE outbound_follow_ups
          SET status = 'skipped',
              skip_reason = 'disqualified',
              updated_at = now()
        WHERE client_id = $1
          AND status = 'pending'
          AND lower(lead_email) = $2`,
      [clientId, keys.leadEmail]
    );
    // cancelPendingForThread already cancelled thread matches as 'cancelled';
    // email-wide catch uses skipped + reason for audit.
    if ((byEmail.rowCount || 0) > 0) {
      console.log('[DQ] Skipped pending follow-ups by email', {
        clientId, email: keys.leadEmail, count: byEmail.rowCount,
      });
    }
  }

  console.log('[DQ] Prospect disqualified', {
    clientId,
    replyId: reply.id,
    lead: keys.leadName,
    email: keys.leadEmail,
    cancelledFollowUps,
    already,
  });

  return { cancelledFollowUps, already };
}

module.exports = {
  isDisqualified,
  isReplyDisqualified,
  markDisqualified,
  threadKeys,
};
