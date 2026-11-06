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
  VECTOR_PUBLIC_BOOKING_URL,
  VECTOR_CAL_DESTINATION,
  _resetLiveDestinationsForTests,
} = require('../src/utils/booking-bridge-destinations');
const { isCalendlyUrl } = require('../src/services/scheduling-slots');

describe('booking-bridge destinations', () => {
  beforeEach(() => {
    _resetLiveDestinationsForTests();
  });

  it('does not bake in a retired techevo wrap → Calendly fallback', () => {
    assert.equal(FALLBACK_DESTINATIONS.techevo, undefined);
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'TechEvolution',
        booking_link: 'https://book.gosalesglider.com/techevo',
      }),
      ''
    );
  });

  it('unwraps book.gosalesglider.com slugs to the real calendar', () => {
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

  it('parses live clients.js and prefers those destinations (except retired techevo)', async () => {
    const js = `
window.BOOKING_CLIENTS = {
  "techevo": {
    name: "TechEvolution",
    bookingUrl: "https://calendly.com/ctapper/new-destination",
    accent: "#5e35b1",
  },
  "parlay": {
    name: "Parlay",
    bookingUrl: "https://calendly.com/randyhaba/30min",
  },
};
`;
    assert.deepEqual(parseClientsJs(js).techevo, 'https://calendly.com/ctapper/new-destination');
    const map = await refreshDestinations({
      now: Date.now(),
      fetchImpl: async () => ({
        ok: true,
        text: async () => js,
      }),
    });
    assert.equal(map.techevo, undefined);
    assert.equal(map.parlay, 'https://calendly.com/randyhaba/30min');
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'TechEvolution',
        booking_link: 'https://book.gosalesglider.com/techevo',
      }, map),
      ''
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

  it('Vector Energy Group uses the wrap in front and Cal.com behind it', async () => {
    assert.equal(FALLBACK_DESTINATIONS.vector, VECTOR_CAL_DESTINATION);
    assert.equal(VECTOR_PUBLIC_BOOKING_URL, 'https://book.gosalesglider.com/vector');
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'Vector Energy Group',
        booking_link: 'https://book.gosalesglider.com/vector',
      }),
      VECTOR_CAL_DESTINATION
    );
    const fromRetired = normalizeClientBooking({
      name: 'Vector Energy Group',
      booking_link: 'https://book.gosalesglider.com/vector',
      booking_destination_url: 'https://tidycal.com/team/vector-energy-group/intro-call',
    });
    assert.equal(fromRetired.booking_link, VECTOR_PUBLIC_BOOKING_URL);
    assert.equal(fromRetired.booking_destination_url, VECTOR_CAL_DESTINATION);
    const pasted = normalizeClientBooking({
      name: 'Vector Energy Group',
      booking_link: 'https://tidycal.com/team/vector-energy-group/intro-call',
    });
    assert.equal(pasted.booking_link, VECTOR_PUBLIC_BOOKING_URL);
    assert.equal(pasted.booking_destination_url, VECTOR_CAL_DESTINATION);

    const stale = `
window.BOOKING_CLIENTS = {
  "vector": { name: "Vector Energy Group", bookingUrl: "https://tidycal.com/team/vector-energy-group/intro-call" },
  "bpltg": { name: "BPLTG", bookingUrl: "https://tidycal.com/team/bpltg/intro-call" },
};
`;
    const map = await refreshDestinations({
      now: Date.now(),
      force: true,
      fetchImpl: async () => ({ ok: true, text: async () => stale }),
    });
    assert.equal(map.vector, VECTOR_CAL_DESTINATION);
    assert.equal(map.bpltg, 'https://tidycal.com/team/bpltg/intro-call');
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'Vector Energy Group',
        booking_link: 'https://book.gosalesglider.com/vector',
      }, map),
      VECTOR_CAL_DESTINATION
    );
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'BPLTG',
        booking_link: 'https://book.gosalesglider.com/bpltg',
        booking_destination_url: 'https://tidycal.com/team/bpltg/intro-call',
      }, map),
      'https://tidycal.com/team/bpltg/intro-call'
    );
  });

  it('recognizes both public wrap hosts', () => {
    assert.equal(slugFromWrapUrl('https://book.gosalesglider.com/bolder'), 'bolder');
    assert.equal(slugFromWrapUrl('https://book.salesglidergrowth.com/parlay'), 'parlay');
    assert.equal(isBookingBridgeWrap('https://calendly.com/randyhaba/30min'), false);
  });
});
