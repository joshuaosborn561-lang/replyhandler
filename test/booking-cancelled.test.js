/**
 * A cancelled booking is not a booking.
 *
 * booking-bridge stamps `booking_events.cancelled_at` on the original
 * booking_confirmed row when TidyCal reports a cancel, and writes a
 * booking_cancelled row that points back at it. Every ReplyHandler check that
 * reads booking_events must ignore such bookings, and a lead whose only
 * booking was cancelled gets its normal follow-up schedule back.
 *
 * The DB-backed block uses PGlite (dev-only, skipped when not installed:
 * NODE_PATH=<dir with @electric-sql/pglite>).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { /* skip below */ }
const skipDb = PGlite ? false : 'PGlite not installed (dev-only integration test)';

for (const k of ['ALLO_API_KEY', 'ALLO_PHONE_NUMBERS', 'ALLO_PHONE_NUMBER']) delete process.env[k];

const bridge = require('../src/services/booking-bridge');
const ghosted = require('../src/services/ghosted-meetings');

const { activeBookingRows, bookingRowIsCancelled } = bridge;

const conf = (id, over = {}) => ({
  id, event_type: 'booking_confirmed', client_slug: 'acme', created_at: '2026-10-27T15:00:00Z',
  cancelled_at: null, payload: { tidycal_booking_id: `tc${id}` }, ...over,
});
const cancel = (id, original, over = {}) => ({
  id, event_type: 'booking_cancelled', client_slug: 'acme', created_at: '2026-10-27T16:00:00Z',
  cancelled_at: '2026-10-27T16:00:00Z',
  payload: { original_booking_event_id: String(original), tidycal_booking_id: `tc${original}` }, ...over,
});

test('bookingRowIsCancelled: cancelled_at or payload flag', () => {
  assert.equal(bookingRowIsCancelled(conf(1)), false);
  assert.equal(bookingRowIsCancelled(conf(1, { cancelled_at: '2026-10-27T16:00:00Z' })), true);
  assert.equal(bookingRowIsCancelled(conf(1, { payload: { cancelled: true } })), true);
  assert.equal(bookingRowIsCancelled(conf(1, { payload: { cancelled: false, cancelled_at: null } })), false);
  assert.equal(bookingRowIsCancelled(null), false);
});

test('activeBookingRows drops rows with cancelled_at', () => {
  const rows = [conf(1, { cancelled_at: '2026-10-27T16:00:00Z' }), conf(2)];
  assert.deepEqual(activeBookingRows(rows).map((r) => r.id), [2]);
});

test('activeBookingRows drops a confirmed row with a linked booking_cancelled (not yet stamped)', () => {
  // cancel arrived, original row not stamped: link by original_booking_event_id
  assert.deepEqual(activeBookingRows([conf(1), cancel(9, 1, { cancelled_at: null })]).map((r) => r.id), [9]
    .filter(() => false));
  // link by tidycal_booking_id only
  const c = cancel(9, 1, { cancelled_at: null });
  c.payload = { tidycal_booking_id: 'tc1' };
  assert.deepEqual(activeBookingRows([conf(1), c]), []);
});

test('activeBookingRows keeps other live bookings of the same lead', () => {
  const rows = [conf(1), conf(2), cancel(9, 1)];
  assert.deepEqual(activeBookingRows(rows).map((r) => r.id), [2]);
});

test('a cancel for another client or booking never retires this booking', () => {
  const other = cancel(9, 7, { client_slug: 'zed' });
  other.payload.tidycal_booking_id = 'tc1'; // same id string but different client
  assert.deepEqual(activeBookingRows([conf(1), other]).map((r) => r.id), [1]);
});

test('a reschedule does not cancel and is not itself a booking', () => {
  const resched = { id: 5, event_type: 'booking_rescheduled', client_slug: 'acme', cancelled_at: null,
    payload: { original_booking_event_id: '1', tidycal_booking_id: 'tc1' } };
  const live = activeBookingRows([conf(1), resched]);
  assert.ok(live.some((r) => r.id === 1), 'original stays booked after a reschedule');
});

