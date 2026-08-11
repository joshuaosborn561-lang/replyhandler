/**
 * Guard: the poller must not trust master-inbox's email_history blindly.
 *
 * SmartLead's master-inbox can return a row whose `last_reply_time` is current
 * while the `email_history` it ships is behind. The newest reply is then
 * invisible to the poller, and since the older reply it *can* see was already
 * carded, dedupe correctly calls it a duplicate and skips — so a real reply
 * never reaches Slack and the webhook becomes the only path.
 *
 * Observed 2026-08-11 on Chase Dawson (SalesGlider, campaign 3739758): the
 * fixture below is that row's real shape.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  newestReplyTimeFromHistory,
  historyLagsLastReply,
} = require('../src/services/smartlead-poller');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('a self-contradicting master-inbox row is detected as stale', () => {
  // Real shape: row says the last reply was 16:09, history stops at 15:53.
  const row = { last_reply_time: '2026-08-11T16:09:39.000Z' };
  const hist = {
    history: [
      { type: 'SENT', time: '2026-08-11T15:47:48.070Z', email_body: 'Hey Chase,' },
      { type: 'REPLY', time: '2026-08-11T15:53:25.000Z', email_body: 'Sure. I won’t share any payment details' },
    ],
  };

  assert.strictEqual(
    newestReplyTimeFromHistory(hist).toISOString(),
    '2026-08-11T15:53:25.000Z'
  );
  assert.ok(
    historyLagsLastReply(row, hist),
    'a row whose last_reply_time outruns its own history must trigger a refetch'
  );
});

test('a consistent row is never refetched', () => {
  const row = { last_reply_time: '2026-08-11T15:53:25.000Z' };
  const hist = {
    history: [
      { type: 'SENT', time: '2026-08-11T15:47:48.070Z', email_body: 'Hey Chase,' },
      { type: 'REPLY', time: '2026-08-11T15:53:25.000Z', email_body: 'Sure.' },
    ],
  };
  assert.ok(!historyLagsLastReply(row, hist), 'no contradiction means no extra API call');
});

test('small clock skew stays within tolerance', () => {
  // 30s of drift between the two fields is not evidence of stale history.
  const row = { last_reply_time: '2026-08-11T15:53:55.000Z' };
  const hist = {
    history: [{ type: 'REPLY', time: '2026-08-11T15:53:25.000Z', email_body: 'Sure.' }],
  };
  assert.ok(!historyLagsLastReply(row, hist), '30s skew must not trigger a refetch');
});

test('a row claiming a reply but shipping none is stale', () => {
  const row = { last_reply_time: '2026-08-11T16:09:39.000Z' };
  const hist = { history: [{ type: 'SENT', time: '2026-08-11T15:47:48.070Z', email_body: 'Hey Chase,' }] };
  assert.ok(historyLagsLastReply(row, hist), 'a reply we cannot see at all is worth fetching');
});

test('no last_reply_time means no judgement, no refetch', () => {
  const hist = { history: [{ type: 'REPLY', time: '2026-08-11T15:53:25.000Z', email_body: 'Sure.' }] };
  assert.ok(!historyLagsLastReply({}, hist), 'without a timestamp there is nothing to contradict');
  assert.ok(!historyLagsLastReply({ last_reply_time: 'not-a-date' }, hist));
});

// The detection is only useful if the poller actually acts on it.
test('the poller falls back to per-thread message history', () => {
  const poller = read('src/services/smartlead-poller.js');
  assert.match(
    poller,
    /historyLagsLastReply\(row, threadContext\)/,
    'processInboxRow must check the master-inbox row against its own history'
  );
  assert.match(
    poller,
    /getThreadHistory/,
    'the stale-history path must fall back to campaigns/:id/leads/:id/message-history'
  );
  assert.match(
    poller,
    /latestInboundFromHistory\(threadContext/,
    'the inbound text must come from the (possibly refetched) history, not the raw row'
  );
});
