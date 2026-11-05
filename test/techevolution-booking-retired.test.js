const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildBookingCatalogClients } = require('../src/routes/public-booking-catalog');
const { fallbackDraftText, sanitizeDraft } = require('../src/services/classifier');
const { prospectBookingLink } = require('../src/utils/public-booking-link');
const {
  resolveAvailabilityBookingUrl,
  refreshDestinations,
  _resetLiveDestinationsForTests,
} = require('../src/utils/booking-bridge-destinations');
const { shouldIncludeBookingLink } = require('../src/utils/meeting-modality');

describe('Tech Evolution booking retirement', () => {
  it('omits techevo from GET /public/booking-clients overlay even with stale DB URLs', () => {
    const clients = buildBookingCatalogClients([
      {
        name: 'TechEvolution',
        booking_link: 'https://book.gosalesglider.com/techevo',
        booking_destination_url: 'https://calendly.com/ctapper/meeting',
      },
      {
        name: 'Parlay Tech',
        booking_link: 'https://book.gosalesglider.com/parlay',
        booking_destination_url: 'https://calendly.com/randyhaba/30min',
      },
    ]);
    assert.equal(clients.techevo, undefined);
    assert.equal(clients.parlay.bookingUrl, 'https://calendly.com/randyhaba/30min');
    assert.equal(clients.parlay.name, 'Parlay Tech');
  });

  it('does not resolve availability from live clients.js, fallback, or stale destination column', async () => {
    _resetLiveDestinationsForTests();
    const staleRow = {
      name: 'TechEvolution',
      booking_link: 'https://book.gosalesglider.com/techevo',
      booking_destination_url: 'https://calendly.com/ctapper/meeting',
    };
    assert.equal(resolveAvailabilityBookingUrl(staleRow), '');

    const js = `
window.BOOKING_CLIENTS = {
  "techevo": { name: "TechEvolution", bookingUrl: "https://calendly.com/ctapper/meeting" },
  "parlay": { name: "Parlay", bookingUrl: "https://calendly.com/randyhaba/30min" },
};
`;
    const map = await refreshDestinations({
      now: Date.now(),
      force: true,
      fetchImpl: async () => ({ ok: true, text: async () => js }),
    });
    assert.equal(map.techevo, undefined);
    assert.equal(
      resolveAvailabilityBookingUrl(staleRow, map),
      ''
    );
    assert.equal(
      resolveAvailabilityBookingUrl({
        name: 'Parlay Tech',
        booking_link: 'https://book.gosalesglider.com/parlay',
      }, map),
      'https://calendly.com/randyhaba/30min'
    );
  });

  it('never offers a booking link in draft paths for Tech Evolution', () => {
    assert.equal(shouldIncludeBookingLink('', 'TechEvolution'), false);
    assert.equal(
      prospectBookingLink({
        clientName: 'TechEvo',
        bookingLink: 'https://book.gosalesglider.com/techevo',
      }),
      ''
    );
    assert.equal(
      prospectBookingLink({
        clientName: 'TechEvolution',
        bookingLink: 'https://calendly.com/ctapper/meeting',
      }),
      ''
    );

    const draft = fallbackDraftText({
      leadName: 'Dan',
      inboundMessage: 'send me the link',
      includeBookingLink: true,
      clientName: 'TechEvo',
      bookingLink: 'https://calendly.com/ctapper/meeting',
    });
    assert.ok(!/book\.gosalesglider\.com\/techevo/.test(draft));
    assert.ok(!/calendly\.com\/ctapper/i.test(draft));

    const leaked = sanitizeDraft(
      'Sure — grab a time here: https://calendly.com/ctapper/meeting',
      {
        bookingLink: 'https://book.gosalesglider.com/techevo',
        includeBookingLink: true,
        clientName: 'TechEvolution',
      }
    );
    assert.ok(!/book\.gosalesglider\.com\/techevo/.test(leaked));
    assert.ok(!/calendly\.com\/ctapper/i.test(leaked));
  });

  it('does not change Parlay booking links', () => {
    assert.equal(
      prospectBookingLink({
        clientName: 'Parlay Tech',
        bookingLink: 'https://book.gosalesglider.com/parlay',
      }),
      'https://book.gosalesglider.com/parlay'
    );
  });
});
