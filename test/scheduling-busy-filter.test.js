const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/services/scheduling-slots');

const starts = ['2026-10-27T14:00:00Z', '2026-10-27T15:00:00Z', '2026-10-27T16:00:00Z'].map((x) => new Date(x));

test('drops starts that clash with busy blocks from any calendar', async () => {
  s._resetBusyCacheForTests();
  const out = await s.filterBusyStarts('c1', starts, {
    busyLookup: async () => [
      { start: '2026-10-27T14:15:00Z', end: '2026-10-27T14:45:00Z' },
      { start: { dateTime: '2026-10-27T16:00:00.0000000' }, end: { dateTime: '2026-10-27T16:30:00.0000000' } },
    ],
  });
  assert.deepEqual(out.map((d) => d.toISOString()), ['2026-10-27T15:00:00.000Z']);
});

test('no calendar connected: starts unchanged', async () => {
  s._resetBusyCacheForTests();
  const out = await s.filterBusyStarts('c2', starts, { busyLookup: async () => null });
  assert.equal(out.length, 3);
});

test('busy check failure offers no times rather than guessing', async () => {
  s._resetBusyCacheForTests();
  const out = await s.filterBusyStarts('c3', starts, { busyLookup: async () => { throw new Error('403'); } });
  assert.deepEqual(out, []);
});

test('Graph dateTime without offset is read as UTC', () => {
  const iv = s.normalizeBusyIntervals([{ start: { dateTime: '2026-10-27T16:00:00.0000000' }, end: { dateTime: '2026-10-27T16:30:00' } }], 'microsoft');
  assert.equal(iv[0].start.toISOString(), '2026-10-27T16:00:00.000Z');
});

test('fast paths use the warm busy cache and never call the calendar', async () => {
  s._resetBusyCacheForTests();
  let calls = 0;
  const lookup = async () => { calls += 1; return [{ start: '2026-10-27T14:00:00Z', end: '2026-10-27T14:30:00Z' }]; };
  assert.equal((await s.filterBusyStarts('c4', starts, { busyLookup: lookup, cacheOnly: true })).length, 3);
  assert.equal(calls, 0);
  await s.filterBusyStarts('c4', starts, { busyLookup: lookup, force: true });
  assert.equal((await s.filterBusyStarts('c4', starts, { busyLookup: lookup, cacheOnly: true })).length, 2);
  assert.equal(calls, 1);
});
