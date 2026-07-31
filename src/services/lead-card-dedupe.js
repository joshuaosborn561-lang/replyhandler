const db = require('../db');

/**
 * One prospect, one card.
 *
 * Text comparison kept losing to rendering differences between the webhook and
 * the poller — first whole-body, then a 120-char prefix. This check ignores the
 * text entirely: if a card for this lead already reached Slack inside the
 * window, do not post another. It is the backstop that cannot be defeated by
 * how a reply happens to be rendered.
 *
 * Deliberately kept free of other service imports: slack-reply-post calls this,
 * and reply-dedupe calls slack-reply-post, so living here avoids a require cycle.
 *
 * Scoped to the lead, so no other prospect is affected, and bounded in time, so
 * a genuinely new reply hours later still gets its own card.
 */

function leadWindowMinutes() {
  const n = parseInt(process.env.LEAD_CARD_WINDOW_MINUTES || '90', 10);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

async function leadCardPostedRecently({ clientId, platform, leadId, conversationId }) {
  const lead = leadId != null ? String(leadId).trim() : '';
  const conv = conversationId != null ? String(conversationId).trim() : '';
  const key = lead || conv;
  if (!key) return false;

  const { rows } = await db.query(
    `SELECT id, lead_name, created_at
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND slack_message_ts IS NOT NULL
        AND COALESCE(lead_id, '') = $3
        AND created_at > now() - ($4::int * interval '1 minute')
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientId, platform, key, leadWindowMinutes()]
  );
  if (!rows.length) return false;

  console.log('[LeadDedupe] Card already posted for this lead — skipping', {
    platform, leadId: key, lead: rows[0].lead_name, postedAt: rows[0].created_at,
  });
  return true;
}

module.exports = { leadCardPostedRecently, leadWindowMinutes };
