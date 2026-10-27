const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchPublicTidyCalStarts,
  fetchPublicBookingStarts,
  parseTidyCalBookingUrl,
  isTidyCalUrl,
  resetTidyCalCacheForTests,
  pickTwoBusinessDayStarts,
} = require('../src/services/scheduling-slots');

const NOW = Date.parse('2026-10-27T18:00:00Z');

/** Fake TidyCal REST API. Records every request path. */
function fakeApi({ timeslots, teamPages = 1, rateLimit = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    const json = (body, status = 200) => ({
      ok: status < 400,
      status,
      headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '12' : null) },
      json: async () => body,
    });
    if (rateLimit) return json({}, 429);
    const page = Number(u.searchParams.get('page') || 1);
    if (u.pathname === '/api/booking-types') {
      return json({
        data: [
          { id: 1, booking_page_url: 'https://tidycal.com/jane/intro', duration_minutes: 30 },
          { id: 2, booking_page_url: 'https://tidycal.com/jane/disabled', disabled_at: '2026-01-01T00:00:00Z' },
        ],
        next_page_url: null,
      });
    }
    if (u.pathname === '/api/teams') {
      // two pages to exercise pagination
      return page < teamPages
        ? json({ data: [{ id: 10 }], links: { next: 'x' } })
        : json({ data: [{ id: 11 }], links: { next: null } });
    }
    if (/^\/api\/teams\/\d+\/booking-types$/.test(u.pathname)) {
      const id = u.pathname.split('/')[3];
      return json({
        data: id === '11'
          ? [{ id: 111, booking_page_url: 'https://tidycal.com/team/parlay-tech/30-minute-meeting', duration_minutes: 30 }]
          : [{ id: 100, booking_page_url: 'https://tidycal.com/team/other/30-minute-meeting' }],
        links: { next: null },
      });
    }
    const m = u.pathname.match(/^\/api\/booking-types\/(\d+)\/timeslots$/);
    if (m) {
      assert.ok(u.searchParams.get('starts_at') && u.searchParams.get('ends_at'));
      return json({ data: timeslots ? timeslots(Number(m[1]), u) : [] });
    }
    return json({ message: 'not found' }, 404);
  };
  return { fetchImpl, calls };
}

const slot = (iso, available = 1) => ({
  starts_at: iso,
  ends_at: new Date(Date.parse(iso) + 30 * 60000).toISOString(),
  available_bookings: available,
});

describe('TidyCal booking URL parsing', () => {
  it('keys team and personal pages', () => {
    assert.deepEqual(parseTidyCalBookingUrl('https://tidycal.com/team/Parlay-Tech/30-minute-meeting'), { key: 'team/parlay-tech/30-minute-meeting' });
    assert.deepEqual(parseTidyCalBookingUrl('https://www.tidycal.com/jane/intro?x=1'), { key: 'jane/intro' });
    assert.equal(parseTidyCalBookingUrl('https://tidycal.com/jane'), null);
    assert.equal(parseTidyCalBookingUrl('https://calendly.com/a/b'), null);
    assert.equal(parseTidyCalBookingUrl('not a url'), null);
  });

  it('recognises team custom domains only when configured', () => {
    assert.equal(isTidyCalUrl('https://parlay.book.example.com/30-minute-meeting'), false);
    process.env.TIDYCAL_CUSTOM_HOSTS = JSON.stringify({ 'parlay.book.example.com': 'team/parlay-tech' });
    try {
      assert.equal(isTidyCalUrl('https://parlay.book.example.com/30-minute-meeting'), true);
      assert.deepEqual(parseTidyCalBookingUrl('https://parlay.book.example.com/30-minute-meeting'), { key: 'team/parlay-tech/30-minute-meeting' });
    } finally {
      delete process.env.TIDYCAL_CUSTOM_HOSTS;
    }
  });
});

