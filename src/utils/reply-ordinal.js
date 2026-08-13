const db = require('../db');

/**
 * How many times have we already sent a prospect-facing reply on this thread?
 *
 * Used to switch draft mode:
 *   0 → FIRST_TOUCH (first inbound reply we're answering)
 *   1+ → CONTINUATION (second+ inbound; do not reset to first-touch voice)
 *
 * FOLLOW_UP cadence sends count — they are real outbound touches.
 */

function isFollowUpPlaceholder(text) {
  const s = String(text || '').trim().toLowerCase();
  return !s
    || s.startsWith('(no new reply')
    || s.includes('follow-up re-attempt');
}

/**
 * @returns {Promise<{ priorSentCount: number, replyOrdinal: number, mode: 'FIRST_TOUCH'|'CONTINUATION' }>}
 */
async function resolveReplyOrdinal({
  clientId,
  platform,
  leadId,
  leadEmail,
} = {}) {
  if (!clientId || !platform) {
    return { priorSentCount: 0, replyOrdinal: 1, mode: 'FIRST_TOUCH' };
  }

  const lead = leadId != null ? String(leadId) : '';
  const email = leadEmail ? String(leadEmail).trim().toLowerCase() : '';
  if (!lead && !email) {
    return { priorSentCount: 0, replyOrdinal: 1, mode: 'FIRST_TOUCH' };
  }

  const { rows } = await db.query(
    `SELECT count(*)::int AS n
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND status = 'sent'
        AND sent_reply IS NOT NULL
        AND trim(sent_reply) <> ''
        AND (
          ($3::text <> '' AND COALESCE(lead_id, '') = $3)
          OR ($4::text <> '' AND lower(COALESCE(lead_email, '')) = $4)
        )`,
    [clientId, platform, lead, email]
  );

  const priorSentCount = rows[0]?.n || 0;
  const replyOrdinal = priorSentCount + 1;
  const mode = priorSentCount > 0 ? 'CONTINUATION' : 'FIRST_TOUCH';
  return { priorSentCount, replyOrdinal, mode };
}

module.exports = {
  resolveReplyOrdinal,
  isFollowUpPlaceholder,
};
