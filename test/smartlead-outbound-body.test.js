const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const smartlead = require('../src/services/smartlead');
const {
  prepareSmartleadReplyText,
  shouldAppendSmartleadMailboxSignature,
  isAgencySendingInbox,
  draftSignOffWasStripped,
} = require('../src/utils/smartlead-outbound-body');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CIOTOLA = { name: 'Jeremy Ciotola' };
const PARLAY = { name: 'Parlay Tech' };
const JEREMY_INBOX = 'jciotola@getjeremyciotola.info';
const PARLAY_INBOX = 'myles@parlaytech.io';
const AGENCY_INBOX = 'joshua@salesglidergrowth.com';

test('prepareSmartleadReplyText strips draft sign-offs for every client (Parlay pattern)', () => {
  const draft = 'Happy to send times.\n\nBest,\nMyles';
  const out = prepareSmartleadReplyText(draft, {
    client: PARLAY,
    sendingInboxEmail: PARLAY_INBOX,
  });
  assert.equal(out, 'Happy to send times.');
  assert.ok(draftSignOffWasStripped(draft, out));
});

test('Ciotola client inbox: stacked names and SalesGlider lines removed from body', () => {
  const draft = [
    'Sounds good — I can do Thursday afternoon.',
    '',
    'Jeremy',
    'Jeremy',
    'Jeremy Ciotola',
    'SalesGlider',
  ].join('\n');
  const out = prepareSmartleadReplyText(draft, {
    client: CIOTOLA,
    sendingInboxEmail: JEREMY_INBOX,
  });
  assert.equal(out, 'Sounds good — I can do Thursday afternoon.');
  assert.doesNotMatch(out, /SalesGlider/i);
  assert.doesNotMatch(out, /\bJeremy\b/);
});

test('client pod inboxes never request SmartLead add_signature (Ciotola + Parlay)', () => {
  assert.equal(isAgencySendingInbox(JEREMY_INBOX), false);
  assert.equal(isAgencySendingInbox(PARLAY_INBOX), false);
  assert.equal(
    shouldAppendSmartleadMailboxSignature({ sendingInboxEmail: JEREMY_INBOX }),
    false,
  );
  assert.equal(
    shouldAppendSmartleadMailboxSignature({ sendingInboxEmail: PARLAY_INBOX }),
    false,
  );
});

test('agency SalesGlider inbox keeps add_signature after draft sign-off is stripped', () => {
  assert.equal(isAgencySendingInbox(AGENCY_INBOX), true);
  assert.equal(
    shouldAppendSmartleadMailboxSignature({ sendingInboxEmail: AGENCY_INBOX }),
    true,
  );
  const draft = 'Does Tuesday work?\n\nBest,\nJosh';
  const out = prepareSmartleadReplyText(draft, { client: { name: 'SalesGlider' }, sendingInboxEmail: AGENCY_INBOX });
  assert.equal(out, 'Does Tuesday work?');
});

test('SmartLead sendReply: client inbox add_signature false, agency inbox true', async () => {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, text: async () => JSON.stringify({ success: true }) };
  };
  try {
    await smartlead.sendReply('test-key', 4289735, 4812345678, {
      replyText: 'Quick bump.\n\nJeremy',
      emailStatsId: 'stats-1',
      outboundClient: CIOTOLA,
      sendingInboxEmail: JEREMY_INBOX,
    });
    assert.equal(calls[0].body.add_signature, false);

    calls.length = 0;
    await smartlead.sendReply('test-key', 11, 22, {
      replyText: 'Sure thing.\n\nBest,\nMyles',
      emailStatsId: 'stats-2',
      outboundClient: PARLAY,
      sendingInboxEmail: PARLAY_INBOX,
    });
    assert.equal(calls[0].body.add_signature, false);
    assert.doesNotMatch(calls[0].body.email_body, /Myles/i);

    calls.length = 0;
    await smartlead.sendReply('test-key', 3739758, 33, {
      replyText: 'Thursday works.\n\nJosh',
      emailStatsId: 'stats-3',
      outboundClient: { name: 'SalesGlider' },
      sendingInboxEmail: AGENCY_INBOX,
    });
    assert.equal(calls[0].body.add_signature, true);
    assert.doesNotMatch(calls[0].body.email_body, /\bJosh\b/);
  } finally {
    global.fetch = orig;
  }
});

test('reply-send passes sending inbox into SmartLead send opts', () => {
  const src = read('src/services/reply-send.js');
  assert.match(src, /sendingInboxFromThread/);
  assert.match(src, /sendOpts\.outboundClient = client/);
  assert.match(src, /sendOpts\.sendingInboxEmail = sendingInboxEmail/);
});

test('our drafts add no sign-off; mailbox signature only on agency inboxes', () => {
  const smartleadSrc = read('src/services/smartlead.js');
  assert.match(smartleadSrc, /add_signature:\s*appendSig/);
  assert.match(smartleadSrc, /shouldAppendSmartleadMailboxSignature/);
  assert.match(smartleadSrc, /isAgencySendingInbox|shouldAppendSmartleadMailboxSignature/);
});
