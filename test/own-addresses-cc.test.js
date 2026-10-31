const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isOwnAddress, filterOwnAddresses } = require('../src/utils/own-addresses');
const { buildReplyAll } = require('../src/utils/reply-all');
const { extractReferredContacts, parseReferralCcInput } = require('../src/utils/referred-contact');
const { clientContactEmails, alwaysForwardEmailsForProspectCc } = require('../src/services/client-cc');
const { noticeRecipients } = require('../src/services/cc-notice-email');
const slack = require('../src/services/slack');

describe('own addresses are never client contacts', () => {
  it('knows Josh, Cayden, the primary Gmail, our domains, and plus/dot variants', () => {
    for (const e of [
      'joshua@salesglidergrowth.com', 'Joshua@SalesGliderGrowth.com', 'cayden@salesglidergrowth.com',
      'joshua+leads@salesglidergrowth.com', 'anyone@salesglidergrowth.com', 'x@gosalesglider.com',
      'Joshua <joshua@salesglidergrowth.com>',
    ]) assert.equal(isOwnAddress(e), true, e);
    for (const e of ['owner@acme.test', 'kyle@roofsbypeterson.com', '', 'nope']) {
      assert.equal(isOwnAddress(e), false, e);
    }
  });

  it('reads extra self addresses (Josh personal Gmail) from OWN_ADDRESSES, dots and +tags ignored', () => {
    const env = { OWN_ADDRESSES: 'josh.o@gmail.com' };
    assert.equal(isOwnAddress('joshO@gmail.com', { env }), true);
    assert.equal(isOwnAddress('josh.o+x@googlemail.com', { env }), true);
    assert.equal(isOwnAddress('other@gmail.com', { env }), false);
  });

  it('PRIMARY_GMAIL_FROM and the booked/FYI addresses count as ours', () => {
    const env = { PRIMARY_GMAIL_FROM: 'ops@weird-domain.test', FYI_CC_EMAILS: 'a@fyi.test, b@fyi.test' };
    assert.equal(isOwnAddress('OPS@weird-domain.test', { env }), true);
    assert.equal(isOwnAddress('b@fyi.test', { env }), true);
  });

  it('filterOwnAddresses lowercases, dedupes case-insensitively and drops ours', () => {
    assert.deepEqual(
      filterOwnAddresses('Owner@Acme.test, owner@acme.test; joshua@salesglidergrowth.com, ops@acme.test'),
      ['owner@acme.test', 'ops@acme.test'],
    );
  });
});

describe('reply-all card line / CC never lists Josh', () => {
  const history = {
    history: [
      { type: 'SENT', from: 'ae@sender-one.test', to: 'pat@lead.test', time: '2026-10-29T10:00:00Z' },
      {
        type: 'REPLY', from: 'Pat <pat@lead.test>', to: 'ae@sender-one.test, joshua@salesglidergrowth.com',
        cc: 'Cayden@SalesGliderGrowth.com, sam@lead.test, SAM@lead.test', time: '2026-10-29T11:00:00Z',
        message_id: '<m1@lead.test>',
      },
    ],
  };
  it('drops Josh and Cayden and keeps real humans, deduped', () => {
    const r = buildReplyAll({ history, accountEmails: ['ae@sender-one.test'], originalLeadEmail: 'pat@lead.test' });
    assert.equal(r.recipient, 'pat@lead.test');
    assert.deepEqual(r.cc, ['sam@lead.test']);
  });
});

describe('referral CC never offers our own address', () => {
  it('extractReferredContacts skips Josh', () => {
    const raw = 'I have looped in joshua@salesglidergrowth.com and also talk to Dana at dana@lead.test please.';
    const out = extractReferredContacts(raw, { prospectEmail: 'pat@lead.test', prospectName: 'Pat Lead' });
    assert.deepEqual(out.map((c) => c.email), ['dana@lead.test']);
  });
  it('parseReferralCcInput refuses a field that is only Josh', () => {
    const r = parseReferralCcInput('joshua@salesglidergrowth.com', { prospectEmail: 'pat@lead.test' });
    assert.ok(r.error);
    const ok = parseReferralCcInput('joshua@salesglidergrowth.com, dana@lead.test', { prospectEmail: 'pat@lead.test' });
    assert.deepEqual(ok.emails, ['dana@lead.test']);
  });
});

describe('client CC list (checkbox label + recipients)', () => {
  const client = {
    notify_emails: 'Owner@Acme.test, owner@acme.test, joshua@salesglidergrowth.com, cayden@salesglidergrowth.com, '
      + 'lead@prospect.test, ae@sender-one.test, bot@sender-one.test, ops@acme.test',
    cc_emails: 'portal@acme.test',
    contact_email: 'contact@acme.test',
  };
  it('keeps only real client contacts', () => {
    assert.deepEqual(
      clientContactEmails(client, {
        leadEmail: 'Lead@Prospect.test', exclude: ['ae@sender-one.test'], excludeDomains: ['sender-one.test'],
      }),
      ['owner@acme.test', 'ops@acme.test'],
    );
  });
  it('the checkbox text and Send + CC list use the same filtered list', () => {
    const csv = alwaysForwardEmailsForProspectCc(client, {
      leadEmail: 'lead@prospect.test', exclude: ['ae@sender-one.test'], excludeDomains: ['sender-one.test'],
    });
    assert.equal(csv, 'owner@acme.test, ops@acme.test');
    const blocks = slack.buildEditReplyBlocks({ initialDraft: 'Hey', ccClientEmails: csv });
    const b = blocks.find((x) => x.block_id === 'cc_client_block');
    assert.doesNotMatch(JSON.stringify(b), /joshua@|cayden@/i);
  });
  it('an old client record with only our own addresses gives an empty list (no checkbox)', () => {
    assert.equal(alwaysForwardEmailsForProspectCc({ notify_emails: 'joshua@salesglidergrowth.com' }), '');
  });
  it('portal CC and contact_email are not the manual CC list', () => {
    assert.equal(alwaysForwardEmailsForProspectCc({
      cc_emails: 'owner@acme.test', cc_email: 'owner@acme.test', contact_email: 'owner@acme.test',
    }), '');
  });
});

describe('heads-up recipients', () => {
  it('excludes Josh, Cayden, our domains, the lead, the sending inbox and sending domains; dedupes', () => {
    const to = noticeRecipients({
      ccEmails: 'owner@acme.test, OWNER@acme.test, joshua@salesglidergrowth.com, cayden@salesglidergrowth.com, '
        + 'lead@prospect.test, box@sender-two.test, other@sender-two.test, ops@acme.test',
      leadEmail: 'lead@prospect.test',
      exclude: ['joshua@salesglidergrowth.com', 'box@sender-two.test'],
      accountEmails: ['box@sender-two.test'],
    });
    assert.deepEqual(to, ['owner@acme.test', 'ops@acme.test']);
  });
  it('a client on gmail.com is not dropped just because Josh uses Gmail', () => {
    const to = noticeRecipients({
      ccEmails: 'owner@gmail.com', leadEmail: 'lead@prospect.test',
      exclude: ['joshua@salesglidergrowth.com'], accountEmails: [],
    });
    assert.deepEqual(to, ['owner@gmail.com']);
  });
});
