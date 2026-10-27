const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { promoteReferral } = require('../src/routes/webhooks');
const { looksLikeAutomatedNotice, slackSuppressionReason } = require('../src/utils/smartlead-webhook-helpers');
const { slackChannelSuppressionReason } = require('../src/utils/slack-channel-policy');

// Dead-mailbox and departure auto-replies that named an address were promoted
// to INTERESTED "Referral reply" cards (the poller re-carded a week of them in
// one pass). DECISIONS.md: automated notices never promote, with or without an
// address in the text.
const DEAD_MAILBOX = [
  'Please note that the email address you tried to reach is no longer in use. If you need assistance, please contact team@example-co.test .',
  'Thank you for your message. This email account is no longer active. For additional information please contact Pat at pat@example-co.test or Sam at sam@example-co.test',
  'Thank you for your email. Please note that this inbox is no longer being monitored. For all billing requests, please contact AR at ar@example-co.test.',
  'This email is not regularly monitored. For estimating or general messages, send them to estimating@example-co.test.',
  'The email address for a former employee is no longer active or monitored. If you need to reach someone immediately, please contact the main office or lee@example-co.test.',
  'Thank you for your email. This account is no longer active. Please reach out to the following: Operations - a@example-co.test, Finance - b@example-co.test',
  'Thank you for reaching out. Please note this email box is no longer active. For any inquiries, kindly direct your emails to our new director at dir@example-co.test.',
  'A former rep is no longer part of our team. This mailbox is not monitored, if you need assistance please email info@example-co.test',
  'Hello, thank you for contacting us. A former rep is no longer a sales representative here. We ask that clients please contact us at help@example-co.test',
];

// A person who is still there handing us to a colleague stays a card.
const LIVE_REFERRAL = 'Hi please talk to Guy at our office. guy@example-co.test';

describe('dead-mailbox and departure auto-replies are automated notices', () => {
  for (const body of DEAD_MAILBOX) {
    it(body.slice(0, 60), () => {
      assert.equal(looksLikeAutomatedNotice(body), true);
      assert.equal(slackSuppressionReason(body), 'automated_notice');
      assert.equal(
        slackChannelSuppressionReason({ classification: 'INTERESTED', inboundMessage: body }),
        'automated_notice',
      );
      for (const c of ['OTHER', 'NOT_INTERESTED', 'WRONG_PERSON', 'INTERESTED']) {
        assert.equal(promoteReferral(c, body).promoted, false, c);
        assert.deepEqual(promoteReferral(c, body).referredContacts, [], c);
      }
    });
  }

  it('a live person who names a colleague and types the address is still a referral card', () => {
    assert.equal(looksLikeAutomatedNotice(LIVE_REFERRAL), false);
    const ref = promoteReferral('NOT_INTERESTED', LIVE_REFERRAL, {
      prospectEmail: 'someone@example-co.test',
      ourEmails: ['us@example-us.test'],
    });
    assert.equal(ref.promoted, true);
    assert.equal(ref.referredContacts.length, 1);
  });
});
