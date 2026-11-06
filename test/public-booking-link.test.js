const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  prospectBookingLink,
  isTechEvolutionClient,
  rewriteRawCtapperCalendly,
} = require('../src/utils/public-booking-link');

describe('public booking-link wrap', () => {
  it('detects Tech Evolution client names but emits no booking URL (retired)', () => {
    assert.equal(isTechEvolutionClient('TechEvolution'), true);
    assert.equal(isTechEvolutionClient('TechEvo'), true);
    assert.equal(isTechEvolutionClient({ name: 'TechEvolution MSP' }), true);
    assert.equal(isTechEvolutionClient('Bolder Cyber Partners'), false);
    assert.equal(
      prospectBookingLink({ clientName: 'TechEvolution', bookingLink: '' }),
      ''
    );
    assert.equal(
      prospectBookingLink({
        clientName: 'TechEvo',
        bookingLink: 'https://calendly.com/ctapper/new-meeting',
      }),
      ''
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
  });

  it('strips leaked ctapper Calendly and techevo wrap URLs', () => {
    const leaked = 'Tuesday works. https://calendly.com/ctapper/meeting thanks';
    assert.doesNotMatch(
      rewriteRawCtapperCalendly(leaked, { includeBookingLink: false }),
      /calendly\.com\/ctapper/
    );
    const wrap = 'Use https://book.gosalesglider.com/techevo please';
    assert.doesNotMatch(rewriteRawCtapperCalendly(wrap), /book\.gosalesglider\.com\/techevo/);
  });
});

describe('Vector Energy Group raw Calendly is wrapped to book.gosalesglider.com/vector', () => {
  it('wraps Vector raw Calendly to the public slug', () => {
    assert.equal(
      prospectBookingLink({
        clientName: 'Vector Energy Group',
        bookingLink: 'https://cal.com/team/intro-call/vector-energy-group',
      }),
      'https://book.gosalesglider.com/vector'
    );
    assert.equal(
      prospectBookingLink({
        clientName: 'Vector Energy Group',
        bookingLink: 'https://book.gosalesglider.com/vector',
      }),
      'https://book.gosalesglider.com/vector'
    );
  });
});
