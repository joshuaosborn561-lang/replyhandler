const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseClientsJs,
  slugFromWrapUrl,
  isBookingBridgeWrap,
  resolveAvailabilityBookingUrl,
  resolveLiveAvailabilityBookingUrl,
  normalizeClientBooking,
  refreshDestinations,
  FALLBACK_DESTINATIONS,
  _resetLiveDestinationsForTests,
} = require('../src/utils/booking-bridge-destinations');
const { isCalendlyUrl } = require('../src/services/scheduling-slots');

describe('booking-bridge destinations', () => {
  beforeEach(() => {
    _resetLiveDestinationsForTests();
  });

  it('unwraps book.gosalesglider.com slugs to the real calendar', () => {
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'TechEvolution',
        booking_link: 'https://book.gosalesglider.com/techevo',
      }),
      'https://calendly.com/ctapper/meeting'
    );
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'Parlay Tech',
        booking_link: 'https://book.gosalesglider.com/parlay',
      }),
      'https://calendly.com/randyhaba/30min'
    );
    assert.equal(
      resolveAvailabilityBookingUrl({ name: 'SalesGlider' }),
      'https://calendly.com/joshua-salesglidergrowth/30min'
    );
  });

  it('wraps a regular calendar URL and keeps it as the destination', () => {
    const n = normalizeClientBooking({
      name: 'New Shop',
      booking_link: 'https://calendly.com/new-shop/30min',
    });
    assert.equal(n.slug, 'newshop');
    assert.equal(n.booking_link, 'https://book.gosalesglider.com/newshop');
    assert.equal(n.booking_destination_url, 'https://calendly.com/new-shop/30min');
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'New Shop',
        booking_link: n.booking_link,
        booking_destination_url: n.booking_destination_url,
      }),
      'https://calendly.com/new-shop/30min'
    );
  });

  it('leaves a raw Calendly booking_link alone', () => {
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'SalesGlider',
        booking_link: 'https://calendly.com/joshua-salesglidergrowth/30min',
      }),
      'https://calendly.com/joshua-salesglidergrowth/30min'
    );
  });

  it('does not treat HubSpot / MS Bookings / PowerPSA destinations as Calendly', () => {
    const hubspot = resolveAvailabilityBookingUrl({
      name: 'Goliath Cybersecurity',
      booking_link: 'https://book.gosalesglider.com/goliath',
    });
    const ms = resolveAvailabilityBookingUrl({
      name: 'Culture Fits',
      booking_link: 'https://book.gosalesglider.com/culturefits',
    });
    const psa = resolveAvailabilityBookingUrl({
      name: 'PowerGryd',
      booking_link: 'https://book.gosalesglider.com/powergryd',
    });
    assert.equal(hubspot, FALLBACK_DESTINATIONS.goliath);
    assert.equal(isCalendlyUrl(hubspot), false);
    assert.equal(isCalendlyUrl(ms), false);
    assert.equal(isCalendlyUrl(psa), false);
  });

  it('parses live clients.js and prefers those destinations', async () => {
    const js = `
window.BOOKING_CLIENTS = {
  "techevo": {
    name: "TechEvolution",
    bookingUrl: "https://calendly.com/ctapper/new-destination",
    accent: "#5e35b1",
  },
};
`;
    assert.deepEqual(parseClientsJs(js), {
      techevo: 'https://calendly.com/ctapper/new-destination',
    });
    const map = await refreshDestinations({
      now: Date.now(),
      fetchImpl: async () => ({
        ok: true,
        text: async () => js,
      }),
    });
    assert.equal(map.techevo, 'https://calendly.com/ctapper/new-destination');
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'TechEvolution',
        booking_link: 'https://book.gosalesglider.com/techevo',
      }, map),
      'https://calendly.com/ctapper/new-destination'
    );
  });

  it('force-refreshes clients.js when a new slug is missing from the cache', async () => {
    const stale = `
window.BOOKING_CLIENTS = {
  "techevo": { name: "TechEvolution", bookingUrl: "https://calendly.com/ctapper/meeting" },
};
`;
    const fresh = `
window.BOOKING_CLIENTS = {
  "techevo": { name: "TechEvolution", bookingUrl: "https://calendly.com/ctapper/meeting" },
  "newclient": { name: "New Client", bookingUrl: "https://calendly.com/new-client/30min" },
};
`;
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, text: async () => (calls === 1 ? stale : fresh) };
    };
    await refreshDestinations({ now: 1_000, fetchImpl });
    assert.equal(
      resolveAvailabilityBookingUrl({ booking_link: 'https://book.gosalesglider.com/newclient' }),
      ''
    );
    const url = await resolveLiveAvailabilityBookingUrl(
      { booking_link: 'https://book.gosalesglider.com/newclient' },
      { now: 1_100, fetchImpl }
    );
    assert.equal(url, 'https://calendly.com/new-client/30min');
    assert.ok(calls >= 2, 'missing slug must refetch live clients.js');
  });

  it('recognizes both public wrap hosts', () => {
    assert.equal(slugFromWrapUrl('https://book.gosalesglider.com/bolder'), 'bolder');
    assert.equal(slugFromWrapUrl('https://book.salesglidergrowth.com/parlay'), 'parlay');
    assert.equal(isBookingBridgeWrap('https://calendly.com/randyhaba/30min'), false);
  });
});
