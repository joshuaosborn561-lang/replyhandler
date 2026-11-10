/**
 * POST /admin/heyreach/upgrade-alert-card
 *
 * A HeyReach reply recovered by the polling backstop was posted as an alert
 * (status alert_only, no draft). This endpoint writes a draft onto that SAME
 * row and chat.update's the SAME Slack message into the normal HeyReach
 * approval card. It never posts a new message, never inserts a row, and never
 * sends. Slack and HeyReach are mocked; nothing here touches the network
 * (the HTTP test talks to an in-process server on 127.0.0.1).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Stub the database module before anything requires it (the HTTP test mounts the real app).
const dbStub = { impl: null, async query(sql, params) { return dbStub.impl(sql, params); } };
require.cache[require.resolve('../src/db')] = {
  id: 'db', filename: 'db', loaded: true, exports: dbStub,
};
for (const k of ['HEYREACH_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'ADMIN_API_KEY']) delete process.env[k];

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { upgradeHeyreachAlertCard, UPGRADE_MARKER } = require('../src/services/heyreach-upgrade-alert-card');
const { prepareHeyreachDraftCard } = require('../src/services/heyreach-card-gate');
const slack = require('../src/services/slack');
const poller = require('../src/services/heyreach-poller');

const REPLY_ID = 'b7c3f80d-794e-46d6-9534-9e47a9756fce';
const TS = '1794000184.771089';
const CHANNEL = 'C-NUTTER-AI';
const DRAFT = 'Glad we connected, Richard. Sounds like the timing lines up. Do you have 20 minutes Thursday or Friday to talk through what you need?';
const SECRET = 'hr-secret-key-should-never-leak';

function heyreachRow(over = {}) {
  return {
    id: REPLY_ID,
    client_id: 'client-nutter',
    client_name: 'Nutter',
    slack_bot_token: 'xoxb-test',
    client_active: true,
    platform: 'heyreach',
    campaign_id: '123',
    campaign_name: 'Nutter LI',
    lead_id: 'lead-richard',
    lead_name: 'Richard Broadbent',
    linkedin_url: 'https://www.linkedin.com/in/richard-broadbent',
    inbound_message: 'Timing is good, happy to talk.',
    classification: 'OTHER',
    draft_reply: null,
    sent_reply: null,
    status: 'alert_only',
    slack_message_ts: TS,
    slack_channel_id: CHANNEL,
    heyreach_api_key: SECRET,
    thread_context: {
      messages: [
        { role: 'us', message: 'Hi Richard, thanks for connecting.' },
        { role: 'prospect', message: 'Timing is good, happy to talk.' },
      ],
      heyreach: { conversationId: 'conv-1', linkedinAccountId: 4242, linkedinUrl: 'https://www.linkedin.com/in/richard-broadbent' },
    },
    created_at: '2026-11-09T15:00:00.000Z',
    ...over,
  };
}

/** In-memory pending_replies with one row. Records every write; INSERT fails the test. */
function fakeDb(initial) {
  const state = { row: { ...initial }, updates: [], inserts: [], queries: [] };
  state.query = async (sql, params = []) => {
    state.queries.push(sql);
    if (/INSERT\s+INTO/i.test(sql)) {
      state.inserts.push(sql);
      throw new Error('upgrade must not insert a row');
    }
    if (/FROM pending_replies pr\s+JOIN clients c/i.test(sql)) {
      return { rows: params[0] === state.row.id ? [{ ...state.row }] : [] };
    }
    if (/SELECT thread_context FROM pending_replies/i.test(sql)) {
      return { rows: [{ thread_context: state.row.thread_context }] };
    }
    if (/UPDATE pending_replies\s+SET thread_context = \$1::jsonb,\s+linkedin_url/i.test(sql)) {
      state.updates.push({ kind: 'ids', params });
      state.row.thread_context = JSON.parse(params[0]);
      return { rows: [] };
    }
    if (/UPDATE pending_replies\s+SET draft_reply = \$1/i.test(sql)) {
      state.updates.push({ kind: 'upgrade', params });
      const [draft, cls, ctx, , allowPending] = params;
      const r = state.row;
      const ok = r.platform === 'heyreach' && !r.sent_reply
        && (r.status === 'alert_only' || (r.status === 'pending' && allowPending));
      if (!ok) return { rows: [] };
      Object.assign(r, { draft_reply: draft, classification: cls, status: 'pending', thread_context: JSON.parse(ctx) });
      return { rows: [{ id: r.id, status: r.status }] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 120)}`);
  };
  return state;
}

/** Slack mock: chat.update renders the real approval blocks; any post fails the test. */
function fakeSlack() {
  const calls = { update: [], post: [] };
  return {
    calls,
    api: {
      async updateDraftApprovalCard(token, channel, ts, opts) {
        const { blocks } = slack.buildDraftApprovalCard(opts);
        calls.update.push({ token, channel, ts, opts, blocks });
        return { ok: true, ts };
      },
      async updateAlertCard() { throw new Error('must render the approval card, not an alert'); },
      async postDraftApproval() { calls.post.push('postDraftApproval'); throw new Error('chat.postMessage is not allowed'); },
      async postAlert() { calls.post.push('postAlert'); throw new Error('chat.postMessage is not allowed'); },
    },
  };
}

function actionIds(blocks) {
  return (blocks || [])
    .filter((b) => b && b.type === 'actions')
    .flatMap((b) => (b.elements || []).map((el) => el.action_id));
}

function deps(db, slackFake, extra = {}) {
  return {
    dbClient: db,
    slackApi: slackFake.api,
    loadCard: async () => null,
    saveCard: () => {},
    prepareFn: (args) => prepareHeyreachDraftCard({
      ...args,
      lookupSibling: async () => null,
      findConversation: async () => { throw new Error('HeyReach should not be called when ids are stored'); },
    }),
    ...extra,
  };
}

test('happy path: alert_only HeyReach row becomes a pending approval card via chat.update only', async () => {
  const db = fakeDb(heyreachRow());
  const s = fakeSlack();
  const out = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s));

  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
  assert.equal(out.body.replyId, REPLY_ID);
  assert.equal(out.body.status, 'pending');
  assert.equal(out.body.slackChannelId, CHANNEL);
  assert.equal(out.body.slackMessageTs, TS);
  assert.equal(out.body.idsBackfilled, false);
  assert.equal(out.body.sent, false);

  assert.equal(db.row.status, 'pending');
  assert.equal(db.row.draft_reply, DRAFT);
  assert.equal(db.row.classification, 'INTERESTED');
  assert.ok(db.row.thread_context.heyreach[UPGRADE_MARKER]);
  assert.equal(db.row.thread_context.heyreach.conversationId, 'conv-1');
  assert.equal(db.inserts.length, 0);

  assert.equal(s.calls.update.length, 1);
  assert.equal(s.calls.post.length, 0);
  const [call] = s.calls.update;
  assert.equal(call.channel, CHANNEL);
  assert.equal(call.ts, TS);
  const ids = actionIds(call.blocks);
  assert.ok(ids.includes('approve_reply'), `Approve missing: ${ids}`);
  assert.ok(ids.includes('open_edit_modal'), `Edit missing: ${ids}`);
  assert.equal(call.opts.draft, DRAFT);
  assert.equal(call.opts.platform, 'heyreach');
  // PR #220: HeyReach cards link to the Unibox conversation.
  const urls = call.blocks.flatMap((b) => (b.elements || []).map((el) => el.url)).filter(Boolean);
  assert.ok(urls.includes('https://app.heyreach.io/app/inbox/4242/conv-1'), urls.join(','));
  assert.ok(!JSON.stringify(call).includes(SECRET), 'API key must never reach the card');
});

test('refuses a non-HeyReach (Smartlead email) row', async () => {
  const db = fakeDb(heyreachRow({ platform: 'smartlead', lead_email: 'r@example.com' }));
  const s = fakeSlack();
  const out = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s));
  assert.equal(out.status, 400);
  assert.match(out.body.error, /not a HeyReach reply/);
  assert.equal(db.updates.length, 0);
  assert.equal(s.calls.update.length + s.calls.post.length, 0);
});

test('refuses rows that are not alert_only', async () => {
  for (const status of ['pending', 'flagged', 'rejected', 'suppressed', 'skipped', 'meeting_booked', 'superseded', 'disqualified', 'failed']) {
    const db = fakeDb(heyreachRow({ status, draft_reply: status === 'pending' ? 'old' : null }));
    const s = fakeSlack();
    const out = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s));
    assert.equal(out.status, 409, status);
    assert.match(out.body.error, /only an alert_only HeyReach card can be upgraded/, status);
    assert.equal(db.updates.length, 0, status);
    assert.equal(s.calls.update.length, 0, status);
  }
});

test('refuses already-sent rows, including a previously upgraded one', async () => {
  for (const over of [
    { status: 'sent', sent_reply: 'hi' },
    { status: 'sending' },
    { status: 'approved' },
    { status: 'alert_only', sent_reply: 'already went out' },
  ]) {
    const db = fakeDb(heyreachRow(over));
    const s = fakeSlack();
    const out = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s));
    assert.equal(out.status, 409, JSON.stringify(over));
    assert.match(out.body.error, /already sent/);
    assert.equal(db.updates.length, 0);
    assert.equal(s.calls.update.length + s.calls.post.length, 0);
  }
});

test('requires a non-empty draft, a reply id, and an existing Slack message', async () => {
  const s = fakeSlack();
  for (const draft of [undefined, '', '   ', 42]) {
    const out = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft }, deps(fakeDb(heyreachRow()), s));
    assert.equal(out.status, 400);
  }
  assert.equal((await upgradeHeyreachAlertCard({ draft: DRAFT }, deps(fakeDb(heyreachRow()), s))).status, 400);
  assert.equal((await upgradeHeyreachAlertCard({ reply_id: 'nope', draft: DRAFT }, deps(fakeDb(heyreachRow()), s))).status, 404);
  for (const over of [{ slack_message_ts: null }, { slack_channel_id: null }, { slack_message_ts: 'claiming:abc' }]) {
    const db = fakeDb(heyreachRow(over));
    const out = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s));
    assert.equal(out.status, 409, JSON.stringify(over));
    assert.match(out.body.error, /never posted/);
    assert.equal(db.updates.length, 0);
  }
  assert.equal(s.calls.update.length + s.calls.post.length, 0, 'no Slack call and no fallback post');
});

test('idempotent: a second call does not post a new message or insert a row', async () => {
  const db = fakeDb(heyreachRow());
  const s = fakeSlack();
  const first = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s));
  assert.equal(first.status, 200);
  const upgradesAfterFirst = db.updates.filter((u) => u.kind === 'upgrade').length;

  const again = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.alreadyUpgraded, true);
  assert.equal(again.body.draftChanged, false);
  assert.equal(db.updates.filter((u) => u.kind === 'upgrade').length, upgradesAfterFirst, 'same draft is not rewritten');

  const edited = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: 'New draft text.' }, deps(db, s));
  assert.equal(edited.status, 200);
  assert.equal(edited.body.draftChanged, true);
  assert.equal(db.row.draft_reply, 'New draft text.');
  assert.equal(db.row.status, 'pending');

  assert.equal(s.calls.post.length, 0);
  assert.ok(s.calls.update.every((c) => c.ts === TS && c.channel === CHANNEL));
  assert.equal(db.inserts.length, 0);

  db.row.status = 'sent';
  db.row.sent_reply = 'New draft text.';
  const afterSend = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: 'Another' }, deps(db, s));
  assert.equal(afterSend.status, 409);
  assert.equal(db.row.draft_reply, 'New draft text.');
});

test('missing conversation / LinkedIn account id: looked up via HeyReach, stored, then the card updates', async () => {
  const row = heyreachRow({ thread_context: { messages: [{ role: 'prospect', message: 'Timing is good.' }], heyreach: {} } });
  const db = fakeDb(row);
  const s = fakeSlack();
  const lookups = [];
  const out = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s, {
    prepareFn: (args) => prepareHeyreachDraftCard({
      ...args,
      lookupSibling: async () => null,
      findConversation: async (key, q) => {
        lookups.push({ keyMatches: key === SECRET, q });
        return { id: 'conv-found', linkedInAccount: { id: 9001 }, correspondentProfile: { profileUrl: row.linkedin_url } };
      },
    }),
  }));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.idsBackfilled, true);
  assert.equal(out.body.conversationId, 'conv-found');
  assert.equal(out.body.linkedInAccountId, 9001);
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].keyMatches, true, 'uses the client stored HeyReach key');
  assert.equal(db.row.thread_context.heyreach.conversationId, 'conv-found');
  assert.equal(db.row.thread_context.heyreach.linkedinAccountId, 9001);
  assert.ok(db.row.thread_context.heyreach[UPGRADE_MARKER]);
  assert.equal(s.calls.update.length, 1);
  assert.ok(actionIds(s.calls.update[0].blocks).includes('approve_reply'));
  assert.ok(!JSON.stringify(out.body).includes(SECRET));
});

test('lookup failure: error returned, no Approve, row and Slack message untouched, nothing sent', async () => {
  for (const findConversation of [
    async () => null,
    async () => { throw new Error(`HeyReach 500 for key ${SECRET}`); },
    async () => ({ id: 'conv-only' }), // no account id
  ]) {
    const row = heyreachRow({ thread_context: { messages: [], heyreach: {} } });
    const db = fakeDb(row);
    const s = fakeSlack();
    const out = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s, {
      prepareFn: (args) => prepareHeyreachDraftCard({ ...args, lookupSibling: async () => null, findConversation }),
    }));
    assert.equal(out.status, 409);
    assert.match(out.body.error, /could not be resolved/);
    assert.ok(out.body.missing.includes('linkedInAccountId'));
    assert.ok(!JSON.stringify(out.body).includes(SECRET));
    assert.equal(db.row.status, 'alert_only');
    assert.equal(db.row.draft_reply, null);
    assert.equal(db.updates.filter((u) => u.kind === 'upgrade').length, 0);
    assert.equal(s.calls.update.length, 0, 'Slack message must not become a sendable card');
    assert.equal(s.calls.post.length, 0);
  }

  // No HeyReach key on the client: same refusal, HeyReach never called.
  const db = fakeDb(heyreachRow({ heyreach_api_key: null, thread_context: { heyreach: {} } }));
  const s = fakeSlack();
  let called = false;
  const out = await upgradeHeyreachAlertCard({ reply_id: REPLY_ID, draft: DRAFT }, deps(db, s, {
    prepareFn: (args) => prepareHeyreachDraftCard({
      ...args, lookupSibling: async () => null, findConversation: async () => { called = true; return null; },
    }),
  }));
  assert.equal(out.status, 409);
  assert.ok(out.body.missing.includes('client heyreach_api_key'));
  assert.equal(called, false);
  assert.equal(s.calls.update.length, 0);
});

test('the upgrade service cannot send or post a new Slack message', () => {
  const src = read('src/services/heyreach-upgrade-alert-card.js');
  assert.doesNotMatch(src, /sendReplyToPlatform|require\('\.\/reply-send'\)|heyreach\.sendMessage|sendMessage\(/);
  assert.doesNotMatch(src, /chat\.postMessage|postDraftApproval|postAlert\(|postProspectSlackCard/);
  assert.doesNotMatch(src, /INSERT INTO/i);
  assert.match(src, /updateDraftApprovalCard/);
});

test('backstop: poller stores the conversation id and the nested LinkedIn account id', () => {
  const conv = { id: 'conv-77', linkedInAccount: { id: 555, emailAddress: 'x' }, messages: [] };
  assert.equal(poller.conversationId(conv), 'conv-77');
  assert.equal(poller.linkedInAccountId(conv), 555);
  assert.equal(poller.linkedInAccountId({ linkedInAccountId: 12 }), 12);
  const src = read('src/services/heyreach-poller.js');
  assert.match(src, /linkedinAccountId: linkedInAccountId\(conv\)/);
  assert.match(src, /conversationId: convId/);
});

test('backstop: an alert card (isDraft false) resolves and stores send ids without a name search', async () => {
  const db = fakeDb(heyreachRow({ thread_context: { messages: [], heyreach: { conversationId: 'conv-1' } } }));
  const seen = [];
  const prep = await prepareHeyreachDraftCard({
    replyId: REPLY_ID,
    card: { leadLinkedinUrl: 'https://www.linkedin.com/in/richard-broadbent' },
    dbClient: db,
    isDraft: false,
    lookupSibling: async () => null,
    findConversation: async (_key, q) => { seen.push(q); return { id: 'conv-1', linkedInAccountId: 31 }; },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].allowNameSearch, false);
  assert.ok(seen[0].maxPages <= 3);
  assert.equal(prep.linkedInAccountId, 31);
  assert.equal(db.row.thread_context.heyreach.linkedinAccountId, 31);
  assert.equal(db.row.thread_context.heyreach.conversationId, 'conv-1');
  assert.equal(db.row.status, 'alert_only', 'no auto-upgrade');
  assert.equal(db.row.draft_reply, null, 'no auto-draft');

  // Ids already stored: no HeyReach call at all.
  const db2 = fakeDb(heyreachRow());
  await prepareHeyreachDraftCard({
    replyId: REPLY_ID, card: {}, dbClient: db2, isDraft: false,
    lookupSibling: async () => { throw new Error('not needed'); },
    findConversation: async () => { throw new Error('not needed'); },
  });
  assert.equal(db2.updates.length, 0);
});

test('admin auth matches the other /admin routes (open, no ADMIN_API_KEY) and the route is wired', async () => {
  const admin = read('src/routes/admin.js');
  assert.match(admin, /router\.post\('\/admin\/heyreach\/upgrade-alert-card', async/);
  assert.doesNotMatch(admin, /requireAdminApiKey/);
  // The existing endpoint keeps refusing a row that already has a card.
  assert.match(read('src/services/heyreach-approval-card.js'), /card_already_posted/);

  const db = fakeDb(heyreachRow({ platform: 'smartlead' }));
  dbStub.impl = db.query;
  const { createApp } = require('../src/app');
  const server = await new Promise((resolve) => {
    const srv = http.createServer(createApp());
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/admin/heyreach/upgrade-alert-card`;
    const noDraft = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply_id: REPLY_ID }),
    });
    assert.equal(noDraft.status, 400, 'reached the handler with no key, like every /admin route');
    const smartlead = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply_id: REPLY_ID, draft: DRAFT }),
    });
    assert.equal(smartlead.status, 400);
    const body = await smartlead.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /not a HeyReach reply/);
    assert.equal(db.inserts.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
