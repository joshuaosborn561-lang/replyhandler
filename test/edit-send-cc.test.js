const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Edit & send: the modal carries a CC field prefilled with the client's
// always-CC contact, and what is in that field goes to SmartLead as `cc`.

const dedupePath = require.resolve('../src/services/reply-dedupe');
const realDedupe = require(dedupePath);
require.cache[dedupePath].exports = {
  ...realDedupe,
  claimOutboundSend: async () => ({ ok: true }),
  alreadySentSameOutbound: async () => false,
};
const clientClaimed = require('../src/services/client-claimed');
clientClaimed.assertNotClaimedOrThrow = async () => {};

const smartlead = require('../src/services/smartlead');
const { sendReplyToPlatform } = require('../src/services/reply-send');
const { buildEditReplyBlocks } = require('../src/services/slack');
const { parseReferralCcInput } = require('../src/utils/referred-contact');
const { alwaysForwardEmailsForProspectCc } = require('../src/services/client-cc');

const sends = [];
const origSendReply = smartlead.sendReply;
const origHistory = smartlead.getThreadHistory;
const origAccounts = smartlead.listEmailAccounts;
const origForward = smartlead.forwardThreadToClient;

beforeEach(() => {
  sends.length = 0;
  smartlead.sendReply = async (key, campaign, lead, opts) => { sends.push({ campaign, lead, opts }); return { ok: true }; };
  smartlead.getThreadHistory = async () => null;
  smartlead.listEmailAccounts = async () => [];
  smartlead.forwardThreadToClient = async () => ({ ok: true });
});
after(() => {
  smartlead.sendReply = origSendReply;
  smartlead.getThreadHistory = origHistory;
  smartlead.listEmailAccounts = origAccounts;
  smartlead.forwardThreadToClient = origForward;
});

const CLIENT_NO_CC = { id: 'c1', name: 'Acme', smartlead_api_key: 'k' };
const REPLY = {
  id: 'r1', client_id: 'c1', platform: 'smartlead', campaign_id: '77', lead_id: '123',
  lead_email: 'prospect@lead.example', lead_name: 'Pat Prospect',
  smartlead_email_stats_id: 'stats-1',
};

describe('Edit & send CC field', () => {
  it('is prefilled with the client always-CC contact', () => {
    const client = { cc_emails: 'contact@client.example', cc_email: 'contact@client.example' };
    const blocks = buildEditReplyBlocks({
      initialDraft: 'Hey Pat', clientCc: alwaysForwardEmailsForProspectCc(client),
    });
    const cc = blocks.find((b) => b.block_id === 'client_cc_block');
    assert.ok(cc, 'CC block exists');
    assert.equal(cc.optional, true, 'it can be cleared');
    assert.equal(cc.element.action_id, 'client_cc_input');
    assert.equal(cc.element.initial_value, 'contact@client.example');
  });

  it('falls back to the legacy cc_email and handles several addresses', () => {
    assert.equal(alwaysForwardEmailsForProspectCc({ cc_email: 'One@client.example' }), 'one@client.example');
    assert.equal(
      alwaysForwardEmailsForProspectCc({ cc_emails: 'a@client.example; b@client.example' }),
      'a@client.example, b@client.example',
    );
  });

  it('shows an empty field when the client has no default, and no field for HeyReach', () => {
    const empty = buildEditReplyBlocks({ initialDraft: 'Hey', clientCc: '' })
      .find((b) => b.block_id === 'client_cc_block');
    assert.ok(empty);
    assert.equal(empty.element.initial_value, undefined);
    const none = buildEditReplyBlocks({ initialDraft: 'Hey', clientCc: null });
    assert.equal(none.find((b) => b.block_id === 'client_cc_block'), undefined);
  });

  it('keeps the referral CC field separate', () => {
    const blocks = buildEditReplyBlocks({
      initialDraft: 'Hey', referralCc: 'friend@lead.example', clientCc: 'contact@client.example',
    });
    assert.ok(blocks.find((b) => b.block_id === 'referral_cc_block'));
    assert.ok(blocks.find((b) => b.block_id === 'client_cc_block'));
  });

  it('a typed or cleared field parses; garbage and the prospect fail closed', () => {
    const o = { prospectEmail: REPLY.lead_email };
    assert.deepEqual(parseReferralCcInput('contact@client.example', o).emails, ['contact@client.example']);
    assert.deepEqual(parseReferralCcInput('', o).emails, []);
    assert.match(parseReferralCcInput('the client', o).error, /Nothing was sent/);
    assert.match(parseReferralCcInput(REPLY.lead_email, o).error, /Nothing was sent/);
  });
});

describe('Edit & send passes cc to SmartLead reply-email-thread', () => {
  it('sends the CC field as the cc string with requireCc', async () => {
    await sendReplyToPlatform(CLIENT_NO_CC, REPLY, 'Hey Pat', { clientCc: ['contact@client.example'] });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].opts.cc, 'contact@client.example');
    assert.equal(typeof sends[0].opts.cc, 'string');
    assert.equal(sends[0].opts.requireCc, true);
    assert.deepEqual(sends[0].opts.requiredCc, ['contact@client.example']);
  });

  it('sends two addresses once each, merged with the referral CC', async () => {
    await sendReplyToPlatform(CLIENT_NO_CC, REPLY, 'Hey Pat', {
      clientCc: ['a@client.example', 'b@client.example'],
      referralCc: ['b@client.example', 'friend@lead.example'],
    });
    assert.equal(sends[0].opts.cc, 'a@client.example, b@client.example, friend@lead.example');
  });

  it('a cleared field sends no cc at all', async () => {
    await sendReplyToPlatform(CLIENT_NO_CC, REPLY, 'Hey Pat', { clientCc: [] });
    assert.equal(sends[0].opts.cc, undefined);
    assert.equal(sends[0].opts.requireCc, undefined);
  });

  it('plain Approve (no clientCc) still sends no cc', async () => {
    await sendReplyToPlatform(CLIENT_NO_CC, REPLY, 'Hey Pat');
    assert.equal(sends[0].opts.cc, undefined);
  });

  it('refuses a CC on HeyReach and sends nothing', async () => {
    await assert.rejects(
      () => sendReplyToPlatform(CLIENT_NO_CC, { ...REPLY, platform: 'heyreach' }, 'Hey', { clientCc: ['contact@client.example'] }),
      /Nothing was sent/,
    );
    assert.equal(sends.length, 0);
  });

  it('SmartLead payload carries cc and still posts once', async () => {
    smartlead.sendReply = origSendReply;
    const calls = [];
    const orig = global.fetch;
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body) });
      return { ok: true, text: async () => '{"success":true}' };
    };
    try {
      await sendReplyToPlatform(CLIENT_NO_CC, REPLY, 'Hey Pat', { clientCc: ['contact@client.example'] });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/campaigns\/77\/reply-email-thread/);
      assert.equal(calls[0].body.cc, 'contact@client.example');
    } finally {
      global.fetch = orig;
    }
  });
});

describe('Edit & send wiring', () => {
  const fs = require('node:fs');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/slack.js'), 'utf8');
  it('the modal opens with the client default and the submit reads the field', () => {
    assert.match(route, /clientCc: reply\.platform === 'smartlead' \? alwaysForwardEmailsForProspectCc\(client\) : null/);
    assert.match(route, /client_cc_block\?\.client_cc_input/);
    assert.match(route, /sendReplyToPlatform\(client, reply, messageText, \{\s*referralCc,\s*clientCc,/);
  });
});
