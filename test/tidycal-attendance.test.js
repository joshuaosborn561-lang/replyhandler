const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const tc = require('../src/services/tidycal-attendance');
const ms = require('../src/services/meetstream-attendance');

const ENV = { TIDYCAL_API_TOKEN: 'x', MEETSTREAM_ATTENDANCE_ENABLED: 'true' };
const NOW = new Date('2026-11-02T12:00:00Z').getTime();

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, method: init.method });
    const u = new URL(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (u.pathname === '/api/teams') return ok({ data: [{ id: 1, name: 'Vector Energy Group' }, { id: 2, name: 'Parlay Tech' }] });
    if (u.pathname === '/api/teams/1/bookings' && u.searchParams.get('cancelled')) return ok({ data: [{ id: 99, cancelled_at: '2026-11-01T00:00:00Z' }], links: {} });
    if (u.pathname === '/api/teams/1/bookings') {
      return ok({
        data: [
          { id: 10, starts_at: '2026-11-02T20:00:00Z', ends_at: '2026-11-02T20:30:00Z', meeting_url: 'https://meet.google.com/abc-defg-hij', hosts: [{ name: 'Al Host' }], contact: { email: 'p@example.com' } },
          { id: 11, starts_at: '2026-11-02T21:00:00Z', ends_at: '2026-11-02T21:30:00Z', meeting_url: 'https://zoom.us/j/1', contact: { email: 'q@example.com' } },
          { id: 12, starts_at: '2026-11-02T22:00:00Z', ends_at: '2026-11-02T22:30:00Z', meeting_url: null, contact: { email: 'r@example.com' } },
          { id: 13, starts_at: '2026-11-02T11:00:00Z', meeting_url: 'https://meet.google.com/old-old-old' },
        ],
        links: {},
      });
    }
    if (u.pathname === '/api/teams/2/bookings') return ok({ data: [], links: {} });
    if (u.pathname === '/api/bookings/10') {
      return ok({ data: { id: 10, starts_at: '2026-11-02T20:00:00Z', ends_at: '2026-11-02T20:30:00Z', meeting_url: 'https://meet.google.com/abc-defg-hij', booking_type: { team: { name: 'Vector Energy Group' } }, hosts: [{ name: 'Al Host' }], contact: { email: 'p@example.com' } } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

describe('tidycal attendance: flags and link selection', () => {
  it('is off without a token or when attendance is disabled', async () => {
    assert.equal(tc.enabled({}), false);
    assert.equal(tc.enabled({ TIDYCAL_API_TOKEN: 'x' }), false);
    assert.equal(tc.enabled(ENV), true);
    const r = await tc.runSync({ env: {}, fetchImpl: async () => { throw new Error('no calls'); } });
    assert.equal(r.disabled, true);
  });

  it('meetUrlOf only accepts Google Meet', () => {
    assert.equal(tc.meetUrlOf({ meeting_url: 'https://meet.google.com/abc-defg-hij' }), 'https://meet.google.com/abc-defg-hij');
    assert.equal(tc.meetUrlOf({ meeting_url: 'https://zoom.us/j/1' }), null);
    assert.equal(tc.meetUrlOf({ meeting_url: null }), null);
    assert.equal(tc.meetUrlOf({}), null);
  });

  it('maps team names to client slugs like the bridge', () => {
    assert.equal(tc.slugForTeamName('Vector Energy Group'), 'vector');
    assert.equal(tc.slugForTeamName('Parlay Tech'), 'parlay');
  });
});

describe('tidycal attendance: toRegistration', () => {
  it('uses the booking link, host names and the standing internal names', async () => {
    const r = await tc.toRegistration(
      { id: 10, starts_at: '2026-11-02T20:00:00Z', ends_at: '2026-11-02T20:30:00Z', meeting_url: 'https://meet.google.com/abc-defg-hij', hosts: [{ name: 'Al Host' }] },
      { clientSlug: 'vector', env: {}, now: NOW });
    assert.equal(r.source, 'tidycal');
    assert.equal(r.booking_ref, '10');
    assert.equal(r.scope, 'client');
    assert.equal(r.client_slug, 'vector');
    assert.equal(r.meeting_url, 'https://meet.google.com/abc-defg-hij');
    assert.ok(r.internal_names.includes('Al Host') && r.internal_names.includes('Josh'));
  });

  it('falls back to the calendar lookup when TidyCal has no link, only near the start', async () => {
    const calls = [];
    const lookup = async (a) => { calls.push(a); return 'https://meet.google.com/cal-link-xyz'; };
    const near = await tc.toRegistration({ id: 12, starts_at: '2026-11-02T22:00:00Z', meeting_url: null, contact: { email: 'r@example.com' } },
      { clientSlug: 'vector', env: {}, now: NOW, calendarLookup: lookup });
    assert.equal(near.meeting_url, 'https://meet.google.com/cal-link-xyz');
    assert.equal(calls[0].email, 'r@example.com');
    const far = await tc.toRegistration({ id: 14, starts_at: '2026-11-12T22:00:00Z', meeting_url: null, contact: { email: 'r@example.com' } },
      { clientSlug: 'vector', env: {}, now: NOW, calendarLookup: lookup });
    assert.equal(far.meeting_url, null);
    assert.equal(calls.length, 1);
  });

  it('a Zoom booking with no calendar link stays link-less (the tracker skips it)', async () => {
    const r = await tc.toRegistration({ id: 11, starts_at: '2026-11-02T21:00:00Z', meeting_url: 'https://zoom.us/j/1', contact: { email: 'q@example.com' } },
      { clientSlug: 'vector', env: {}, now: NOW, calendarLookup: async () => null });
    assert.equal(r.meeting_url, null);
  });

  it('a cancelled booking becomes a cancellation', async () => {
    const r = await tc.toRegistration({ id: 9, cancelled_at: '2026-11-01T00:00:00Z' }, { clientSlug: 'vector', env: {} });
    assert.equal(r.cancelled, true);
    assert.equal(r.booking_ref, '9');
  });
});

describe('tidycal attendance: sync and bridge registration', () => {
  it('syncs each team, skips finished bookings, registers cancellations and only GETs', async () => {
    const calls = []; const reg = [];
    const r = await tc.runSync({
      env: ENV, fetchImpl: fakeFetch(calls), now: NOW,
      calendarLookup: async () => null,
      register: async (i) => { reg.push(i); return i.cancelled ? { ok: true, cancelled: true } : { ok: true, status: i.meeting_url ? 'scheduled' : 'skipped', reason: i.meeting_url ? null : 'no_meeting_url' }; },
    });
    assert.deepEqual(r, { teams: 2, registered: 3, scheduled: 1, cancelled: 1, no_link: 2, errors: 0 });
    assert.ok(calls.every((c) => c.method === 'GET'));
    const live = reg.filter((i) => !i.cancelled).map((i) => i.booking_ref);
    assert.deepEqual(live, ['10', '11', '12']);
    assert.ok(reg.every((i) => i.source === 'tidycal' && i.scope === 'client' && i.client_slug === 'vector'));
  });

  it('registerById resolves the booking through the API and its team', async () => {
    const reg = [];
    const r = await tc.registerById('10', { env: ENV, fetchImpl: fakeFetch([]), register: async (i) => { reg.push(i); return { ok: true, id: 'row' }; } });
    assert.equal(r.ok, true);
    assert.equal(reg[0].client_slug, 'vector');
    assert.equal(reg[0].meeting_url, 'https://meet.google.com/abc-defg-hij');
  });

  it('registerById returns null when TidyCal cannot be read', async () => {
    const r = await tc.registerById('404', { env: ENV, fetchImpl: fakeFetch([]), register: async () => { throw new Error('should not register'); } });
    assert.equal(r, null);
  });

  it('bridge payload with a TidyCal booking id goes through the API path', async () => {
    const seen = [];
    const fake = { tokenOf: () => 'x', registerById: async (id, o) => { seen.push({ id, slug: o.clientSlug }); return { ok: true, id: 'row' }; } };
    const r = await ms.registerFromBridgePayload({ event: 'booking_confirmed', booking_ref: '10', client_slug: 'vector' }, ENV, { tidycal: fake });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, [{ id: '10', slug: 'vector' }]);
  });

  it('bridge payload without a link or a TidyCal booking is ignored', async () => {
    const r = await ms.registerFromBridgePayload({ event: 'booking_confirmed', email: 'x@example.com' }, ENV);
    assert.equal(r.skipped, 'no_meeting_fields');
  });
});

describe('meetstream attendance: per-client switch', () => {
  it('every client is on unless listed in MEETSTREAM_CLIENTS_OFF', () => {
    assert.equal(ms.clientOff('vector', {}), false);
    assert.equal(ms.clientOff('vector', { MEETSTREAM_CLIENTS_OFF: 'parlay, Vector' }), true);
    assert.equal(ms.clientOff('nutter', { MEETSTREAM_CLIENTS_OFF: 'parlay,vector' }), false);
    assert.equal(ms.clientOff('', { MEETSTREAM_CLIENTS_OFF: 'vector' }), false);
  });
});
