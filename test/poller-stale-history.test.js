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
  shouldRefetchStaleHistory,
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

// ── Which stale rows are actually worth an API call ───────────────────
// Refetching every stale row exhausted the per-cycle budget on 2026-08-18 and
// left real replies behind it — Melissa Page (Goliath) confirmed a 9:30am
// meeting and no card was created, because her thread came after the cap.
test('only stale rows whose visible reply was already carded are refetched', () => {
  // The costly case: we can see an old reply, we already carded it, so dedupe
  // is about to drop this thread — a newer reply could be hiding behind it.
  assert.strictEqual(
    shouldRefetchStaleHistory({ hasVisibleInbound: true, visibleAlreadyCarded: true }),
    true,
    'a carded visible reply on a stale row is exactly the hidden-reply signature'
  );

  // The cheap case: the visible reply is new. Card it now; if something is
  // hidden behind it, next cycle sees it as carded and probes then.
  assert.strictEqual(
    shouldRefetchStaleHistory({ hasVisibleInbound: true, visibleAlreadyCarded: false }),
    false,
    'a new visible reply needs no API call — it self-heals on the next cycle'
  );

  // Row claims a reply but shipped none: nothing to card either way.
  assert.strictEqual(
    shouldRefetchStaleHistory({ hasVisibleInbound: false, visibleAlreadyCarded: false }),
    true,
    'a reply we cannot see at all is always worth fetching'
  );
});

test('the refetch budget is a safety valve, not the normal limit', () => {
  const poller = read('src/services/smartlead-poller.js');
  const match = poller.match(/SMARTLEAD_POLL_MAX_HISTORY_REFETCH',\s*(\d+)\)/);
  assert.ok(match, 'the refetch budget must stay configurable');
  assert.ok(
    parseInt(match[1], 10) >= 40,
    'the default budget must exceed the number of rows a cycle scans per client, '
    + 'or the cap silently becomes the thing dropping replies'
  );
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
  assert.match(
    poller,
    /shouldRefetchStaleHistory\(/,
    'the refetch must be targeted — refetching every stale row exhausts the budget '
    + 'and lets real replies through unseen'
  );
  // The targeting decision needs the dedupe answer, so it must be consulted first.
  const refetchBlock = poller.slice(
    poller.indexOf('const staleHistory ='),
    poller.indexOf('if (!inbound) return')
  );
  assert.match(
    refetchBlock,
    /alreadyPostedToSlack\(/,
    'the probe must ask whether the visible reply was already carded'
  );
});
