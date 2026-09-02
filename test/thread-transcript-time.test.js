/**
 * Guard: thread transcript times must be normalised before they are sorted.
 *
 * follow-up-runner's priorSentMessages passes `time: r.updated_at`, and
 * node-pg hydrates a timestamptz column into a real Date. The transcript sort
 * compares with localeCompare, which Date does not have — so every FOLLOW_UP
 * card threw `a.time.localeCompare is not a function`, the row was left
 * pending, retried each cron tick for 24h (~288 attempts), then retired as
 * 'stale'. Zero follow-up cards posted 2026-08-09 → 2026-08-13 as a result.
 *
 * The regular reply path never hit it: slack.js passes extraMessages with no
 * `time` key at all, so the falsy guard short-circuits before the compare.
 * That asymmetry is why this shipped green — these tests close it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { extractThreadMessages } = require('../src/utils/thread-transcript');

const HISTORY = {
  history: [
    { type: 'SENT', time: '2026-08-11T15:47:48.070Z', email_body: 'First outbound' },
    { type: 'REPLY', time: '2026-08-11T15:53:25.000Z', email_body: 'Their reply' },
  ],
};

test('a Date in extraMessages does not throw', () => {
  // The exact shape priorSentMessages produces.
  assert.doesNotThrow(() => {
    extractThreadMessages('smartlead', HISTORY, {
      extraMessages: [{ role: 'us', body: 'from a sent row', time: new Date('2026-08-12T10:00:00Z') }],
    });
  }, 'a Postgres timestamp must not crash the transcript');
});

test('every returned time is a string', () => {
  const out = extractThreadMessages('smartlead', HISTORY, {
    extraMessages: [
      { role: 'us', body: 'date shaped', time: new Date('2026-08-12T10:00:00Z') },
      { role: 'them', body: 'epoch shaped', time: Date.parse('2026-08-12T11:00:00Z') },
      { role: 'us', body: 'no time at all' },
    ],
  });
  for (const m of out) {
    assert.strictEqual(typeof m.time, 'string', `time must be a string, got ${typeof m.time}`);
  }
});

test('normalised Dates sort chronologically against ISO history', () => {
  const out = extractThreadMessages('smartlead', HISTORY, {
    extraMessages: [
      // Deliberately appended out of order — belongs between the two history rows.
      { role: 'us', body: 'MIDDLE', time: new Date('2026-08-11T15:50:00.000Z') },
      { role: 'them', body: 'LAST', time: new Date('2026-08-13T09:00:00.000Z') },
    ],
  });
  const bodies = out.map((m) => m.body);
  assert.deepStrictEqual(
    bodies,
    ['First outbound', 'MIDDLE', 'Their reply', 'LAST'],
    'a Date must order correctly against ISO strings, not just avoid throwing'
  );
});

test('invalid and empty times degrade quietly', () => {
  assert.doesNotThrow(() => {
    const out = extractThreadMessages('smartlead', HISTORY, {
      extraMessages: [
        { role: 'us', body: 'bad date', time: new Date('nonsense') },
        { role: 'them', body: 'null time', time: null },
      ],
    });
    for (const m of out) assert.strictEqual(typeof m.time, 'string');
  });
});

test('the working reply-card shape keeps working', () => {
  // slack.js passes no `time` — this path was never broken and must stay that way.
  const out = extractThreadMessages('smartlead', HISTORY, {
    extraMessages: [{ role: 'them', body: 'inbound with no time' }],
  });
  assert.ok(out.length >= 3);
});
