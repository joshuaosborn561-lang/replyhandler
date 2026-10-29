const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const slack = require('../src/services/slack');
const db = require('../src/db');
const { retireSlackCards } = require('../src/services/retire-slack-cards');
const guard = require('../src/services/card-click-guard');
const bridge = require('../src/services/booking-bridge');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const CLIENT = { id: 'c1', slack_bot_token: 'xoxb-test', slack_channel_id: 'C123' };
const ROW = {
  id: 'r1', client_id: 'c1', platform: 'smartlead', classification: 'INTERESTED',
  lead_name: 'Pat', lead_email: 'pat@x.co', inbound_message: 'sounds good',
  slack_message_ts: '1793283991.391929', campaign_id: '9',
};
const ctxStub = async () => ({ campaignDisplay: 'Camp (9)' });

describe('CC client checkbox text stays within the Slack option limit', () => {
  it('truncates a long always-CC list to 75 characters or less', () => {
    const long = Array.from({ length: 8 }, (_, i) => `person${i}@a-long-client-domain.test`).join(', ');
    const text = slack.ccClientOptionText(long);
    assert.ok(text.length <= 75, `got ${text.length}`);
    assert.match(text, /^CC client on this reply: person0@/);
    assert.ok(text.endsWith('…'));
  });

  it('leaves a short list alone and fits exactly at the limit', () => {
    assert.equal(slack.ccClientOptionText('a@b.test'), 'CC client on this reply: a@b.test');
    const fits = 'x'.repeat(75 - 'CC client on this reply: '.length);
    assert.equal(slack.ccClientOptionText(fits).length, 75);
    assert.ok(!slack.ccClientOptionText(fits).endsWith('…'));
    assert.equal(slack.ccClientOptionText(`${fits}y`).length, 75);
  });

  it('the Edit modal block never exceeds the limit, ticked or not', () => {
    const long = Array.from({ length: 10 }, (_, i) => `rep${i}@client-company.test`).join(',');
    for (const ccOnSend of [false, true]) {
      const b = slack.buildEditReplyBlocks({ ccClientEmails: long, ccOnSend })
        .find((x) => x.block_id === 'cc_client_block');
      assert.ok(b.element.options[0].text.text.length <= 75);
      if (ccOnSend) assert.equal(b.element.initial_options[0].text.text, b.element.options[0].text.text);
    }
  });
});

describe('retired card has no buttons', () => {
  it('meeting_booked_auto renders the no-action header and no actions block', () => {
    const blocks = slack.buildSentConfirmationBlocks({
      leadName: 'Pat', leadEmail: 'pat@x.co', platform: 'smartlead', classification: 'INTERESTED',
      inboundMessage: 'hi', actionKind: 'meeting_booked_auto', extraFooter: 'Meeting booked, no action needed.',
    });
    assert.equal(blocks[0].text.text, '📅 Meeting booked — no action needed');
    assert.equal(blocks.some((b) => b.type === 'actions'), false);
  });
});

