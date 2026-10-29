const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../src/db');
const smartlead = require('../src/services/smartlead');
const clientClaimed = require('../src/services/client-claimed');
const gmail = require('../src/services/gmail-send');
const notice = require('../src/services/cc-notice-email');
const { sendReplyToPlatform } = require('../src/services/reply-send');

const ON = { CC_NOTICE_EMAIL_ENABLED: 'true' };
const HISTORY = {
  history: [
    { type: 'SENT', stats_id: 's-old', from: 'old.box@sender-one.test', time: '2026-10-20T10:00:00Z' },
    { type: 'SENT', stats_id: 'stats1', from: 'Jo Box <jo.box@sender-two.test>', time: '2026-10-21T10:00:00Z' },
    { type: 'REPLY', stats_id: 'stats1', from: 'lead@prospect.test', to: 'jo.box@sender-two.test', time: '2026-10-22T10:00:00Z' },
  ],
};

function fakeMailer(calls, { fail = false, configured = true } = {}) {
  return {
    isConfigured: () => configured,
    expectedFromEmail: () => 'joshua@salesglidergrowth.com',
    sendMail: async (m) => {
      if (fail) throw new Error('gmail down');
      calls.push(m);
      return { from: 'joshua@salesglidergrowth.com' };
    },
  };
}

describe('cc-notice: flag', () => {
  it('is off by default and only on for true/1/yes/on', () => {
    assert.equal(notice.ccNoticeEnabled({}), false);
    assert.equal(notice.ccNoticeEnabled({ CC_NOTICE_EMAIL_ENABLED: 'false' }), false);
    assert.equal(notice.ccNoticeEnabled({ CC_NOTICE_EMAIL_ENABLED: '' }), false);
    for (const v of ['true', '1', 'yes', 'ON', 'True']) {
      assert.equal(notice.ccNoticeEnabled({ CC_NOTICE_EMAIL_ENABLED: v }), true);
    }
  });
});

describe('cc-notice: sending inbox', () => {
  it('uses the SENT message for the stats_id we replied to', () => {
    assert.equal(notice.pickSendingInbox({ history: HISTORY, emailStatsId: 'stats1' }), 'jo.box@sender-two.test');
    assert.equal(notice.pickSendingInbox({ history: HISTORY, emailStatsId: 's-old' }), 'old.box@sender-one.test');
  });
  it('falls back to the latest SENT message', () => {
    assert.equal(notice.pickSendingInbox({ history: HISTORY, emailStatsId: 'nope' }), 'jo.box@sender-two.test');
    assert.equal(notice.pickSendingInbox({ history: HISTORY }), 'jo.box@sender-two.test');
  });
  it('falls back to the address the prospect wrote to when it is one of our accounts', () => {
    const h = { history: [{ type: 'REPLY', from: 'lead@prospect.test', to: 'x@else.test, ours@sender-three.test' }] };
    assert.equal(notice.pickSendingInbox({ history: h, accountEmails: ['ours@sender-three.test'] }), 'ours@sender-three.test');
    assert.equal(notice.pickSendingInbox({ history: h, accountEmails: [] }), '');
  });
  it('is empty with no history', () => {
    assert.equal(notice.pickSendingInbox({ history: null }), '');
  });
});

describe('cc-notice: recipients', () => {
  it('dedupes, lowercases, and drops the prospect, Josh and the sending inbox', () => {
    const to = notice.noticeRecipients({
      ccEmails: 'Owner@Acme.test, ops@acme.test, owner@acme.test, lead@prospect.test, joshua@salesglidergrowth.com, box@sender.test',
      leadEmail: 'LEAD@prospect.test',
      exclude: ['joshua@salesglidergrowth.com', 'box@sender.test'],
    });
    assert.deepEqual(to, ['owner@acme.test', 'ops@acme.test']);
  });
});

