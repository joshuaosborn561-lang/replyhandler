// Josh, Oct 31 2026: the separate "Hot lead: we CC'd you" email to the client is gone.
// A hot lead reaches the client only in the 4:00pm CT roll-up. Approve & Send + CC client
// (and the Edit modal CC box) still put notify_emails on the SmartLead reply.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../src/db');
const smartlead = require('../src/services/smartlead');
const clientClaimed = require('../src/services/client-claimed');
const gmail = require('../src/services/gmail-send');
const { sendReplyToPlatform } = require('../src/services/reply-send');
const { runClientReplyDigest } = require('../src/services/client-reply-digest');
const { firstNameFromEmail } = require('../src/utils/first-name');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('CC notice email is retired', () => {
  it('the module is gone and nothing in src references it or its flag or subject', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'src/services/cc-notice-email.js')), false);
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const f of walk('src').filter((x) => /\.(js|html)$/.test(x))) {
      const text = read(f);
      assert.doesNotMatch(text, /cc-notice-email|sendCcNotice|CC_NOTICE_EMAIL_ENABLED|Hot lead: we CC/i, f);
    }
  });
  it('the first-name helper kept for the ICP profile still works', () => {
    assert.equal(firstNameFromEmail('john.smith@acme.test'), 'John');
    assert.equal(firstNameFromEmail('Pat+leads@acme.test'), 'Pat');
    for (const e of ['info@a.test', 'j@a.test', '1234@a.test', 'not-an-email', '']) assert.equal(firstNameFromEmail(e), '', e);
  });
});

