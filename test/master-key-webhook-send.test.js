/**
 * Per-client Smartlead key cut (Josh, Nov 11 2026), end to end:
 *   - POST /webhook/smartlead/:clientId (real router, real routing) for every
 *     client slug in the repo, with every per-client key null / '' / revoked,
 *     posted to the WRONG client's webhook URL. Client, Slack channel, and every
 *     Smartlead call must come from the campaign's sg-owner tag + master key.
 *   - Approved send (sendReplyToPlatform → reply-email-thread) on a sub-client
 *     campaign uses the master key.
 *
 * No network: fake Smartlead over global.fetch (401 for any non-master key),
 * all other hosts and http(s) requests throw. DB is in-memory.
 */
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers/master-key-harness');

H.setMasterEnv();
H.blockRealNetwork();
const SLACK_POSTS = H.stubSlackWebClient();
void SLACK_POSTS;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SLACK_BOT_TOKEN', 'DATABASE_URL']) delete process.env[k];
process.env.RAILWAY_PUBLIC_DOMAIN = 'rh.example';
process.env.PROSPECT_REPLY_NOTIFY_MODE = 'off';

const ROSTER = H.buildRoster();
const CAMPAIGNS = new Map();
H.CLIENT_FIXTURES.forEach(([slug], i) => {
  CAMPAIGNS.set(String(6000 + i), { name: `Sequence ${6000 + i}`, tags: [{ id: i, name: `sg-owner:${slug}` }] });
});

const HISTORY = {
  history: [
    { type: 'SENT', time: '2026-11-10T15:00:00.000Z', email_body: 'Quick question', from: 'josh@gosalesglider.com', to: 'prospect@example.org', stats_id: 'st-1', message_id: '<sent-1@x>' },
    { type: 'REPLY', time: '2026-11-11T15:00:00.000Z', email_body: 'Yes, this is interesting. Can we talk Tuesday?', from: 'prospect@example.org', message_id: '<r-1@x>' },
  ],
};

// ── Stubs installed before the router loads (it destructures at require time) ──
const captured = { accepted: [], cards: [], cancelled: [] };
H.installDb(ROSTER);

const inbound = require('../src/services/smartlead-inbound');
inbound.acceptInboundDelivery = async (args) => {
  captured.accepted.push(args);
  return { reply: { id: `reply-${captured.accepted.length}`, client_id: args.clientId } };
};
const followUp = require('../src/services/outbound-follow-up');
followUp.cancelForInboundReply = async (args) => { captured.cancelled.push(args); };
const classifier = require('../src/services/classifier');
classifier.classifyAndDraft = async () => ({
  classification: 'INTERESTED', confidence: 0.99, reasoning: 'test', draft: 'Thanks. Tuesday works.', proposed_time: null,
});
classifier.draftOnly = async () => 'Thanks. Tuesday works.';
const cardPost = require('../src/services/slack-reply-post');
cardPost.postProspectSlackCard = async (args) => {
  captured.cards.push({ token: args.token, channelId: args.channelId, clientId: args.clientId, campaignId: args.campaignId });
  return { ok: true, ts: '1.1' };
};

const express = require('express');
const router = require('../src/routes/webhooks');

async function withServer(fn) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

