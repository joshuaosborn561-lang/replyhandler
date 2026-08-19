/**
 * Guard: the attention digest must not be monopolised by old backlog, and must
 * not report its display cap as if it were the total.
 *
 * pendingApprovalRows orders oldest-first with LIMIT 25. With no lower bound, a
 * large backlog fills all 25 slots and current work becomes structurally
 * invisible. Measured 2026-08-18 against a 2,075-row backlog: the newest row
 * SalesGlider's digest could surface was 38 days old; Culture Fits' was 22.
 *
 * Second bug guarded here: pendingCount was taken from the capped array length,
 * so the header read "25 pending" whether the real number was 25 or 2,075.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { attentionDigestWindowDays, PENDING_DIGEST_LIMIT } = require('../src/cron');

test('digest window defaults to 7 days and is overridable', () => {
  const original = process.env.ATTENTION_DIGEST_WINDOW_DAYS;
  try {
    delete process.env.ATTENTION_DIGEST_WINDOW_DAYS;
    assert.strictEqual(attentionDigestWindowDays(), 7);

    process.env.ATTENTION_DIGEST_WINDOW_DAYS = '3';
    assert.strictEqual(attentionDigestWindowDays(), 3);

    // Junk and non-positive values must fall back, never disable the bound.
    for (const bad of ['', 'abc', '0', '-5']) {
      process.env.ATTENTION_DIGEST_WINDOW_DAYS = bad;
      assert.strictEqual(attentionDigestWindowDays(), 7, `"${bad}" must fall back to 7`);
    }
  } finally {
    if (original === undefined) delete process.env.ATTENTION_DIGEST_WINDOW_DAYS;
    else process.env.ATTENTION_DIGEST_WINDOW_DAYS = original;
  }
});

test('the pending query is bounded by the window', () => {
  const cron = read('src/cron.js');
  const query = cron.slice(cron.indexOf('async function pendingApprovalRows'));

  assert.match(
    query,
    /created_at > now\(\) - \(\$2::int \* interval '1 day'\)/,
    'pendingApprovalRows must exclude rows older than the window — without it, '
    + 'backlog fills every slot and recent replies never appear'
  );
  assert.ok(
    PENDING_DIGEST_LIMIT > 0,
    'the display cap must stay a real cap'
  );
});

test('the header count is not the display cap', () => {
  const cron = read('src/cron.js');

  assert.ok(
    !/pendingCount:\s*pendingApprovals\.length/.test(cron),
    'pendingCount must not come from the capped array — that reports the cap as the total'
  );
  assert.match(
    cron,
    /pendingCount:\s*pendingTotal/,
    'pendingCount must use the real in-window total'
  );
  // Both the Slack header and the recorded row need the true number.
  const uses = cron.match(/pendingCount:\s*pendingTotal/g) || [];
  assert.ok(uses.length >= 2, 'header and recorded digest must both use the true total');
});
