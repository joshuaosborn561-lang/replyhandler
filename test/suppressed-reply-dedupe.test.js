/**
 * Guard: a suppressed reply must count as already-handled.
 *
 * alreadyPostedToSlack originally required `slack_message_ts IS NOT NULL`.
 * Suppressed replies never post to Slack, so they never have one — meaning
 * they could never match the dedupe check, and every poll cycle re-classified
 * and re-inserted the same reply, forever.
 *
 * Measured 2026-08-19: 88,769 suppressed rows over three days representing
 * 193 distinct replies (~460x amplification); worst offenders held 863 copies
 * of one reply and were still growing. Each copy burned a classifier call,
 * because classification runs before the suppression check.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function alreadyPostedQuery() {
  const src = read('src/services/reply-dedupe.js');
  const start = src.indexOf('async function alreadyPostedToSlack');
  assert.ok(start > -1, 'alreadyPostedToSlack must exist');
  const end = src.indexOf('async function findUnpostedReply');
  return src.slice(start, end);
}

test('suppressed replies satisfy the already-handled check', () => {
  const q = alreadyPostedQuery();

  assert.match(
    q,
    /status = 'suppressed'/,
    'a suppressed reply is terminal — it must match dedupe, or the poller '
    + 'reprocesses it on every cycle forever'
  );
  assert.match(
    q,
    /slack_message_ts IS NOT NULL\s*[\r\n]/,
    'genuinely posted cards must still match'
  );
  // The two conditions have to be alternatives, not both required.
  assert.ok(
    /slack_message_ts IS NOT NULL[\s\S]{0,600}?OR status = 'suppressed'/.test(q),
    "the suppressed check must be OR'd with slack_message_ts, not AND'd"
  );
});

test('recovery paths still ignore suppressed rows', () => {
  const src = read('src/services/reply-dedupe.js');

  // findUnpostedReply and recoverUnpostedSlackCards resurrect rows that were
  // saved but never posted. Suppressed rows were never meant to post, so they
  // must stay out of both — otherwise this fix would turn silent replies loud.
  const unposted = src.slice(
    src.indexOf('async function findUnpostedReply'),
    src.indexOf('function formatCampaignDisplayFromReply')
  );
  assert.match(
    unposted,
    /status IN \('pending', 'alert_only'\)/,
    'findUnpostedReply must only resurrect pending/alert_only, never suppressed'
  );

  const recover = src.slice(src.indexOf('async function recoverUnpostedSlackCards'));
  assert.match(
    recover,
    /status IN \('pending', 'alert_only'\)/,
    'recovery must only resurrect pending/alert_only, never suppressed'
  );
});

test('poller recovery never resurrects FOLLOW_UP cadence rows', () => {
  const src = read('src/services/reply-dedupe.js');

  // FOLLOW_UP pending_replies reuse the original prospect inbound text and
  // post to #followups-ai-replies. If findUnpostedReply / repostReplyRowToSlack
  // treat them as inbox recoveries, the same reply reappears in the client
  // channel (Zach Walls, 2026-09-04 — "I'm not opposed" twice).
  const unposted = src.slice(
    src.indexOf('async function findUnpostedReply'),
    src.indexOf('function formatCampaignDisplayFromReply')
  );
  assert.match(
    unposted,
    /COALESCE\(classification, ''\) <> 'FOLLOW_UP'/,
    'findUnpostedReply must exclude FOLLOW_UP cadence rows'
  );

  const repost = src.slice(
    src.indexOf('async function repostReplyRowToSlack'),
    src.indexOf('async function recoverUnpostedSlackCards')
  );
  assert.match(
    repost,
    /FOLLOW_UP/,
    'repostReplyRowToSlack must refuse FOLLOW_UP rows as a second guard'
  );

  const recover = src.slice(src.indexOf('async function recoverUnpostedSlackCards'));
  assert.match(
    recover,
    /classification IN \('INTERESTED', 'MEETING_PROPOSED', 'QUESTION'\)/,
    'recoverUnpostedSlackCards must stay on bookable positives only'
  );
});