async function waitFor(pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

test('webhook intake: every repo client slug, keys null/revoked, wrong URL → tag owner client, Slack channel, master key only', async () => {
  const sl = H.installSmartleadFetch({ campaigns: CAMPAIGNS, history: HISTORY });
  try {
    await withServer(async (base) => {
      let i = 0;
      for (const [cid, camp] of CAMPAIGNS) {
        const slug = camp.tags[0].name.split(':')[1];
        const payload = H.emailReplyPayload({ campaignId: Number(cid), leadId: 80000 + i, slug, campaignName: camp.name });
        i += 1;
        const before = { accepted: captured.accepted.length, cards: captured.cards.length };
        // Always the SalesGlider URL: the URL must not decide the owner.
        const res = await fetch(`${base}/webhook/smartlead/client-salesglider`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.accepted, true, `${slug}: ${JSON.stringify(body)}`);
        const acc = captured.accepted[before.accepted];
        assert.strictEqual(acc.clientId, `client-${slug}`, `${slug}: stored under the wrong client`);
        await waitFor(() => captured.cards.length > before.cards);
        const card = captured.cards[before.cards];
        assert.ok(card, `${slug}: no Slack card was posted`);
        assert.strictEqual(card.channelId, H.slugChannel(slug), `${slug}: wrong Slack channel`);
        assert.strictEqual(card.clientId, `client-${slug}`);
        assert.strictEqual(card.token, `xoxb-test-${slug}`);
      }
    });
    const calls = sl.smartleadCalls();
    assert.ok(calls.length > 0);
    for (const c of calls) assert.strictEqual(c.apiKey, H.MASTER, `${c.method} ${c.path}`);
    // Thread history was read with the master key for every reply.
    const hist = calls.filter((c) => /\/message-history$/.test(c.path));
    assert.ok(hist.length >= CAMPAIGNS.size, `history fetched ${hist.length} times`);
    // Calendar hosts (scheduling slots) are refused offline; no Smartlead host may be.
    assert.ok(!sl.calls.some((c) => c.blocked && /smartlead/i.test(c.host)));
  } finally { sl.restore(); }
});

test('webhook intake: posted to the owner\'s own URL with a revoked stored key still uses the master key', async () => {
  const sl = H.installSmartleadFetch({ campaigns: CAMPAIGNS, history: HISTORY });
  const owner = ROSTER.find((c) => String(c.smartlead_api_key || '').startsWith(H.REVOKED_PREFIX));
  assert.ok(owner, 'fixture has a revoked-key client');
  const slug = owner.id.replace(/^client-/, '');
  const cid = [...CAMPAIGNS].find(([, c]) => c.tags[0].name === `sg-owner:${slug}`)[0];
  try {
    await withServer(async (base) => {
      const before = captured.cards.length;
      const res = await fetch(`${base}/webhook/smartlead/${owner.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(H.emailReplyPayload({ campaignId: Number(cid), leadId: 99001, slug })),
      });
      assert.strictEqual((await res.json()).accepted, true);
      await waitFor(() => captured.cards.length > before);
      assert.strictEqual(captured.cards[before].channelId, owner.slack_channel_id);
    });
    for (const c of sl.smartleadCalls()) assert.strictEqual(c.apiKey, H.MASTER, `${c.method} ${c.path}`);
  } finally { sl.restore(); }
});

test('webhook intake: untagged, unrouted campaign on a keyless client URL still accepts to that URL client with the master key', async () => {
  const sl = H.installSmartleadFetch({ campaigns: new Map([['6999', { name: 'Sequence 6999', tags: [] }]]), history: HISTORY });
  try {
    await withServer(async (base) => {
      const before = captured.accepted.length;
      const res = await fetch(`${base}/webhook/smartlead/client-bpltg`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(H.emailReplyPayload({ campaignId: 6999, leadId: 99002, slug: 'bpltg' })),
      });
      const body = await res.json();
      assert.strictEqual(body.accepted, true, JSON.stringify(body));
      assert.strictEqual(captured.accepted[before].clientId, 'client-bpltg');
    });
    for (const c of sl.smartleadCalls()) assert.strictEqual(c.apiKey, H.MASTER, `${c.method} ${c.path}`);
  } finally { sl.restore(); }
});

const REAL = H.loadRealPayloads();
const REAL_ROSTER = H.loadRealRoster();
test('real EMAIL_REPLY payloads through the webhook route (posted to the SalesGlider URL): tag owner client + channel, master key only', { skip: REAL && REAL_ROSTER ? false : 'fixture files not present' }, async () => {
  const urlClient = REAL_ROSTER.find((c) => c.name === 'SalesGlider' && c.active !== false);
  assert.ok(urlClient);
  H.installDb(REAL_ROSTER);
  const campaigns = new Map(REAL.map((e) => [String(e.campaign_id), { name: e.campaign_name, tags: e.tags }]));
  const sl = H.installSmartleadFetch({ campaigns, history: HISTORY });
  let checked = 0;
  const dropped = [];
  try {
    await withServer(async (base) => {
      for (const entry of REAL) {
        const want = H.expectedRealClient(entry, REAL_ROSTER);
        const before = { accepted: captured.accepted.length, cards: captured.cards.length };
        const res = await fetch(`${base}/webhook/smartlead/${urlClient.id}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry.payload),
        });
        const body = await res.json();
        if (!want) {
          // Ciotola (inactive): dropped. Never stored, never carded into the URL client's (SalesGlider) channel.
          assert.strictEqual(body.skipped, true, `${entry.sg_owner}: ${JSON.stringify(body)}`);
          assert.strictEqual(body.reason, 'owner_tag_inactive', entry.sg_owner);
          await new Promise((r) => setTimeout(r, 50));
          assert.strictEqual(captured.accepted.length, before.accepted, `${entry.sg_owner}: stored`);
          assert.strictEqual(captured.cards.length, before.cards, `${entry.sg_owner}: carded`);
          dropped.push(entry.sg_owner);
          continue;
        }
        assert.strictEqual(body.accepted, true, `${entry.sg_owner}: ${JSON.stringify(body)}`);
        assert.strictEqual(captured.accepted[before.accepted].clientId, want.id, `${entry.sg_owner}: stored under the wrong client`);
        await waitFor(() => captured.cards.length > before.cards);
        const card = captured.cards[before.cards];
        assert.ok(card, `${entry.sg_owner}: no card`);
        assert.strictEqual(card.channelId, H.expectedRealChannel(entry), `${entry.sg_owner}: wrong channel`);
        assert.strictEqual(card.clientId, want.id);
        checked += 1;
      }
    });
    assert.strictEqual(checked, REAL.length - 1, 'every entry but Ciotola is carded');
    assert.deepStrictEqual(dropped, ['ciotola']);
    for (const c of sl.smartleadCalls()) assert.strictEqual(c.apiKey, H.MASTER, `${c.method} ${c.path}`);
    // Every campaign's tags were read with include_tags=true (other getCampaign callers need not).
    const tagged = new Set(sl.smartleadCalls().filter((c) => c.includeTags).map((c) => c.path.replace(/\/$/, '')));
    for (const e of REAL) assert.ok(tagged.has(`/api/v1/campaigns/${e.campaign_id}`), `no include_tags fetch for ${e.campaign_id}`);
    assert.ok(!sl.calls.some((c) => c.blocked && /smartlead/i.test(c.host)));
  } finally { sl.restore(); H.installDb(ROSTER); }
});

