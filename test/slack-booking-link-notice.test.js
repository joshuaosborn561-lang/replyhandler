const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  bookingLinkMrkdwn,
  ccAutoNoticeBlock,
} = require('../src/services/slack');

describe('bookingLinkMrkdwn', () => {
  it('returns clickable Slack link for http URLs', () => {
    const link = 'https://calendly.com/joshua-salesglidergrowth/30min';
    assert.equal(
      bookingLinkMrkdwn(link),
      `<${link}|Booking link>`,
    );
  });

  it('escapes unsafe characters in the URL', () => {
    assert.equal(
      bookingLinkMrkdwn('https://cal.com/x?a=1&b=2'),
      '<https://cal.com/x?a=1&amp;b=2|Booking link>',
    );
  });

  it('returns empty string when link is missing or not http', () => {
    assert.equal(bookingLinkMrkdwn(''), '');
    assert.equal(bookingLinkMrkdwn('   '), '');
    assert.equal(bookingLinkMrkdwn('ftp://example.com'), '');
    assert.equal(bookingLinkMrkdwn('not-a-url'), '');
  });
});

describe('ccAutoNoticeBlock booking link', () => {
  it('appends booking link beside Always notify when both are set', () => {
    const block = ccAutoNoticeBlock({
      ccEmails: 'ops@client.com',
      bookingLink: 'https://calendly.com/client/30min',
    });
    assert.ok(block);
    const text = block.elements[0].text;
    assert.match(text, /\*Always notify:\* ops@client\.com/);
    assert.match(text, /· <https:\/\/calendly\.com\/client\/30min\|Booking link>/);
  });

  it('shows booking link alone when no notify emails are configured', () => {
    const block = ccAutoNoticeBlock({
      bookingLink: 'https://cal.com/client/meet',
    });
    assert.ok(block);
    const text = block.elements[0].text;
    assert.match(text, /\*Booking link:\* <https:\/\/cal\.com\/client\/meet\|Booking link>/);
    assert.doesNotMatch(text, /\*Always notify:/);
  });

  it('returns null when there is nothing to show', () => {
    assert.equal(ccAutoNoticeBlock({}), null);
    assert.equal(ccAutoNoticeBlock({ ccEmails: '  ' }), null);
    assert.equal(ccAutoNoticeBlock({ bookingLink: 'not-http' }), null);
  });

  it('keeps round-robin line separate from booking link on Always notify', () => {
    const block = ccAutoNoticeBlock({
      ccEmails: 'always@client.com',
      ccRoundRobinEmails: 'a@client.com, b@client.com',
      bookingLink: 'https://calendly.com/client/30min',
    });
    const text = block.elements[0].text;
    assert.match(text, /\*Always notify:\* always@client\.com · <https:\/\/calendly\.com\/client\/30min\|Booking link>/);
    assert.match(text, /\*Round-robin \(1 per send\):\* a@client\.com, b@client\.com/);
  });
});
