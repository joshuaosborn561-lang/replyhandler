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
  leadId,
  leadName,
  leadEmail,
  linkedinUrl,
  inboundMessage,
  classification,
  reason,
  emailStatsId,
}) {
  try {
    await db.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, lead_id, lead_name, lead_email, linkedin_url,
         inbound_message, classification, status, suppression_reason, smartlead_email_stats_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'suppressed', $10, $11)`,
      [
        clientId,
        platform,
        campaignId != null ? String(campaignId) : null,
        leadId != null ? String(leadId) : null,
        leadName || null,
        leadEmail || null,
        linkedinUrl || null,
        inboundMessage || '',
        classification || null,
        reason,
        emailStatsId || null,
      ]
    );
    console.log('[Suppressed] Recorded', { client: clientId, platform, lead: leadName, leadEmail, reason });
  } catch (err) {
    console.error('[Suppressed] Could not record suppressed reply', { reason, err: err.message });
  }
}

module.exports = { recordSuppressedReply };
