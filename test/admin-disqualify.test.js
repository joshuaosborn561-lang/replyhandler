const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { disqualifyFromAdmin, cleanNote } = require('../src/services/admin-disqualify');

const REPLY_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

function reply(over = {}) {
  return {
    id: REPLY_ID, client_id: CLIENT_ID, platform: 'smartlead', campaign_id: '77', lead_id: '9',
    lead_name: 'Fixture Lead', lead_email: 'fixture@example.test', classification: 'INTERESTED',
    status: 'pending', slack_message_ts: '1700000000.000100', thread_context: [], ...over,
  };
}

function makeDeps({ row = reply(), already = false, cardFails = false } = {}) {
  const calls = { queries: [], mark: [], card: [] };
  const deps = {
    db: {
      async query(sql, params) {
        calls.queries.push({ sql, params });
        if (/FROM clients/i.test(sql)) return { rows: [{ id: CLIENT_ID, name: 'Fixture Client', slack_bot_token: 'xoxb-fixture', slack_channel_id: 'C0CLIENT01' }] };
        if (/FROM pending_replies/i.test(sql)) return { rows: row ? [row] : [] };
        return { rows: [] };
      },
    },
    withSmartleadKey: (c) => c,
    dq: {
      isDisqualified: async () => already,
      threadKeys: () => ({}),
      markDisqualified: async (args) => { calls.mark.push(args); return { cancelledFollowUps: 2, already }; },
    },
    cardHelpers: {
      slackCardContextFromReply: async () => ({ campaignDisplay: 'c' }),
      sentCardPayload: (r, ctx, opts) => ({ ...opts, leadName: r.lead_name }),
    },
    slackService: {
      updateSentConfirmationCard: async (token, channel, ts, payload) => {
        if (cardFails) throw new Error('channel_not_found');
        calls.card.push({ token, channel, ts, payload });
      },
    },
  };
  return { deps, calls };
}

test('cleanNote tags the reason and caps the note', () => {
  assert.equal(cleanNote(), 'admin_dq');
  assert.equal(cleanNote('  out of   ICP '), 'admin_dq: out of ICP');
  assert.ok(cleanNote('x'.repeat(500)).length <= 'admin_dq: '.length + 200);
});

test('validates input', async () => {
  assert.equal((await disqualifyFromAdmin({})).http, 400);
  assert.equal((await disqualifyFromAdmin({ replyId: 'nope' })).http, 400);
  assert.equal((await disqualifyFromAdmin({ clientId: CLIENT_ID })).http, 400);
  assert.equal((await disqualifyFromAdmin({ clientId: 'x', leadEmail: 'a@b.test' })).http, 400);
});

test('unknown lead is 404', async () => {
  const { deps } = makeDeps({ row: null });
  const out = await disqualifyFromAdmin({ replyId: REPLY_ID }, deps);
  assert.equal(out.http, 404);
});

test('dry run reports and writes nothing', async () => {
  const { deps, calls } = makeDeps();
  const out = await disqualifyFromAdmin({ replyId: REPLY_ID, dryRun: true }, deps);
  assert.equal(out.http, 200);
  assert.equal(out.body.dryRun, true);
  assert.equal(out.body.wouldRecordDq, true);
  assert.equal(calls.mark.length, 0);
  assert.equal(calls.card.length, 0);
});

test('DQ by reply id: same markDisqualified call as the button, card closed as disqualified', async () => {
  const { deps, calls } = makeDeps();
  const out = await disqualifyFromAdmin({ replyId: REPLY_ID, note: 'not ICP' }, deps);
  assert.equal(out.http, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.cancelledFollowUps, 2);
  assert.equal(out.body.cardUpdated, true);
  assert.equal(calls.mark.length, 1);
  assert.equal(calls.mark[0].clientId, CLIENT_ID);
  assert.equal(calls.mark[0].reason, 'admin_dq: not ICP');
  assert.equal(calls.mark[0].slackUserId, null);
  assert.equal(calls.card[0].channel, 'C0CLIENT01');
  assert.equal(calls.card[0].ts, '1700000000.000100');
  assert.equal(calls.card[0].payload.actionKind, 'disqualified');
});

test('DQ by client + email resolves the lead\'s reply', async () => {
  const { deps, calls } = makeDeps();
  const out = await disqualifyFromAdmin({ clientId: CLIENT_ID, leadEmail: ' Fixture@Example.test ' }, deps);
  assert.equal(out.http, 200);
  const q = calls.queries.find((c) => /lower\(coalesce\(lead_email/.test(c.sql));
  assert.ok(q, 'looked up by email');
  assert.equal(q.params[1], 'fixture@example.test');
});

test('a follow-up card is closed in the follow-ups channel', async () => {
  const { deps, calls } = makeDeps({ row: reply({ classification: 'FOLLOW_UP' }) });
  await disqualifyFromAdmin({ replyId: REPLY_ID }, deps);
  assert.notEqual(calls.card[0].channel, 'C0CLIENT01');
});

test('a reply that is already actioned is DQ\'d but its card is left alone', async () => {
  const { deps, calls } = makeDeps({ row: reply({ status: 'sent' }) });
  const out = await disqualifyFromAdmin({ replyId: REPLY_ID }, deps);
  assert.equal(out.http, 200);
  assert.equal(calls.mark.length, 1);
  assert.equal(out.body.cardUpdated, false);
  assert.equal(calls.card.length, 0);
});

test('already disqualified is idempotent', async () => {
  const { deps } = makeDeps({ already: true });
  const out = await disqualifyFromAdmin({ replyId: REPLY_ID }, deps);
  assert.equal(out.body.alreadyDisqualified, true);
});

test('a Slack failure does not undo the DQ', async () => {
  const { deps, calls } = makeDeps({ cardFails: true });
  const out = await disqualifyFromAdmin({ replyId: REPLY_ID }, deps);
  assert.equal(out.http, 200);
  assert.equal(calls.mark.length, 1);
  assert.equal(out.body.cardUpdated, false);
  assert.match(out.body.cardError, /channel_not_found/);
});

test('POST /admin/disqualify rejects an empty body with 400', async () => {
  const { createApp } = require('../src/app');
  const server = await new Promise((resolve) => {
    const s = http.createServer(createApp());
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/admin/disqualify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the Slack route exposes the card helpers the admin DQ uses', () => {
  const slackRoute = require('../src/routes/slack');
  assert.equal(typeof slackRoute.cardHelpers.slackCardContextFromReply, 'function');
  assert.equal(typeof slackRoute.cardHelpers.sentCardPayload, 'function');
});