describe('retireSlackCards', () => {
  it('updates a posted card to the booked confirmation, in the client channel', async () => {
    const calls = [];
    const out = await retireSlackCards([ROW], {
      actionKind: 'meeting_booked_auto',
      deps: {
        query: async () => ({ rows: [CLIENT] }),
        cardContext: ctxStub,
        updateCard: async (token, channel, ts, payload) => { calls.push({ token, channel, ts, payload }); },
      },
    });
    assert.deepEqual(out, { retired: 1, skipped: 0, failed: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, 'C123');
    assert.equal(calls[0].ts, '1793283991.391929');
    assert.equal(calls[0].payload.actionKind, 'meeting_booked_auto');
    assert.equal(calls[0].payload.sentReply, null);
    assert.match(calls[0].payload.extraFooter, /no action needed/);
  });

  it('skips cards never posted, still claiming, or follow-up cards', async () => {
    const updates = [];
    const out = await retireSlackCards([
      { ...ROW, slack_message_ts: null },
      { ...ROW, slack_message_ts: 'claiming:abc' },
      { ...ROW, classification: 'FOLLOW_UP' },
    ], {
      deps: { query: async () => ({ rows: [CLIENT] }), cardContext: ctxStub, updateCard: async (...a) => updates.push(a) },
    });
    assert.deepEqual(out, { retired: 0, skipped: 3, failed: 0 });
    assert.equal(updates.length, 0);
  });

  it('skips a client with no Slack token, and a Slack error never throws', async () => {
    const noToken = await retireSlackCards([ROW], {
      deps: { query: async () => ({ rows: [{ id: 'c1' }] }), cardContext: ctxStub, updateCard: async () => { throw new Error('nope'); } },
    });
    assert.equal(noToken.skipped, 1);
    const failed = await retireSlackCards([ROW, ROW], {
      deps: { query: async () => ({ rows: [CLIENT] }), cardContext: ctxStub, updateCard: async () => { throw new Error('message_not_found'); } },
    });
    assert.deepEqual(failed, { retired: 0, skipped: 0, failed: 2 });
  });

  it('tolerates a missing rows list', async () => {
    assert.deepEqual(await retireSlackCards(undefined), { retired: 0, skipped: 0, failed: 0 });
  });
});

describe('booking bridge retires the closed reply card', () => {
  const orig = {};
  let updates;
  beforeEach(() => {
    updates = [];
    orig.query = db.query;
    orig.update = slack.updateSentConfirmationCard;
    slack.updateSentConfirmationCard = async (token, channel, ts, payload) => { updates.push({ channel, ts, payload }); };
    db.query = async (sql) => {
      if (/UPDATE pending_replies/.test(sql)) return { rows: [ROW], rowCount: 1 };
      if (/FROM clients WHERE id/.test(sql)) return { rows: [CLIENT] };
      if (/UPDATE outbound_follow_ups/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    };
  });
  afterEach(() => {
    db.query = orig.query;
    slack.updateSentConfirmationCard = orig.update;
  });

  it('closing a pending reply by email also flips its Slack card', async () => {
    const r = await bridge.stopFollowUpsForEmail({ clientId: 'c1', email: 'pat@x.co', name: 'Pat' });
    assert.equal(r.closedReplies, 1);
    assert.equal(r.retiredCards, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].ts, ROW.slack_message_ts);
  });

  it('a Slack failure does not fail the booking', async () => {
    slack.updateSentConfirmationCard = async () => { throw new Error('ratelimited'); };
    const r = await bridge.stopFollowUpsForEmail({ clientId: 'c1', email: 'pat@x.co', name: 'Pat' });
    assert.equal(r.closedReplies, 1);
    assert.equal(r.retiredCards, 0);
  });
});

describe('click on a closed reply shows a private notice', () => {
  const act = (action_id, value = 'r1') => ({ action_id, value });
  const interaction = { response_url: 'https://hooks.slack.test/actions/abc' };

  it('tells the clicker the reply is already handled, privately, and returns true', async () => {
    const posted = [];
    const fetchImpl = async (url, opts) => { posted.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
    const closed = await guard.noticeIfClosed(act('open_edit_modal'), interaction, {
      query: async () => ({ rows: [{ status: 'meeting_booked' }] }), fetchImpl,
    });
    assert.equal(closed, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, interaction.response_url);
    assert.equal(posted[0].body.response_type, 'ephemeral');
    assert.equal(posted[0].body.replace_original, false);
    assert.match(posted[0].body.text, /Already handled \(meeting booked\)/);
  });

  it('covers every reply-card button', async () => {
    for (const id of ['approve_reply', 'approve_reply_cc_client', 'approve_reply_cc_referral',
      'open_edit_modal', 'reject_reply', 'dq_prospect', 'meeting_booked']) {
      assert.equal(guard.isGuardedAction(id), true, id);
      const r = await guard.checkReplyOpen(id, 'r1', { query: async () => ({ rows: [{ status: 'sent' }] }) });
      assert.equal(r.open, false, id);
    }
  });

  it('an open reply is left to the normal handler and sends nothing', async () => {
    let fetched = 0;
    const closed = await guard.noticeIfClosed(act('open_edit_modal'), interaction, {
      query: async () => ({ rows: [{ status: 'pending' }] }), fetchImpl: async () => { fetched += 1; return { ok: true }; },
    });
    assert.equal(closed, false);
    assert.equal(fetched, 0);
  });

  it('per-button open states: reject only on pending, DQ and booked also on alert_only', async () => {
    const q = (status) => async () => ({ rows: [{ status }] });
    assert.equal((await guard.checkReplyOpen('reject_reply', 'r1', { query: q('flagged') })).open, false);
    assert.equal((await guard.checkReplyOpen('dq_prospect', 'r1', { query: q('alert_only') })).open, true);
    assert.equal((await guard.checkReplyOpen('meeting_booked', 'r1', { query: q('alert_only') })).open, true);
    assert.equal((await guard.checkReplyOpen('open_edit_modal', 'r1', { query: q('alert_only') })).open, false);
  });

  it('a missing reply gets a notice too; unrelated buttons and lookup errors fail open', async () => {
    const posted = [];
    const fetchImpl = async (u, o) => { posted.push(JSON.parse(o.body).text); return { ok: true }; };
    assert.equal(await guard.noticeIfClosed(act('reject_reply'), interaction, { query: async () => ({ rows: [] }), fetchImpl }), true);
    assert.match(posted[0], /no longer open/);
    assert.equal(await guard.noticeIfClosed(act('fseq_call_now'), interaction, { query: async () => { throw new Error('x'); }, fetchImpl }), false);
    assert.equal(await guard.noticeIfClosed(act('toggle_cc_client'), interaction, { fetchImpl }), false);
    assert.equal(await guard.noticeIfClosed(act('open_edit_modal'), interaction, { query: async () => { throw new Error('db down'); }, fetchImpl }), false);
    assert.equal(posted.length, 1);
  });

  it('a failing Slack post or no response_url never throws', async () => {
    assert.equal(await guard.sendEphemeralNotice({}, 'x'), false);
    assert.equal(await guard.sendEphemeralNotice(interaction, 'x', { fetchImpl: async () => { throw new Error('net'); } }), false);
  });
});

describe('wiring', () => {
  it('the actions route runs the guard after Action received, and approve still reaches its handler', () => {
    const src = read('src/routes/slack.js');
    assert.match(src, /noticeIfClosed\(action, interaction\)/);
    assert.match(src, /startsWith\('approve_reply'\)/);
    assert.ok(src.indexOf("'[Slack] Action received'") < src.indexOf('noticeIfClosed(action'));
  });

  it('every closer that retires sibling or bridge cards calls retireSlackCards', () => {
    assert.match(read('src/services/booking-bridge.js'), /retireSlackCards\(closed\.rows/);
    assert.match(read('src/services/meeting-booked.js'), /retireSlackCards\(siblings\?\.rows/);
    assert.match(read('src/services/disqualified-prospects.js'), /retireSlackCards\(siblings\?\.rows/);
  });
});
