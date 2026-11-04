'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseProspectName,
  hostIdentityFromBookingUrl,
  identitiesForClient,
  prospectDisplayName,
  shouldDropProspectName,
} = require('../src/utils/meeting-prospect-name');
const { assembleBriefFacts, buildClientDayofBrief } = require('../src/services/client-dayof-brief');

const CONTACT = 'Casey Owner';
const BOOKER = 'Pat Example';
const BOOKER_EMAIL = 'pat.example@school.example';
const CONTACT_EMAIL = 'casey.owner@client.example';
const HOST_URL = 'https://meetings.hubspot.com/casey-owner';

describe('meeting email names the booker, not the client contact', () => {
  it('drops a payload name that is the notify mailbox or the booking host', () => {
    const identities = identitiesForClient({
      name: 'Fixture Client',
      notify_emails: CONTACT_EMAIL,
      booking_destination_url: HOST_URL,
    });
    assert.equal(shouldDropProspectName(CONTACT, BOOKER_EMAIL, identities), true);
    assert.equal(shouldDropProspectName(BOOKER, BOOKER_EMAIL, identities), false);
    assert.equal(
      chooseProspectName({
        given: CONTACT,
        email: BOOKER_EMAIL,
        alternatives: [BOOKER],
        identities,
      }),
      BOOKER,
    );
  });

  it('keeps a name that matches the prospect email, including when the local part matches a contact', () => {
    const identities = identitiesForClient({ notify_emails: 'pat.example@client.example' });
    assert.equal(shouldDropProspectName(BOOKER, BOOKER_EMAIL, identities), false);
  });

  it('a role mailbox is not a contact name', () => {
    const identities = identitiesForClient({ notify_emails: 'sales@client.example' });
    assert.equal(shouldDropProspectName('Sales Lead', 'sam.lead@buyer.example', identities), false);
  });

  it('reads the host slug from a scheduler page and ignores a duration slug', () => {
    assert.equal(hostIdentityFromBookingUrl(HOST_URL), 'casey owner');
    assert.equal(hostIdentityFromBookingUrl('https://calendly.com/casey-owner/30min'), 'casey owner');
    assert.equal(hostIdentityFromBookingUrl('https://calendly.com/30min'), '');
  });

  it('the day-of brief uses the reply name and leaves the contact out of the subject', () => {
    const row = {
      client_name: 'Fixture Client',
      notify_emails: CONTACT_EMAIL,
      booking_destination_url: HOST_URL,
      lead_name: CONTACT,
      lead_full_name: BOOKER,
      lead_email: BOOKER_EMAIL,
      lead_company: 'North School',
      confirmed_time: '2026-11-04T18:00:00.000Z',
      digest_timezone: 'America/Chicago',
    };
    const facts = assembleBriefFacts(row);
    assert.equal(facts.prospect.name, BOOKER);
    const brief = buildClientDayofBrief(facts);
    assert.match(brief.subject, new RegExp(`^Brief: ${BOOKER} and Fixture Client`));
    assert.equal(brief.subject.includes(CONTACT), false);
    assert.equal(prospectDisplayName({ ...row, lead_full_name: CONTACT, lead_name: CONTACT }), '');
  });
});