describe('cc-notice: template', () => {
  it('has the lead, company and sending address', () => {
    const e = notice.buildCcNoticeEmail({ leadName: 'Pat Doe', company: 'Doe Co', senderEmail: 'jo.box@sender-two.test' });
    assert.equal(e.subject, "Heads up: we just CC'd you on a reply to Pat Doe");
    assert.match(e.textBody, /CC'd you on our reply to Pat Doe at Doe Co/);
    assert.match(e.textBody, /spam and promotions/);
    assert.match(e.textBody, /It came from jo\.box@sender-two\.test/);
    assert.match(e.textBody, /Josh$/);
    assert.match(e.htmlBody, /jo\.box@sender-two\.test/);
  });
  it('drops the company when unknown and the address line when the inbox is unknown', () => {
    const e = notice.buildCcNoticeEmail({ leadName: 'Pat Doe' });
    assert.match(e.textBody, /our reply to Pat Doe\./);
    assert.doesNotMatch(e.textBody, /It came from/);
    assert.match(notice.buildCcNoticeEmail({ leadName: 'Unknown' }).subject, /reply to a prospect$/);
  });
  it('escapes HTML in names', () => {
    const e = notice.buildCcNoticeEmail({ leadName: '<b>X</b>', company: 'A & B' });
    assert.doesNotMatch(e.htmlBody, /<b>X/);
    assert.match(e.htmlBody, /A &amp; B/);
  });
});

describe('cc-notice: sendCcNotice', () => {
  beforeEach(() => notice._resetSeenForTests());
  const base = {
    replyId: 'r1', leadName: 'Pat Doe', company: 'Doe Co', leadEmail: 'lead@prospect.test',
    ccEmails: 'owner@acme.test, ops@acme.test', history: HISTORY, emailStatsId: 'stats1', accountEmails: [],
  };

  it('sends nothing when the flag is off', async () => {
    const calls = [];
    const r = await notice.sendCcNotice(base, { mailer: fakeMailer(calls), env: {} });
    assert.equal(r.sent, false);
    assert.equal(r.skipped, 'disabled');
    assert.equal(calls.length, 0);
  });

  it('sends ONE email to all CC contacts from the primary Gmail, replies to Josh', async () => {
    const calls = [];
    const r = await notice.sendCcNotice(base, { mailer: fakeMailer(calls), env: ON });
    assert.equal(r.sent, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].to, ['owner@acme.test', 'ops@acme.test']);
    assert.match(calls[0].textBody, /jo\.box@sender-two\.test/);
    assert.equal(calls[0].replyTo, 'joshua@salesglidergrowth.com');
  });

  it('does not send twice for the same reply and recipients', async () => {
    const calls = [];
    await notice.sendCcNotice(base, { mailer: fakeMailer(calls), env: ON });
    const again = await notice.sendCcNotice(base, { mailer: fakeMailer(calls), env: ON });
    assert.equal(again.skipped, 'duplicate');
    assert.equal(calls.length, 1);
  });

  it('skips with no recipients and when Gmail is not configured', async () => {
    const calls = [];
    const none = await notice.sendCcNotice({ ...base, ccEmails: 'lead@prospect.test' }, { mailer: fakeMailer(calls), env: ON });
    assert.equal(none.skipped, 'no_recipients');
    const off = await notice.sendCcNotice(base, { mailer: fakeMailer(calls, { configured: false }), env: ON });
    assert.equal(off.skipped, 'gmail_not_configured');
    assert.equal(calls.length, 0);
  });

  it('never throws when Gmail fails, and a retry is allowed afterwards', async () => {
    const calls = [];
    const failed = await notice.sendCcNotice(base, { mailer: fakeMailer(calls, { fail: true }), env: ON });
    assert.equal(failed.sent, false);
    assert.match(failed.error, /gmail down/);
    const retry = await notice.sendCcNotice(base, { mailer: fakeMailer(calls), env: ON });
    assert.equal(retry.sent, true);
  });
});