test('approved send: reply-email-thread on a sub-client campaign uses the master key when the client key is revoked', async () => {
  const sl = H.installSmartleadFetch({ campaigns: CAMPAIGNS, history: HISTORY });
  const owner = ROSTER.find((c) => String(c.smartlead_api_key || '').startsWith(H.REVOKED_PREFIX));
  const slug = owner.id.replace(/^client-/, '');
  const cid = [...CAMPAIGNS].find(([, c]) => c.tags[0].name === `sg-owner:${slug}`)[0];
  const { sendReplyToPlatform } = require('../src/services/reply-send');
  const reply = {
    id: 'reply-send-1',
    _sendTracked: true,
    client_id: owner.id,
    platform: 'smartlead',
    campaign_id: cid,
    lead_id: '80123',
    lead_email: 'prospect@example.org',
    lead_name: 'Pat Prospect',
    classification: 'INTERESTED',
    smartlead_email_stats_id: 'st-1',
    thread_context: HISTORY,
  };
  // The send claims its pending_replies row first; serve it from memory.
  H.installDb(ROSTER, {
    onQuery: (sql, params) => {
      if (/FROM pending_replies WHERE id = \$1/.test(sql) && params[0] === reply.id) {
        return { rows: [{ ...reply, status: 'pending', updated_at: new Date().toISOString() }] };
      }
      return null;
    },
  });
  let err = null;
  try {
    await sendReplyToPlatform(owner, reply, 'Thanks. Tuesday works.');
  } catch (e) { err = e; } finally { sl.restore(); }
  const calls = sl.smartleadCalls();
  const send = calls.filter((c) => /\/reply-email-thread$/.test(c.path));
  assert.strictEqual(send.length, 1, `send not attempted (${err && err.message}); calls: ${calls.map((c) => c.path).join(', ')}`);
  for (const c of calls) assert.strictEqual(c.apiKey, H.MASTER, `${c.method} ${c.path}`);
  assert.ok(!sl.calls.some((c) => c.blocked && /smartlead/i.test(c.host)));
});

test.after(() => {
  // Report what is still holding the event loop (module timers), then let the run end.
  const live = process._getActiveHandles().map((h) => h.constructor && h.constructor.name);
  if (process.env.MASTER_KEY_TEST_DEBUG) console.error('active handles', live);
});
