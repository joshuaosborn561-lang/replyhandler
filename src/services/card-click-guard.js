const db = require('../db');

/**
 * A button on an old reply card can outlive the reply: the booking bridge, a
 * sibling card, or a teammate may already have closed it. The handlers used to
 * return without a word, so the click looked dead. This tells the clicker, in a
 * private (ephemeral) message, that the reply is already handled and why.
 */

// Which reply statuses each button can still act on.
const OPEN_FOR_EDIT_OR_SEND = ['pending', 'flagged', 'failed'];
const OPEN_FOR_ACTION = {
  approve_reply: OPEN_FOR_EDIT_OR_SEND,
  approve_reply_cc_client: OPEN_FOR_EDIT_OR_SEND,
  approve_reply_cc_referral: OPEN_FOR_EDIT_OR_SEND,
  open_edit_modal: ['pending', 'flagged'],
  retry_send: ['failed'],
  reject_reply: ['pending', 'flagged'],
  dq_prospect: ['pending', 'alert_only', 'flagged'],
  meeting_booked: ['pending', 'alert_only', 'flagged'],
};

const STATUS_WORDS = {
  meeting_booked: 'meeting booked',
  sent: 'already sent',
  approved: 'sending now',
  sending: 'sending now',
  disqualified: 'disqualified',
  rejected: 'rejected',
  skipped: 'skipped',
  suppressed: 'suppressed',
  alert_only: 'alert only',
  superseded: 'superseded by a newer card',
  failed: 'send failed',
};

function statusWord(status) {
  return STATUS_WORDS[status] || String(status || 'closed').replace(/_/g, ' ');
}

function noticeText(status) {
  if (!status) return 'This reply is no longer open, so nothing was done.';
  return `Already handled (${statusWord(status)}). Nothing was done, no action needed.`;
}

/** Is this one of the reply-card buttons the guard covers? */
function isGuardedAction(actionId) {
  return Object.prototype.hasOwnProperty.call(OPEN_FOR_ACTION, actionId);
}

/**
 * @returns {Promise<{ open: boolean, status: string|null }>}
 */
async function checkReplyOpen(actionId, replyId, { query } = {}) {
  const run = query || ((sql, params) => db.query(sql, params));
  const allowed = OPEN_FOR_ACTION[actionId];
  if (!allowed || !replyId) return { open: true, status: null };
  const { rows: [row] } = await run('SELECT status FROM pending_replies WHERE id = $1', [replyId]);
  if (!row) return { open: false, status: null };
  return { open: allowed.includes(row.status), status: row.status };
}

/** Private notice via the interaction's response_url. Never throws. */
async function sendEphemeralNotice(interaction, text, { fetchImpl = fetch } = {}) {
  try {
    const url = interaction?.response_url;
    if (!url) return false;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    });
    return Boolean(res && res.ok);
  } catch (err) {
    console.warn('[Slack] Ephemeral notice failed', { err: err.message });
    return false;
  }
}

/**
 * Returns true when the button is on a reply that is no longer open (the clicker
 * has been told). Fails open: any lookup error lets the normal handler run.
 */
async function noticeIfClosed(action, interaction, deps = {}) {
  try {
    const actionId = action?.action_id;
    if (!isGuardedAction(actionId)) return false;
    const { open, status } = await checkReplyOpen(actionId, action.value, deps);
    if (open) return false;
    console.log('[Slack] Click on a closed reply', { actionId, replyId: action.value, status });
    await sendEphemeralNotice(interaction, noticeText(status), deps);
    return true;
  } catch (err) {
    console.warn('[Slack] Closed-reply check failed', { err: err.message });
    return false;
  }
}

module.exports = {
  isGuardedAction,
  checkReplyOpen,
  noticeText,
  sendEphemeralNotice,
  noticeIfClosed,
  OPEN_FOR_ACTION,
};