describe('CC send: no notice email, reply still CCs notify_emails, hot lead reaches the roll-up', () => {
  const CLIENT = {
    id: 'c1', name: 'Acme', smartlead_api_key: 'k',
    notify_emails: 'owner@acme.test, ops@acme.test',
    cc_emails: 'portal@acme.test', cc_email: 'legacy@acme.test', contact_email: 'contact@acme.test',
  };
  const REPLY = {
    id: 'r1', platform: 'smartlead', classification: 'INTERESTED', client_id: 'c1', follow_up_id: null,
    lead_email: 'lead@prospect.test', lead_name: 'Pat Doe', lead_full_name: 'Pat Doe', lead_company: 'Doe Co',
    campaign_id: '9', lead_id: '123', smartlead_email_stats_id: 'stats1',
    inbound_message: 'Yes, interested.', sent_reply: 'Sounds good',
    created_at: '2026-10-30T15:00:00Z', updated_at: '2026-10-30T16:00:00Z',
  };
  const orig = {};
  const KEYS = ['PROSPECT_REPLY_NOTIFY_MODE', 'CC_NOTICE_EMAIL_ENABLED'];
  let sent;
  let mails;
  let rows; // pending_replies state: id -> { ...reply, status, ds }

  beforeEach(() => {
    sent = []; mails = []; rows = new Map();
    rows.set('r1', { ...REPLY, status: 'sent', ds: null });
    for (const k of KEYS) orig[k] = process.env[k];
    delete process.env.PROSPECT_REPLY_NOTIFY_MODE;
    process.env.CC_NOTICE_EMAIL_ENABLED = 'true'; // the old flag must now do nothing
    Object.assign(orig, {
      query: db.query, connect: db.connect, assert: clientClaimed.assertNotClaimedOrThrow,
      sendReply: smartlead.sendReply, history: smartlead.getThreadHistory, accounts: smartlead.listEmailAccounts,
      isConfigured: gmail.isConfigured, sendMail: gmail.sendMail,
    });
    db.connect = async () => ({
      query: async (sql) => (/FROM pending_replies WHERE id = \$1/.test(sql)
        ? { rows: [{ ...REPLY, status: 'approved' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      release() {},
    });
    // One stateful stand-in for the queue: queueForDigest and the roll-up share it.
    db.query = async (sql, params = []) => {
      if (/SET client_digest_status = 'pending', client_digest_queued_at/.test(sql)) {
        const r = rows.get(params[0]);
        if (r && r.ds === null) { r.ds = 'pending'; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ id: 'r1' }], rowCount: 1 };
    };
    clientClaimed.assertNotClaimedOrThrow = async () => {};
    smartlead.sendReply = async (_k, _c, _l, opts) => { sent.push(opts); };
    smartlead.getThreadHistory = async () => ({ history: [] });
    smartlead.listEmailAccounts = async () => [];
    gmail.isConfigured = () => true;
    gmail.sendMail = async (m) => { mails.push(m); return { from: 'joshua@salesglidergrowth.com' }; };
  });
  afterEach(() => {
    db.query = orig.query; db.connect = orig.connect;
    clientClaimed.assertNotClaimedOrThrow = orig.assert;
    smartlead.sendReply = orig.sendReply; smartlead.getThreadHistory = orig.history;
    smartlead.listEmailAccounts = orig.accounts;
    gmail.isConfigured = orig.isConfigured; gmail.sendMail = orig.sendMail;
    for (const k of KEYS) { if (orig[k] === undefined) delete process.env[k]; else process.env[k] = orig[k]; }
  });

  function rollupQuery(clients) {
    return async (sql, params = []) => {
      if (/WHERE client_digest_status = 'sending'/.test(sql)) return { rows: [] };
      if (/SET client_digest_status = 'sending'/.test(sql)) {
        // This is the exact WHERE the roll-up uses: pending AND sent. Nothing about CC or approve path.
        const hit = [...rows.values()].filter((r) => r.ds === 'pending' && r.status === 'sent');
        hit.forEach((r) => { r.ds = 'sending'; });
        return { rows: hit.map((r) => ({ ...r })) };
      }
      if (/FROM clients WHERE id/.test(sql)) return { rows: [clients[params[0]]] };
      if (/SET client_digest_status = \$2/.test(sql)) {
        for (const id of params[0]) rows.get(id).ds = params[1];
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
    };
  }

  it('Approve & Send + CC client: CCs notify_emails on the reply, sends NO notice email, queues the roll-up', async () => {
    const res = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: true });
    assert.equal(sent.length, 1);
    assert.match(sent[0].cc, /owner@acme\.test/);
    assert.match(sent[0].cc, /ops@acme\.test/);
    assert.doesNotMatch(sent[0].cc, /portal@acme\.test|legacy@acme\.test|contact@acme\.test/);
    assert.equal(mails.length, 0, 'no email of any kind is sent from the reply path');
    assert.equal(res.ccNoticeSent, undefined);
    assert.equal(res.clientDigestQueued, true);
    assert.equal(rows.get('r1').ds, 'pending');
  });

  it('the CC\'d hot lead then appears in the 4pm roll-up To notify_emails, with Josh and Cayden copied', async () => {
    await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: true });
    const out = [];
    const s = await runClientReplyDigest({
      query: rollupQuery({ c1: CLIENT }), send: async (m) => out.push(m), env: {},
      now: new Date('2026-10-30T21:00:00Z'),
    });
    assert.equal(s.sent, 1);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].to, ['owner@acme.test', 'ops@acme.test']);
    assert.match(out[0].subject, /^Positive replies: 1 prospect/);
    assert.match(out[0].htmlBody, /Pat Doe/);
    assert.match(out[0].htmlBody, /Yes, interested\./);
    assert.match(out[0].htmlBody, /Sounds good/);
    assert.equal(rows.get('r1').ds, 'sent');
  });

  it('a plain Approve (no CC) lands in the same roll-up, so CC or not the client hears once, at 4pm', async () => {
    await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: false });
    assert.equal(sent[0].cc === undefined || !/owner@acme\.test/.test(sent[0].cc), true);
    assert.equal(mails.length, 0);
    const out = [];
    await runClientReplyDigest({ query: rollupQuery({ c1: CLIENT }), send: async (m) => out.push(m), env: {} });
    assert.equal(out.length, 1);
  });

  it('the roll-up query does not filter on how the reply was sent', () => {
    const src = read('src/services/client-reply-digest.js');
    const m = src.match(/SET client_digest_status = 'sending'[\s\S]*?RETURNING/);
    assert.ok(m, 'claim query found');
    assert.match(m[0], /client_digest_status = 'pending' AND status = 'sent'/);
    assert.doesNotMatch(m[0], /cc|prospect_cc|approve/i);
  });
});
