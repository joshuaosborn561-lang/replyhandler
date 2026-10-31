const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../src/services/calendly-attendance-sync');

const ENV = { CALENDLY_API_TOKEN: 'x', MEETSTREAM_ATTENDANCE_ENABLED: 'true' };

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, method: init.method });
    const u = new URL(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (u.pathname === '/users/me') return ok({ resource: { uri: 'https://api.calendly.com/users/U1' } });
    if (u.searchParams.get('status') === 'canceled') {
      return ok({ collection: [{ uri: 'https://api.calendly.com/scheduled_events/C1' }], pagination: {} });
    }
    return ok({
      collection: [
        { uri: 'https://api.calendly.com/scheduled_events/E1', start_time: '2026-11-03T20:00:00Z', end_time: '2026-11-03T20:30:00Z',
          location: { type: 'google_conference', join_url: 'https://meet.google.com/abc-defg-hij' } },
        { uri: 'https://api.calendly.com/scheduled_events/E2', start_time: '2026-11-03T21:00:00Z', end_time: '2026-11-03T21:30:00Z',
          location: { type: 'zoom', join_url: 'https://us02web.zoom.us/j/123' } },
        { uri: 'https://api.calendly.com/scheduled_events/E3', start_time: '2026-11-03T22:00:00Z', location: { type: 'physical' } },
      ],
      pagination: {},
    });
  };
}

describe('calendly attendance sync', () => {
  it('is off without a token or when attendance is disabled', async () => {
    assert.equal(sync.enabled({}), false);
    assert.equal(sync.enabled({ CALENDLY_API_TOKEN: 'x' }), false);
    assert.equal(sync.enabled(ENV), true);
    const r = await sync.runSync({ env: {}, fetchImpl: async () => { throw new Error('no calls'); } });
    assert.equal(r.disabled, true);
  });

  it('registers Google Meet only, skips Zoom, marks canceled, and only issues GETs', async () => {
    const calls = []; const reg = [];
    const r = await sync.runSync({
      env: ENV, fetchImpl: fakeFetch(calls), now: new Date('2026-11-02T12:00:00Z'),
      register: async (i) => { reg.push(i); return { ok: true, cancelled: !!i.cancelled }; },
    });
    assert.deepEqual(r, { registered: 1, skipped_non_meet: 2, cancelled: 1, errors: 0 });
    assert.ok(calls.length >= 3 && calls.every((c) => c.method === 'GET'));
    assert.equal(reg[0].booking_ref, 'E1');
    assert.equal(reg[0].source, 'calendly_josh');
    assert.equal(reg[0].scope, 'josh');
    assert.equal(reg[0].meeting_url, 'https://meet.google.com/abc-defg-hij');
    assert.equal(reg[1].cancelled, true);
  });

  it('meetUrlOf only accepts Meet links', () => {
    assert.equal(sync.meetUrlOf({ location: { join_url: 'https://zoom.us/j/1' } }), null);
    assert.equal(sync.meetUrlOf({}), null);
    assert.equal(sync.uuidOf('https://api.calendly.com/scheduled_events/ABC'), 'ABC');
  });
});
