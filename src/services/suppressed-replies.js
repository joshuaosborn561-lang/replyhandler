const db = require('../db');

/**
 * Record a reply we chose not to surface.
 *
 * Suppression used to happen before any INSERT, so a silenced reply left only a
 * counter in the poll log — no lead, no body, no way to answer "why did we never
 * see that reply?". These rows never reach Slack (no slack_message_ts, status
 * outside the recovery set) but they are visible in the diagnostics endpoint.
 *
 * Never throws: failing to record an audit row must not change what the caller
 * does with the reply.
 */
async function recordSuppressedReply({
  clientId,
  platform,
  campaignId,
  campaignName,
  leadId,
  leadName,
  leadEmail,
  linkedinUrl,
  inboundMessage,
  threadContext,
  classification,
  reason,
  emailStatsId,
  leadPhone,
}) {
  try {
    // Keep HeyReach conversationId / linkedInAccountId on the row. A later
    // manual INTERESTED card approves against this same reply, and the send
    // path cannot invent those ids if they were discarded here.
    const storedContext = threadContext == null
      ? null
      : (typeof threadContext === 'string' ? threadContext : JSON.stringify(threadContext));
    await db.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email, linkedin_url,
         inbound_message, thread_context, classification, status, suppression_reason, smartlead_email_stats_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, 'suppressed', $12, $13)`,
      [
        clientId,
        platform,
        campaignId != null ? String(campaignId) : null,
        campaignName || null,
        leadId != null ? String(leadId) : null,
        leadName || null,
        leadEmail || null,
        linkedinUrl || null,
        inboundMessage || '',
        storedContext,
        classification || null,
        reason,
        emailStatsId || null,
      ]
    );
    console.log('[Suppressed] Recorded', { client: clientId, platform, reason });
    if (shouldAlertOther(reason, classification)) {
      await postOtherAlert({ clientId, platform, leadName, inboundMessage, leadPhone });
    }
  } catch (err) {
    console.error('[Suppressed] Could not record suppressed reply', { reason, err: err.message });
  }
}

const { shouldAlertOther, postOtherAlert } = require('./other-alert');

module.exports = { recordSuppressedReply };
