const test = require('node:test');
const assert = require('node:assert');
const { phoneFromReplyText } = require('../src/utils/lead-phone');
const { applyCardLinks } = require('../src/services/slack-reply-post');

test('a phone in the prospect text is kept and a quoted number is not', () => {
  assert.match(phoneFromReplyText('Call me at (305) 555-0199 tomorrow.'), /305/);
  assert.match(phoneFromReplyText('mobile: +1 305 555 0199'), /305/);
  assert.match(phoneFromReplyText('cell: (951) 823-9296'), /951/);
  assert.equal(
    phoneFromReplyText('Thanks.\nOn Tue, Nov 3, 2026 Sam wrote:\ncell: (951) 823-9296'),
    '',
  );
  assert.equal(phoneFromReplyText('no number in this note'), '');
  assert.equal(phoneFromReplyText('order 12345'), '');
  assert.equal(
    phoneFromReplyText('Sounds good.\nOn Tue, Nov 3, 2026 Sam wrote:\ncall 404-555-0177'),
    '',
  );
  assert.equal(
    phoneFromReplyText('> 212-555-0148\nI can talk Thursday.'),
    '',
  );
  const own = phoneFromReplyText('I can talk Thursday. My cell is 305-555-0199.\n> 212-555-0148');
  assert.match(own, /305/);
  assert.doesNotMatch(own, /212/);
});

test('a manual phone wins over enrichment on the card, and reply text fills an empty phone', () => {
  const locked = applyCardLinks(
    { leadPhone: '+15555550123', phoneProvider: 'manual', inboundMessage: 'call 212-555-0100' },
    {},
    { phone: '+15555550999', phoneProvider: 'fullenrich' },
  );
  assert.equal(locked.leadPhone, '+15555550123');
  assert.equal(locked.phoneProvider, 'manual');

  const parsed = applyCardLinks(
    { inboundMessage: 'Please call 305-555-0199.' },
    {},
    {},
  );
  assert.match(parsed.leadPhone, /305/);
  assert.equal(parsed.phoneProvider, 'reply_text');

  const stored = applyCardLinks(
    { leadPhone: '+15555550100', phoneProvider: 'source', inboundMessage: 'call 305-555-0199' },
    {},
    {},
  );
  assert.equal(stored.leadPhone, '+15555550100');
  assert.equal(stored.phoneProvider, 'source');
});