describe('sendReplyToPlatform: CC notice wiring', () => {
  const CLIENT = {
    id: 'c1', name: 'Acme', smartlead_api_key: 'k',
    cc_emails: 'owner@acme.test, ops@acme.test', cc_round_robin_emails: 'rep@acme.test',
  };
  const REPLY = {
    id: 'r1', platform: 'smartlead', classification: 'INTERESTED', client_id: 'c1',
    lead_email: 'lead@prospect.test', lead_name: 'Pat Doe', lead_company: 'Doe Co',
    campaign_id: '9', lead_id: '123', smartlead_email_stats_id: 'stats1',
  };
  const orig = {};
  let sent;
  let mails;
  let sendReplyFails;
  beforeEach(() => {
    sent = [];
    mails = [];
    sendReplyFails = false;
    notice._resetSeenForTests();
    for (const k of ['CC_NOTICE_EMAIL_ENABLED', 'PROSPECT_REPLY_NOTIFY_MODE']) orig[k] = process.env[k];
    delete process.env.PROSPECT_REPLY_NOTIFY_MODE;
    process.env.CC_NOTICE_EMAIL_ENABLED = 'true';
    orig.query = db.query;
    orig.connect = db.connect;
    orig.assert = clientClaimed.assertNotClaimedOrThrow;
    orig.sendReply = smartlead.sendReply;
    orig.history = smartlead.getThreadHistory;
    orig.accounts = smartlead.listEmailAccounts;
    orig.isConfigured = gmail.isConfigured;
    orig.sendMail = gmail.sendMail;
    db.connect = async () => ({
      query: async (sql) => (/FROM pending_replies WHERE id = \$1/.test(sql)
        ? { rows: [{ ...REPLY, status: 'approved' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      release() {},
    });
    db.query = async () => ({ rows: [{ id: 'r1' }], rowCount: 1 });
    clientClaimed.assertNotClaimedOrThrow = async () => {};
    smartlead.sendReply = async (_k, _c, _l, opts) => {
      if (sendReplyFails) throw new Error('smartlead down');
      sent.push(opts);
    };
    smartlead.getThreadHistory = async () => HISTORY;
    smartlead.listEmailAccounts = async () => [];
    gmail.isConfigured = () => true;
    gmail.sendMail = async (m) => { mails.push(m); return { from: 'joshua@salesglidergrowth.com' }; };
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
    for (const k of ['CC_NOTICE_EMAIL_ENABLED', 'PROSPECT_REPLY_NOTIFY_MODE']) {
      if (orig[k] === undefined) delete process.env[k]; else process.env[k] = orig[k];
    }
  });

  it('CC ticked + flag on: one notice to the always-CC contacts, not the round-robin rep', async () => {
    const res = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: true });
    assert.equal(sent.length, 1);
    const notices = mails.filter((m) => /CC'd you/.test(m.subject));
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0].to, ['owner@acme.test', 'ops@acme.test']);
    assert.match(notices[0].textBody, /jo\.box@sender-two\.test/);
    assert.equal(res.ccNoticeSent, true);
  });

  it('no CC on the reply: no notice', async () => {
    const res = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: false });
    assert.equal(sent.length, 1);
    assert.equal(mails.filter((m) => /CC'd you/.test(m.subject)).length, 0);
    assert.equal(res.ccNoticeSent, undefined);
  });

  it('flag off (default): no notice even with the CC on', async () => {
    delete process.env.CC_NOTICE_EMAIL_ENABLED;
    const res = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: true });
    assert.equal(sent.length, 1);
    assert.equal(mails.filter((m) => /CC'd you/.test(m.subject)).length, 0);
    assert.equal(res.ccNoticeSent, undefined);
  });

  it('client with no always-CC list: nothing was CC\'d, so no notice', async () => {
    const res = await sendReplyToPlatform({ ...CLIENT, cc_emails: '', cc_email: '' }, REPLY, 'Sounds good', { ccClientOnProspect: true });
    assert.equal(mails.length, 0);
    assert.equal(res.ccNoticeSent, undefined);
  });

  it('SmartLead send fails: the CC never happened, so no notice', async () => {
    sendReplyFails = true;
    await assert.rejects(sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: true }), /smartlead down/);
    assert.equal(mails.length, 0);
  });

  it('a failing notice never fails the reply', async () => {
    gmail.sendMail = async () => { throw new Error('gmail down'); };
    const res = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: true });
    assert.equal(sent.length, 1);
    assert.equal(res.ccNoticeSent, undefined);
    assert.match(String(res.ccNoticeSkipped), /gmail down/);
  });

  it('the notice code runs after the SmartLead send, not before', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/reply-send.js'), 'utf8');
    assert.ok(src.indexOf('await smartlead.sendReply(') < src.indexOf('await sendCcNotice('));
  });
});
