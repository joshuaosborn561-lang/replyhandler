'use strict';

/**
 * Josh, Oct 31 2026: clients get the positive-reply roll-up and the meeting-booked
 * brief at notify_emails. A plain Approve does not CC the client. The Approve + CC
 * client button and the Edit modal checkbox still do, from notify_emails only.
 *
 * The day-of meeting brief is not sent from this repo.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../src/db');
const smartlead = require('../src/services/smartlead');
const clientClaimed = require('../src/services/client-claimed');
const { sendReplyToPlatform } = require('../src/services/reply-send');
const { digestRecipients } = require('../src/services/client-reply-digest');
const { resolveClientAlwaysCc } = require('../src/services/booked-meeting-email');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLIENT = {
  id: 'c1',
  name: 'Acme',
  smartlead_api_key: 'k',
  notify_emails: 'notify@client.test, second@client.test',
  cc_emails: 'cc@client.test',
  cc_email: 'legacy@client.test',
  contact_email: 'contact@client.test',
  cc_round_robin_emails: 'rep@client.test',
};

const REPLY = {
  id: 'r1',
  platform: 'smartlead',
  classification: 'INTERESTED',
  client_id: 'c1',
  lead_email: 'lead@prospect.test',
  lead_name: 'Pat',
  campaign_id: '9',
  lead_id: '123',
  smartlead_email_stats_id: 'stats1',
};

const THREAD_WITH_CLIENT = {
  history: [
    { type: 'SENT', from: 'ae@sender-one.test', to: 'lead@prospect.test', time: '2026-10-29T10:00:00Z' },
    {
      type: 'REPLY',
      from: 'Pat <lead@prospect.test>',
      to: 'ae@sender-one.test',
      cc: 'notify@client.test, cc@client.test, contact@client.test, legacy@client.test, sam@other.test',
      time: '2026-10-29T11:00:00Z',
      message_id: '<m1@lead.test>',
    },
  ],
};

describe('plain Approve does not CC the client', () => {
  const orig = {};
  let sent;
  beforeEach(() => {
    sent = [];
    orig.query = db.query;
    orig.connect = db.connect;
    orig.assert = clientClaimed.assertNotClaimedOrThrow;
    orig.sendReply = smartlead.sendReply;
    orig.history = smartlead.getThreadHistory;
    orig.accounts = smartlead.listEmailAccounts;
    orig.mode = process.env.PROSPECT_REPLY_NOTIFY_MODE;
    delete process.env.PROSPECT_REPLY_NOTIFY_MODE;
    db.connect = async () => ({
      query: async (sql) => (/FROM pending_replies WHERE id = \$1/.test(sql)
        ? { rows: [{ ...REPLY, status: 'approved' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      release() {},
    });
    db.query = async (sql) => {
      if (/client_digest_status = 'pending'/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [{ id: 'r1' }], rowCount: 1 };
    };
    clientClaimed.assertNotClaimedOrThrow = async () => {};
    smartlead.sendReply = async (_k, _c, _l, opts) => { sent.push(opts); };
    smartlead.getThreadHistory = async () => THREAD_WITH_CLIENT;
    smartlead.listEmailAccounts = async () => ['ae@sender-one.test'];
  });
  afterEach(() => {
    db.query = orig.query;
    db.connect = orig.connect;
    clientClaimed.assertNotClaimedOrThrow = orig.assert;
    smartlead.sendReply = orig.sendReply;
    smartlead.getThreadHistory = orig.history;
    smartlead.listEmailAccounts = orig.accounts;
    if (orig.mode === undefined) delete process.env.PROSPECT_REPLY_NOTIFY_MODE;
    else process.env.PROSPECT_REPLY_NOTIFY_MODE = orig.mode;
  });

  it('a plain Approve drops notify, CC, contact, and legacy addresses even when the thread CC includes them', async () => {
    const res = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: false });
    assert.equal(sent.length, 1);
    const cc = String(sent[0].cc || '').toLowerCase();
    assert.match(cc, /sam@other\.test/);
    for (const blocked of ['notify@client.test', 'second@client.test', 'cc@client.test', 'legacy@client.test', 'contact@client.test', 'rep@client.test']) {
      assert.equal(cc.includes(blocked), false, blocked);
    }
    assert.equal(res.prospectCcEmails, undefined);
  });

  it('Approve + CC client and the Edit checkbox use notify_emails only', async () => {
    const res = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: true });
    const cc = String(sent[0].cc || '').toLowerCase();
    assert.match(cc, /notify@client\.test/);
    assert.match(cc, /second@client\.test/);
    assert.match(cc, /sam@other\.test/);
    for (const blocked of ['cc@client.test', 'legacy@client.test', 'contact@client.test', 'rep@client.test']) {
      assert.equal(cc.includes(blocked), false, blocked);
    }
    assert.match(res.prospectCcEmails, /notify@client\.test/);
    const routes = read('src/routes/slack.js');
    assert.match(routes, /action\.action_id === 'approve_reply_cc_client'/);
    assert.match(routes, /ccClientOnProspect: true/);
    assert.match(routes, /ccClientSelectedInModal/);
    assert.match(routes, /alwaysForwardEmailsForProspectCc/);
  });
});

describe('the automatic client updates that live here use notify_emails', () => {
  it('the positive-reply roll-up goes to notify_emails', () => {
    const r = digestRecipients(CLIENT, {});
    assert.deepEqual(r.to, ['notify@client.test', 'second@client.test']);
    assert.equal(r.to.includes('cc@client.test'), false);
    assert.equal(r.to.includes('contact@client.test'), false);
    assert.equal(r.to.includes('rep@client.test'), false);
  });

  it('the meeting-booked brief goes to notify_emails', async () => {
    const r = await resolveClientAlwaysCc({ clientSlug: '', clientName: 'Acme' }, {
      query: async () => ({ rows: [CLIENT] }),
    });
    assert.deepEqual(r.always, ['notify@client.test', 'second@client.test']);
  });

  it('the day-of meeting brief is not sent from this repo', () => {
    const reminder = read('src/services/reminder-email.js');
    assert.match(reminder, /meeting\.lead_email/);
    assert.doesNotMatch(reminder, /notify_emails|cc_emails|contact_email/);
    assert.doesNotMatch(read('package.json'), /resend/i);
    assert.equal(fs.existsSync(path.join(ROOT, 'src/services/day-of-meeting-brief.js')), false);
    const heyreachSend = read('src/services/heyreach.js');
    const sendFn = heyreachSend.slice(heyreachSend.indexOf('async function sendMessage'));
    assert.doesNotMatch(sendFn, /notify_emails|cc_emails|contact_email|ccEmail/);
    const heyreachReply = read('src/services/reply-send.js');
    const hr = heyreachReply.slice(heyreachReply.indexOf('async function sendHeyreachReply'), heyreachReply.indexOf('async function sendReplyToPlatform'));
    assert.doesNotMatch(hr, /notify_emails|cc_emails|contact_email|ccClientOnProspect/);
  });
});
