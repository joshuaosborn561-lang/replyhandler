const db = require('../db');
const slackService = require('./slack');
const { withSmartleadKey } = require('./campaign-routing');

/**
 * When something other than a Slack button closes a reply (the booking bridge,
 * or a sibling card closed by Meeting booked / DQ on another card), the Slack
 * card used to keep its Approve / Edit / Reject buttons even though the row was
 * no longer pending. Clicking them silently did nothing.
 *
 * retireSlackCards flips each closed row's card to the matching confirmation
 * card (buttons gone). Best effort: it never throws, and a card that was never
 * posted (or is still being claimed) is skipped.
 */

const POSTED_TS = /^\d+\.\d+$/;

const FOOTERS = {
  meeting_booked: 'Meeting booked, no action needed.',
  meeting_booked_auto: 'Meeting booked, no action needed.',
  disqualified: 'Closed because this lead was disqualified, no action needed.',
};

/**
 * @param {Array<object>} rows  pending_replies rows that were just closed
 * @param {{ actionKind: 'meeting_booked'|'disqualified', footer?: string }} opts
 * @returns {Promise<{ retired: number, skipped: number, failed: number }>}
 */
async function retireSlackCards(rows, { actionKind = 'meeting_booked', footer, deps = {} } = {}) {
  const out = { retired: 0, skipped: 0, failed: 0 };
  const update = deps.updateCard || slackService.updateSentConfirmationCard;
  // Lazy: routes/slack requires the services that call this one.
  const helpers = deps.cardHelpers || require('../routes/slack').cardHelpers;
  const query = deps.query || ((sql, params) => db.query(sql, params));

  for (const reply of Array.isArray(rows) ? rows : []) {
    try {
      const ts = String(reply?.slack_message_ts || '');
      // FOLLOW_UP cards live in their own channel and are retired by the follow-up sequence.
      if (!POSTED_TS.test(ts) || String(reply.classification || '').toUpperCase() === 'FOLLOW_UP') {
        out.skipped += 1;
        continue;
      }
      const { rows: [rawClient] } = await query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
      if (!rawClient?.slack_bot_token || !rawClient?.slack_channel_id) {
        out.skipped += 1;
        continue;
      }
      const client = withSmartleadKey(rawClient);
      const ctx = deps.cardContext
        ? await deps.cardContext(reply, client)
        : await helpers.slackCardContextFromReply(reply, client);
      await update(
        client.slack_bot_token,
        client.slack_channel_id,
        ts,
        helpers.sentCardPayload(reply, ctx, {
          sentReply: null,
          actionKind,
          userId: null,
          extraFooter: footer || FOOTERS[actionKind],
        })
      );
      out.retired += 1;
    } catch (err) {
      out.failed += 1;
      console.warn('[RetireCards] Could not update Slack card', { replyId: reply?.id, err: err.message });
    }
  }
  if (out.retired || out.failed) console.log('[RetireCards] Done', { actionKind, ...out });
  return out;
}

module.exports = { retireSlackCards };
