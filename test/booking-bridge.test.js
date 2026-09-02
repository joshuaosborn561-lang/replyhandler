const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBridgePayload,
  normalizeEmail,
  CLIENT_SLUG_ALIASES,
  assertBookingBridgeSecret,
} = require('../src/services/booking-bridge');

describe('booking-bridge payload', () => {
  it('normalizes email and maps booking_confirmed to treat_as_booked', () => {
    const p = parseBridgePayload({
      event: 'booking_confirmed',
      email: '  Dan@Example.COM ',
      name: 'Dan',
      client_slug: 'goliath',
      client_name: 'Goliath',
      campaign: 'Q3',
    });
    assert.equal(p.email, 'dan@example.com');
    assert.equal(p.treatAsBooked, true);
    assert.equal(p.clientSlug, 'goliath');
    assert.equal(p.event, 'booking_confirmed');
  });

  it('honors treat_as_booked on booking_link_clicked', () => {
    const p = parseBridgePayload({
      event: 'booking_link_clicked',
      treat_as_booked: true,
      email: 'a@b.com',
      client_slug: 'culturefits',
    });
    assert.equal(p.treatAsBooked, true);
  });

  it('rejects blank email via normalizeEmail', () => {
    assert.equal(normalizeEmail(''), '');
    assert.equal(normalizeEmail('not-an-email'), '');
    assert.equal(normalizeEmail('ok@x.com'), 'ok@x.com');
  });

  it('has slug aliases for every campaignintelligence client', () => {
    for (const slug of [
      'goliath', 'parlay', 'techevo', 'culturefits',
      'bolder', 'salesglider', 'peterson', 'vasco',
    ]) {
      assert.ok(CLIENT_SLUG_ALIASES[slug]?.length, `missing aliases for ${slug}`);
    }
  });
});

describe('booking-bridge auth', () => {
  it('rejects when secret unset', () => {
    const prev = process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
    delete process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
    try {
      const r = assertBookingBridgeSecret({
        get: () => 'Bearer anything',
      });
      assert.equal(r.ok, false);
      assert.equal(r.status, 503);
    } finally {
      if (prev == null) delete process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
      else process.env.BOOKING_BRIDGE_WEBHOOK_SECRET = prev;
    }
  });

  it('rejects wrong bearer token', () => {
    const prev = process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
    process.env.BOOKING_BRIDGE_WEBHOOK_SECRET = 'expected-secret';
    try {
      const r = assertBookingBridgeSecret({
        get: () => 'Bearer wrong-secret',
      });
      assert.equal(r.ok, false);
      assert.equal(r.status, 401);
    } finally {
      if (prev == null) delete process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
      else process.env.BOOKING_BRIDGE_WEBHOOK_SECRET = prev;
    }
  });

  it('accepts matching bearer token', () => {
    const prev = process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
    process.env.BOOKING_BRIDGE_WEBHOOK_SECRET = 'expected-secret';
    try {
      const r = assertBookingBridgeSecret({
        get: () => 'Bearer expected-secret',
      });
      assert.equal(r.ok, true);
    } finally {
      if (prev == null) delete process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
      else process.env.BOOKING_BRIDGE_WEBHOOK_SECRET = prev;
    }
  });
});

describe('campaignIntelligenceSaysBooked', () => {
  const { campaignIntelligenceSaysBooked } = require('../src/services/booking-bridge');
  const prevFetch = global.fetch;
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  function restoreEnv() {
    if (prevUrl == null) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    global.fetch = prevFetch;
  }

  it('returns null when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      assert.equal(await campaignIntelligenceSaysBooked('a@b.com'), null);
    } finally {
      restoreEnv();
    }
  });

  it('returns booking_bridge_confirmed for booking_confirmed rows', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      async text() {
        return JSON.stringify([
          {
            id: 1,
            event_type: 'booking_confirmed',
            client_slug: 'goliath',
            platform: 'hubspot',
          },
        ]);
      },
    });
    try {
      assert.equal(
        await campaignIntelligenceSaysBooked('dan@example.com'),
        'booking_bridge_confirmed'
      );
    } finally {
      restoreEnv();
    }
  });

  it('treats Culture Fits / MS Bookings page_view as booked', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      async text() {
        return JSON.stringify([
          {
            id: 2,
            event_type: 'page_view',
            client_slug: 'culturefits',
            platform: 'msbookings',
          },
        ]);
      },
    });
    try {
      assert.equal(
        await campaignIntelligenceSaysBooked('cf@example.com'),
        'booking_bridge_ms_click'
      );
    } finally {
      restoreEnv();
    }
  });

  it('ignores plain page_view clicks', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      async text() {
        return JSON.stringify([
          {
            id: 3,
            event_type: 'page_view',
            client_slug: 'goliath',
            platform: 'hubspot',
          },
        ]);
      },
    });
    try {
      assert.equal(await campaignIntelligenceSaysBooked('x@y.com'), null);
    } finally {
      restoreEnv();
    }
  });
});
