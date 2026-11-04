'use strict';

// Josh, Nov 4 2026: a CC he picked also sends one heads-up from his Gmail.
// Plain Approve does not. The prospect is never a recipient. One CC event sends once.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const smartlead = require('../src/services/smartlead');
const clientClaimed = require('../src/services/client-claimed');
const gmail = require('../src/services/gmail-send');
const { sendReplyToPlatform } = require('../src/services/reply-send');
const headsUp = require('../src/services/cc-heads-up-email');

const CLIENT = {
  id: 'c1',
  name: 'Example Client',
  smartlead_api_key: 'k',
  notify_emails: 'owner@client.test, ops@client.test',
  cc_emails: 'portal@client.test',
  cc_email: 'legacy@client.test',
  contact_email: 'contact@client.test',
};
const REPLY = {
  id: 'r1',
  platform: 'smartlead',
  classification: 'INTERESTED',
  client_id: 'c1',
  follow_up_id: null,
  lead_email: 'prospect@example.test',
  lead_name: 'Prospect Example',
  lead_full_name: 'Prospect Example',
  lead_company: 'Example Co',
  campaign_id: '9',
  lead_id: '123',
  smartlead_email_stats_id: 'stats1',
  inbound_message: 'Yes, interested.',
  sent_reply: null,
  created_at: '2026-11-04T15:00:00Z',
  updated_at: '2026-11-04T16:00:00Z',
};
const HISTORY = {
  history: [
    { type: 'SENT', stats_id: 'stats1', from: 'inbox@sender.test', to: 'prospect@example.test', time: '2026-11-04T14:00:00Z', email_body: 'Hello' },
    { type: 'SENT', stats_id: 'later', from: 'other@sender.test', to: 'prospect@example.test', time: '2026-11-04T18:00:00Z', email_body: 'Later' },
    { type: 'REPLY', from: 'prospect@example.test', to: 'inbox@sender.test', time: '2026-11-04T15:00:00Z', email_body: 'Yes, interested.' },
  ],
};

describe('CC heads-up email', () => {
  const orig = {};
  let sent;
  let mails;
  let headsUpClaimed;

  beforeEach(() => {
    sent = [];
    mails = [];
    headsUpClaimed = false;
    orig.query = db.query;
    orig.connect = db.connect;
    orig.assert = clientClaimed.assertNotClaimedOrThrow;
    orig.sendReply = smartlead.sendReply;
    orig.history = smartlead.getThreadHistory;
    orig.accounts = smartlead.listEmailAccounts;
    orig.isConfigured = gmail.isConfigured;
    orig.sendMail = gmail.sendMail;
    orig.mode = process.env.PROSPECT_REPLY_NOTIFY_MODE;
    delete process.env.PROSPECT_REPLY_NOTIFY_MODE;

    db.connect = async () => ({
      query: async (sql) => (/FROM pending_replies WHERE id = \$1/.test(sql)
        ? { rows: [{ ...REPLY, status: 'approved' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      release() {},
    });
    db.query = async (sql, params = []) => {
      if (/cc_heads_up_sent_at = now\(\)/.test(sql) && /cc_heads_up_sent_at IS NULL/.test(sql)) {
        if (headsUpClaimed) return { rows: [], rowCount: 0 };
        headsUpClaimed = true;
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (/cc_heads_up_sent_at = NULL/.test(sql)) {
        headsUpClaimed = false;
        return { rows: [], rowCount: 1 };
      }
      if (/SET client_digest_status = 'pending'/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [{ id: 'r1' }], rowCount: 1 };
    };
    clientClaimed.assertNotClaimedOrThrow = async () => {};
    smartlead.sendReply = async (_k, _c, _l, opts) => { sent.push(opts); };
    smartlead.getThreadHistory = async () => HISTORY;
    smartlead.listEmailAccounts = async () => [];
    gmail.isConfigured = () => true;
    gmail.sendMail = async (message) => { mails.push(message); return { from: 'joshua@salesglidergrowth.com' }; };
  });

  afterEach(() => {
    db.query = orig.query;
    db.connect = orig.connect;
    clientClaimed.assertNotClaimedOrThrow = orig.assert;
    smartlead.sendReply = orig.sendReply;
    smartlead.getThreadHistory = orig.history;
    smartlead.listEmailAccounts = orig.accounts;
    gmail.isConfigured = orig.isConfigured;
    gmail.sendMail = orig.sendMail;
    if (orig.mode === undefined) delete process.env.PROSPECT_REPLY_NOTIFY_MODE;
    else process.env.PROSPECT_REPLY_NOTIFY_MODE = orig.mode;
  });

  it('CC heads-up does not send unless Josh picked CC, does not go to the prospect, and does not send twice for one CC event', async () => {
    const plain = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: false });
    assert.equal(mails.length, 0);
    assert.equal(plain.ccHeadsUpSent, undefined);
    assert.equal(sent.length, 1);
    assert.equal(!sent[0].cc || !/owner@client\.test/.test(sent[0].cc), true);

    const cc = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: true });
    assert.equal(mails.length, 1);
    assert.equal(cc.ccHeadsUpSent, true);
    assert.deepEqual(mails[0].to, ['owner@client.test', 'ops@client.test']);
    assert.ok(!mails[0].to.includes('prospect@example.test'));
    assert.ok(!mails[0].to.includes('portal@client.test'));
    assert.match(mails[0].textBody, /Hey, we just CC'd you on a reply to Prospect Example at Example Co\./);
    assert.match(mails[0].textBody, /It came from inbox@sender\.test\./);
    assert.match(mails[0].textBody, /It's probably in your spam, so check there and mark it not-spam\./);
    assert.doesNotMatch(`${mails[0].subject}\n${mails[0].textBody}`, /Hot lead/i);
    assert.match(sent[1].cc, /owner@client\.test/);
    assert.doesNotMatch(sent[1].cc, /prospect@example\.test/);

    const again = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good again', { ccClientOnProspect: true });
    assert.equal(mails.length, 1, 'one CC event sends the heads-up once');
    assert.equal(again.ccHeadsUpSent, undefined);
  });

  it('the sending inbox is the mailbox we replied to, and the prospect is dropped even if listed', () => {
    assert.equal(headsUp.sendingInboxFromThread(HISTORY, 'stats1'), 'inbox@sender.test');
    assert.equal(headsUp.sendingInboxFromThread({ history: [] }, null), '');
    const to = headsUp.headsUpRecipients(
      'owner@client.test, prospect@example.test, inbox@sender.test',
      REPLY,
      'inbox@sender.test',
    );
    assert.deepEqual(to, ['owner@client.test']);
  });
});
