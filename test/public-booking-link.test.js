const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  prospectBookingLink,
  rewriteRawCtapperCalendly,
  isTechEvolutionClient,
  TECHEVO_PUBLIC_BOOKING_URL,
} = require('../src/utils/public-booking-link');

describe('public booking-link wrap', () => {
  it('pins Tech Evolution names to book.gosalesglider.com/techevo', () => {
    assert.equal(isTechEvolutionClient('TechEvolution'), true);
    assert.equal(isTechEvolutionClient('TechEvo'), true);
    assert.equal(isTechEvolutionClient({ name: 'TechEvolution MSP' }), true);
    assert.equal(isTechEvolutionClient('Bolder Cyber Partners'), false);
    assert.equal(isTechEvolutionClient('Goliath'), false);

    assert.equal(
      prospectBookingLink({ clientName: 'TechEvolution', bookingLink: '' }),
      TECHEVO_PUBLIC_BOOKING_URL
    );
    assert.equal(
      prospectBookingLink({
        clientName: 'TechEvo',
        bookingLink: 'https://calendly.com/ctapper/new-meeting',
      }),
      TECHEVO_PUBLIC_BOOKING_URL
    );
  });

  it('rewrites a stored Corey Calendly URL even without a client name', () => {
    assert.equal(
      prospectBookingLink({
        bookingLink: 'https://calendly.com/ctapper/meeting',
      }),
      TECHEVO_PUBLIC_BOOKING_URL
    );
  });

  it('leaves other clients on their stored booking_link', () => {
    assert.equal(
      prospectBookingLink({
        clientName: 'Goliath',
        bookingLink: 'https://book.gosalesglider.com/goliath',
      }),
      'https://book.gosalesglider.com/goliath'
    );
    assert.equal(
      prospectBookingLink({
        clientName: 'Bolder Cyber Partners',
        bookingLink: 'https://book.gosalesglider.com/bolder',
      }),
      'https://book.gosalesglider.com/bolder'
    );
    assert.equal(
      prospectBookingLink({
        clientName: 'Parlay Tech',
        bookingLink: 'https://calendly.com/parlay/30min',
      }),
      'https://calendly.com/parlay/30min'
    );
  });

  it('strips leaked ctapper Calendly on times-first; swaps on link-request', () => {
    const leaked = 'Tuesday works. https://calendly.com/ctapper/meeting thanks';
    assert.doesNotMatch(
      rewriteRawCtapperCalendly(leaked, { includeBookingLink: false }),
      /calendly\.com\/ctapper/
    );
    const swapped = rewriteRawCtapperCalendly(leaked, { includeBookingLink: true });
    assert.match(swapped, /book\.gosalesglider\.com\/techevo/);
    assert.doesNotMatch(swapped, /calendly\.com\/ctapper/);
  });
});