function withFetch(rows, fn) {
  const saved = { fetch: global.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const seen = [];
  global.fetch = async (url) => { seen.push(String(url)); return { ok: true, async text() { return JSON.stringify(rows); } }; };
  const restore = () => {
    global.fetch = saved.fetch;
    for (const [k, v] of [['SUPABASE_URL', saved.url], ['SUPABASE_SERVICE_ROLE_KEY', saved.key]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return Promise.resolve(fn(seen)).finally(restore);
}

test('campaignIntelligenceSaysBooked: cancelled booking is not booked', () => withFetch(
  [cancel(9, 1), conf(1, { cancelled_at: '2026-10-27T16:00:00Z' })],
  async (seen) => {
    assert.equal(await bridge.campaignIntelligenceSaysBooked('a@b.com'), null);
    assert.match(seen[0], /cancelled_at/, 'must ask for cancelled_at');
    const state = await bridge.campaignIntelligenceBookingState('a@b.com');
    assert.equal(state.cancelledOnly, true);
    assert.equal(state.cancelledAnchors.length, 1);
  },
));

test('campaignIntelligenceSaysBooked: cancelled via linked row only (original unstamped)', () => withFetch(
  [cancel(9, 1, { cancelled_at: null }), conf(1)],
  async () => {
    assert.equal(await bridge.campaignIntelligenceSaysBooked('a@b.com'), null);
  },
));

test('campaignIntelligenceSaysBooked: a second live booking still counts', () => withFetch(
  [conf(2), cancel(9, 1), conf(1, { cancelled_at: '2026-10-27T16:00:00Z' })],
  async () => {
    assert.equal(await bridge.campaignIntelligenceSaysBooked('a@b.com'), 'booking_bridge_confirmed');
    assert.equal((await bridge.campaignIntelligenceBookingState('a@b.com')).cancelledOnly, false);
  },
));

test('campaignIntelligenceSaysBooked: ms-bookings click still counts, cancelled-only needs a confirmed booking', () => withFetch(
  [{ id: 3, event_type: 'page_view', client_slug: 'culturefits', platform: 'msbookings', cancelled_at: null }],
  async () => {
    assert.equal(await bridge.campaignIntelligenceSaysBooked('a@b.com'), 'booking_bridge_ms_click');
  },
));

test('ghosted-meetings only sees live bookings', () => withFetch(
  [conf(1, { cancelled_at: '2026-10-27T16:00:00Z' }), conf(2), conf(3), cancel(9, 3, { cancelled_at: null })],
  async (seen) => {
    const out = await ghosted.fetchBookingEvents({
      now: new Date('2026-10-28T12:00:00Z'), cfg: { bookingLookbackMs: 7 * 86400000 }, env: process.env,
    });
    assert.equal(out.error, null);
    assert.deepEqual(out.rows.map((r) => r.id), [2]);
    assert.match(decodeURIComponent(seen[0]), /event_type=in\.\(booking_confirmed,booking_cancelled\)/);
    assert.match(seen[0], /cancelled_at/);
  },
));

// ── DB-backed: a lead whose only booking was cancelled gets follow-ups back ──

let shared = null;
async function setup() {
  if (!shared) {
    const pg = new PGlite();
    const adapter = {
      async query(sql, params) {
        const r = await pg.query(sql, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
    };
    require.cache[require.resolve('../src/db')] = { id: 'db', filename: 'db', loaded: true, exports: adapter };
    const root = path.join(__dirname, '..');
    await pg.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8').replace(/CREATE EXTENSION[^;]*;/gi, ''));
    // services captured `db` at require time above for bridge/ghosted; reload the DB-backed ones
    for (const m of ['booking-bridge', 'booking-check']) delete require.cache[require.resolve(`../src/services/${m}`)];
    shared = { pg, check: require('../src/services/booking-check'), br: require('../src/services/booking-bridge') };
  }
  const { pg } = shared;
  await pg.exec('DELETE FROM meetings; DELETE FROM outbound_follow_ups; DELETE FROM pending_replies');
  shared.n = (shared.n || 0) + 1;
  const { rows: [client] } = await pg.query(
    `INSERT INTO clients (name, slack_bot_token, slack_channel_id) VALUES ($1, 'xoxb-test', 'C1') RETURNING id`, [`Acme Co ${shared.n}`]);
  return { ...shared, clientId: client.id };
}

const LEAD = { platform: 'smartlead', leadEmail: 'pat@x.co', leadName: 'Pat Smith', leadId: '1', since: new Date(0) };

test('looksAlreadyBooked: booked, then cancelled -> follow-ups allowed again', { skip: skipDb }, async () => {
  const { check, br, clientId } = await setup();
  // 1. booking_confirmed push mirrors a booked meeting locally and stops follow-ups
  await br.stopFollowUpsForEmail({ clientId, email: 'pat@x.co', name: 'Pat Smith' });
  await withFetch([conf(1)], async () => {
    assert.ok(await check.looksAlreadyBooked(clientId, LEAD), 'live booking still suppresses');
  });
  // 2. TidyCal cancel: original stamped + linked booking_cancelled row
  await withFetch([cancel(9, 1), conf(1, { cancelled_at: '2026-10-27T16:00:00Z', created_at: new Date().toISOString() })], async () => {
    assert.equal(await check.looksAlreadyBooked(clientId, LEAD), null, 'cancelled-only lead is bookable again');
  });
});

test('looksAlreadyBooked: cancelled booking with a second live booking stays booked', { skip: skipDb }, async () => {
  const { check, br, clientId } = await setup();
  await br.stopFollowUpsForEmail({ clientId, email: 'pat@x.co', name: 'Pat Smith' });
  await withFetch([conf(2), cancel(9, 1), conf(1, { cancelled_at: '2026-10-27T16:00:00Z' })], async () => {
    assert.ok(await check.looksAlreadyBooked(clientId, LEAD));
  });
});

test('looksAlreadyBooked: a meeting a person marked booked is not undone by a cancelled TidyCal booking', { skip: skipDb }, async () => {
  const { pg, check, clientId } = await setup();
  await pg.query(
    `INSERT INTO meetings (client_id, lead_name, lead_email, status, confirmed_time)
     VALUES ($1, 'Pat Smith', 'pat@x.co', 'booked', now() - interval '3 days')`, [clientId]);
  await withFetch([cancel(9, 1), conf(1, { cancelled_at: '2026-10-27T16:00:00Z', created_at: new Date().toISOString() })], async () => {
    assert.equal(await check.looksAlreadyBooked(clientId, LEAD), 'meeting_row_exists');
  });
});

test('looksAlreadyBooked: legacy unmarked mirror row written at booking time is ignored after cancel', { skip: skipDb }, async () => {
  const { pg, check, clientId } = await setup();
  const created = new Date('2026-10-27T15:00:00Z');
  await pg.query(
    `INSERT INTO meetings (client_id, lead_name, lead_email, status, confirmed_time)
     VALUES ($1, 'Pat Smith', 'pat@x.co', 'booked', $2)`, [clientId, new Date(created.getTime() + 20 * 1000).toISOString()]);
  await withFetch([cancel(9, 1), conf(1, { cancelled_at: '2026-10-27T16:00:00Z', created_at: created.toISOString() })], async () => {
    assert.equal(await check.looksAlreadyBooked(clientId, LEAD), null);
  });
});

test('stopFollowUpsForEmail marks the mirror row it writes', { skip: skipDb }, async () => {
  const { pg, br, clientId } = await setup();
  await br.stopFollowUpsForEmail({ clientId, email: 'pat@x.co', name: 'Pat Smith' });
  const { rows } = await pg.query(`SELECT calendar_provider, status FROM meetings WHERE client_id = $1`, [clientId]);
  assert.deepEqual(rows, [{ calendar_provider: br.BRIDGE_MEETING_MARKER, status: 'booked' }]);
});

test('no new sends: cancelled-only does not revive skipped follow-ups', { skip: skipDb }, async () => {
  const { pg, br, clientId } = await setup();
  await pg.query(
    `INSERT INTO outbound_follow_ups (client_id, platform, lead_email, due_at, status)
     VALUES ($1, 'smartlead', 'pat@x.co', now() - interval '1 hour', 'pending')`, [clientId]);
  await br.stopFollowUpsForEmail({ clientId, email: 'pat@x.co' });
  await withFetch([cancel(9, 1), conf(1, { cancelled_at: '2026-10-27T16:00:00Z' })], async () => {
    await br.campaignIntelligenceSaysBooked('pat@x.co');
  });
  const { rows } = await pg.query(`SELECT status FROM outbound_follow_ups WHERE client_id = $1`, [clientId]);
  assert.deepEqual(rows, [{ status: 'skipped' }], 'stale skipped rows are not resurrected');
});