describe('fetchPublicTidyCalStarts', () => {
  beforeEach(() => resetTidyCalCacheForTests());
  const url = 'https://tidycal.com/team/parlay-tech/30-minute-meeting';

  it('maps the URL to a booking type (across paged teams) and returns sorted future starts', async () => {
    const { fetchImpl, calls } = fakeApi({
      teamPages: 2,
      timeslots: () => [
        slot('2026-10-29T15:00:00Z'),
        slot('2026-10-28T15:30:00Z'),
        slot('2026-10-28T15:00:00Z'),
        slot('2026-10-27T17:00:00Z'), // already past at NOW
        slot('2026-10-28T16:00:00Z', 0), // full
      ],
    });
    const out = await fetchPublicTidyCalStarts(url, {}, { token: 'test-token', fetchImpl, now: NOW });
    assert.deepEqual(out.starts.map((d) => d.toISOString()), [
      '2026-10-28T15:00:00.000Z',
      '2026-10-28T15:30:00.000Z',
      '2026-10-29T15:00:00.000Z',
    ]);
    assert.equal(out.timeZone, 'America/Chicago');
    assert.ok(calls.some((c) => c.startsWith('/api/booking-types/111/timeslots?')), 'asked timeslots for booking type 111');
  });

  it('feeds pickTwoBusinessDayStarts: one slot on each of the next two business days', async () => {
    const { fetchImpl } = fakeApi({
      timeslots: () => [
        slot('2026-10-28T15:00:00Z'), slot('2026-10-28T15:30:00Z'),
        slot('2026-10-29T15:00:00Z'), slot('2026-10-30T15:00:00Z'),
      ],
    });
    const out = await fetchPublicTidyCalStarts(url, {}, { token: 'test-token', fetchImpl, now: NOW });
    const picked = pickTwoBusinessDayStarts(out.starts, { timeZone: out.timeZone, now: new Date(NOW) });
    assert.deepEqual(picked.map((d) => d.toISOString()), ['2026-10-28T15:00:00.000Z', '2026-10-29T15:00:00.000Z']);
  });

  it('clamps the requested range to the 90-day API maximum', async () => {
    const { fetchImpl, calls } = fakeApi({ timeslots: () => [] });
    await fetchPublicTidyCalStarts(url, { fromDate: new Date(NOW), toDate: new Date(NOW + 200 * 86400000) }, { token: 'test-token', fetchImpl, now: NOW });
    const q = new URLSearchParams(calls.find((c) => c.includes('/timeslots?')).split('?')[1]);
    assert.ok(Date.parse(q.get('ends_at')) - Date.parse(q.get('starts_at')) <= 89 * 86400000 + 1000);
  });

  it('caches the booking type index (second call makes no listing requests)', async () => {
    const { fetchImpl, calls } = fakeApi({ timeslots: () => [slot('2026-10-28T15:00:00Z')] });
    await fetchPublicTidyCalStarts(url, {}, { token: 'test-token', fetchImpl, now: NOW });
    const before = calls.length;
    await fetchPublicTidyCalStarts(url, {}, { token: 'test-token', fetchImpl, now: NOW + 1000 });
    assert.equal(calls.length - before, 1, 'only the timeslots request');
  });

  it('unknown URL: empty result, and the index is not re-fetched more than once a minute', async () => {
    const { fetchImpl, calls } = fakeApi({ timeslots: () => [] });
    const bad = 'https://tidycal.com/team/nobody/30-minute-meeting';
    const a = await fetchPublicTidyCalStarts(bad, {}, { token: 'test-token', fetchImpl, now: NOW });
    assert.deepEqual(a, { starts: [], timeZone: null });
    const afterFirst = calls.length;
    await fetchPublicTidyCalStarts(bad, {}, { token: 'test-token', fetchImpl, now: NOW + 5000 });
    assert.equal(calls.length, afterFirst, 'no listing storm on repeated misses');
    await fetchPublicTidyCalStarts(bad, {}, { token: 'test-token', fetchImpl, now: NOW + 61000 });
    assert.ok(calls.length > afterFirst, 'retries after cooldown');
  });

  it('skips disabled booking types', async () => {
    const { fetchImpl } = fakeApi({ timeslots: () => [slot('2026-10-28T15:00:00Z')] });
    const out = await fetchPublicTidyCalStarts('https://tidycal.com/jane/disabled', {}, { token: 'test-token', fetchImpl, now: NOW });
    assert.equal(out.starts.length, 0);
  });

  it('no token: inert (no network call, empty result)', async () => {
    let called = false;
    const out = await fetchPublicTidyCalStarts(url, {}, { token: '', fetchImpl: async () => { called = true; } });
    assert.equal(called, false);
    assert.deepEqual(out, { starts: [], timeZone: null });
  });

  it('rate limit surfaces as an error the caller already handles', async () => {
    const { fetchImpl } = fakeApi({ rateLimit: true });
    await assert.rejects(
      () => fetchPublicTidyCalStarts(url, {}, { token: 'test-token', fetchImpl, now: NOW }),
      (e) => e.code === 'TIDYCAL_RATE_LIMIT' && /12s/.test(e.message),
    );
  });
});

describe('fetchPublicBookingStarts dispatch', () => {
  it('routes tidycal.com URLs to TidyCal (and returns empty when no token is configured)', async () => {
    const prev = process.env.TIDYCAL_API_TOKEN;
    delete process.env.TIDYCAL_API_TOKEN;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const out = await fetchPublicBookingStarts('https://tidycal.com/team/parlay-tech/30-minute-meeting', {});
      assert.deepEqual(out, { starts: [], timeZone: null });
    } finally {
      console.warn = origWarn;
      if (prev !== undefined) process.env.TIDYCAL_API_TOKEN = prev;
    }
  });
});
