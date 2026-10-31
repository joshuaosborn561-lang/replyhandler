const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const slack = require('../src/services/slack');
const db = require('../src/db');
const smartlead = require('../src/services/smartlead');
const clientClaimed = require('../src/services/client-claimed');
const { sendReplyToPlatform } = require('../src/services/reply-send');

const CLIENT = {
  id: 'c1', name: 'Acme', smartlead_api_key: 'k',
  notify_emails: 'owner@acme.test, ops@acme.test',
  cc_emails: 'portal@acme.test',
  cc_email: 'legacy@acme.test',
  contact_email: 'contact@acme.test',
  cc_round_robin_emails: 'rep@acme.test',
};
const REPLY = {
  id: 'r1', platform: 'smartlead', classification: 'INTERESTED', client_id: 'c1',
  lead_email: 'lead@prospect.test', lead_name: 'Pat', campaign_id: '9', lead_id: '123',
  smartlead_email_stats_id: 'stats1',
};

describe('Edit modal: CC client on this reply', () => {
  it('shows an optional CC client checkbox listing the always-CC addresses', () => {
    const blocks = slack.buildEditReplyBlocks({
      initialDraft: 'Hey Pat', ccClientEmails: 'owner@acme.test, ops@acme.test',
    });
    const b = blocks.find((x) => x.block_id === 'cc_client_block');
    assert.ok(b, 'checkbox block present');
    assert.equal(b.optional, true);
    assert.equal(b.element.type, 'checkboxes');
    assert.match(b.element.options[0].text.text, /owner@acme\.test/);
    assert.equal(b.element.initial_options, undefined);
  });

  it('pre-ticks the box when the reply already has cc_on_send', () => {
    const b = slack.buildEditReplyBlocks({ ccClientEmails: 'owner@acme.test', ccOnSend: true })
      .find((x) => x.block_id === 'cc_client_block');
    assert.equal(b.element.initial_options.length, 1);
  });

  it('no always-CC addresses means no checkbox', () => {
    assert.equal(slack.buildEditReplyBlocks({ initialDraft: 'x' }).some((x) => x.block_id === 'cc_client_block'), false);
    assert.equal(slack.buildEditReplyBlocks({ ccClientEmails: '  ' }).some((x) => x.block_id === 'cc_client_block'), false);
  });

  it('reads the ticked and unticked state from the submitted view', () => {
    const ticked = { cc_client_block: { cc_client_input: { selected_options: [{ value: 'cc_client' }] } } };
    const unticked = { cc_client_block: { cc_client_input: { selected_options: [] } } };
    assert.equal(slack.ccClientSelectedInModal(ticked), true);
    assert.equal(slack.ccClientSelectedInModal(unticked), false);
    assert.equal(slack.ccClientSelectedInModal({}), false);
    assert.equal(slack.ccClientSelectedInModal(undefined), false);
  });

  it('the edit submit handler passes the tick through to the send', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/slack.js'), 'utf8');
    const edit = src.slice(src.indexOf('async function handleEditModalSubmit'), src.indexOf('async function setCardStatus'));
    assert.match(edit, /ccClientSelectedInModal\(interaction\.view\.state\.values\)/);
    assert.match(edit, /sendReplyToPlatform\(client, reply, messageText, \{\s*ccClientOnProspect,/);
    const open = src.slice(src.indexOf('async function handleOpenEditModal'), src.indexOf('async function handleToggleCcClient'));
    assert.match(open, /ccClientEmails:/);
  });

  it('the no-CC notice no longer promises an instant Gmail notify while the roll-up is on', () => {
    const prev = process.env.PROSPECT_REPLY_NOTIFY_MODE;
    try {
      delete process.env.PROSPECT_REPLY_NOTIFY_MODE;
      assert.equal(slack.notifyModeIsRollup(), true);
      process.env.PROSPECT_REPLY_NOTIFY_MODE = 'instant';
      assert.equal(slack.notifyModeIsRollup(), false);
    } finally {
      if (prev === undefined) delete process.env.PROSPECT_REPLY_NOTIFY_MODE;
      else process.env.PROSPECT_REPLY_NOTIFY_MODE = prev;
    }
  });
});

describe('sendReplyToPlatform: CC client in roll-up mode', () => {
  const orig = {};
  let sent;
  let queued;
  beforeEach(() => {
    sent = [];
    queued = 0;
    orig.query = db.query;
    orig.assert = clientClaimed.assertNotClaimedOrThrow;
    orig.sendReply = smartlead.sendReply;
    orig.history = smartlead.getThreadHistory;
    orig.accounts = smartlead.listEmailAccounts;
    orig.mode = process.env.PROSPECT_REPLY_NOTIFY_MODE;
    delete process.env.PROSPECT_REPLY_NOTIFY_MODE;
    orig.connect = db.connect;
    db.connect = async () => ({
      query: async (sql) => (/FROM pending_replies WHERE id = \$1/.test(sql)
        ? { rows: [{ ...REPLY, status: 'approved' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      release() {},
    });
    db.query = async (sql) => {
      if (/client_digest_status = 'pending'/.test(sql)) { queued += 1; return { rows: [], rowCount: 1 }; }
      return { rows: [{ id: 'r1' }], rowCount: 1 };
    };
    clientClaimed.assertNotClaimedOrThrow = async () => {};
    smartlead.sendReply = async (_k, _c, _l, opts) => { sent.push(opts); };
    smartlead.getThreadHistory = async () => null;
    smartlead.listEmailAccounts = async () => [];
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

  it('ticked: always-CC addresses ride on the prospect reply, round-robin does not, roll-up still queues', async () => {
    const res = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: true });
    assert.equal(sent.length, 1);
    const cc = String(sent[0].cc || '').toLowerCase();
    assert.match(cc, /owner@acme\.test/);
    assert.match(cc, /ops@acme\.test/);
    assert.doesNotMatch(cc, /rep@acme\.test|portal@acme\.test|legacy@acme\.test|contact@acme\.test/);
    assert.match(res.prospectCcEmails, /owner@acme\.test/);
    assert.equal(res.clientNotifyMode, 'rollup');
    assert.equal(res.clientDigestQueued, true);
    assert.equal(queued, 1);
  });

  it('unticked: no CC on the prospect reply, roll-up queue unchanged', async () => {
    const res = await sendReplyToPlatform(CLIENT, REPLY, 'Sounds good', { ccClientOnProspect: false });
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].cc);
    assert.equal(res.prospectCcEmails, undefined);
    assert.equal(res.clientDigestQueued, true);
  });
});
