const test = require('node:test');
const assert = require('node:assert');
process.env.RAILWAY_PUBLIC_DOMAIN = 'rh.example';
const { withSmartleadKey, routeClientForCampaign, loadRoutes, resetCampaignRouteCache } = require('../src/services/campaign-routing');
const { upsertOnboardingClient } = require('../src/routes/onboarding');

const SG = { id: 'sg', name: 'SalesGlider', smartlead_api_key: 'sg-key', active: true, slack_channel_id: 'CSG' };
const VEC = { id: 'vec', name: 'Vector', smartlead_api_key: null, smartlead_use_master_key: true, active: true, slack_bot_token: 'xoxb-v', slack_channel_id: 'C0CC420V1TK', booking_link: 'https://book.gosalesglider.com/vector' };
const q = async (sql, p) => ({ rows: [VEC, SG].filter((c) => c.id === p[0]) });

test('unmapped campaign returns the same client object (behavior unchanged)', async () => {
  const r = await routeClientForCampaign(SG, '999', { query: q, routes: new Map([['4236533', 'vec']]) });
  assert.strictEqual(r, SG);
  assert.strictEqual(await routeClientForCampaign(SG, '999', { query: q, routes: new Map() }), SG);
  assert.strictEqual(await routeClientForCampaign(SG, null, { query: q, routes: new Map([['4236533', 'vec']]) }), SG);
});

test('route to self or to inactive/missing client is a no-op', async () => {
  assert.strictEqual(await routeClientForCampaign(SG, '1', { query: q, routes: new Map([['1', 'sg']]) }), SG);
  assert.strictEqual(await routeClientForCampaign(SG, '1', { query: q, routes: new Map([['1', 'gone']]) }), SG);
});

test('mapped campaign goes to the routed client; key from env master / source', async () => {
  const r = await routeClientForCampaign(SG, 4236533, { query: q, routes: new Map([['4236533', 'vec']]), env: { SMARTLEAD_MASTER_API_KEY: 'master' } });
  assert.strictEqual(r.id, 'vec');
  assert.strictEqual(r.slack_channel_id, 'C0CC420V1TK');
  assert.strictEqual(r.booking_link, 'https://book.gosalesglider.com/vector');
  assert.strictEqual(r.smartlead_api_key, 'master');
  const r2 = await routeClientForCampaign(SG, '4236533', { query: q, routes: new Map([['4236533', 'vec']]), env: {} });
  assert.strictEqual(r2.smartlead_api_key, 'sg-key');
});

test('withSmartleadKey leaves normal clients identical', () => {
  assert.strictEqual(withSmartleadKey(SG, { SMARTLEAD_MASTER_API_KEY: 'm' }), SG);
  const plain = { id: 'x', smartlead_api_key: null };
  assert.strictEqual(withSmartleadKey(plain, { SMARTLEAD_MASTER_API_KEY: 'm' }), plain);
  assert.strictEqual(withSmartleadKey(undefined), undefined);
  assert.strictEqual(withSmartleadKey(VEC, { SMARTLEAD_MASTER_API_KEY: 'm' }).smartlead_api_key, 'm');
  assert.strictEqual(VEC.smartlead_api_key, null);
});

test('route load failure = unmapped', async () => {
  resetCampaignRouteCache();
  const m = await loadRoutes(async () => { throw new Error('no table'); });
  assert.strictEqual(m.size, 0);
});

test('onboarding: campaign without key routes it, hooks with master, never stores master', async () => {
  const sqls = [];
  let row;
  const fq = async (sql, p) => {
    sqls.push([sql, p]);
    if (/SELECT slack_bot_token/.test(sql)) return { rows: [{ slack_bot_token: 'xoxb-d' }] };
    if (/lower\(name\)/.test(sql)) return { rows: [] };
    if (/^INSERT INTO clients/.test(sql)) { row = { id: 'vec', name: p[0], slack_bot_token: p[1], slack_channel_id: p[2], booking_link: p[3], smartlead_api_key: p[5], active: true }; return { rows: [row] }; }
    if (/smartlead_use_master_key = true/.test(sql)) return { rows: [{ ...row, smartlead_use_master_key: true }] };
    return { rows: [] };
  };
  const made = [];
  const sl = { listCampaignWebhooks: async (k) => { made.push(['list', k]); return []; }, webhookHasEmailReply: () => false,
    createEmailReplyWebhook: async (k, c, u) => made.push(['create', k, c, u]) };
  const r = await upsertOnboardingClient({ name: 'Vector Energy Group', slack_channel_id: 'C0CC420V1TK', smartlead_campaign_id: '4236533' },
    { query: fq, smartlead: sl, env: { SMARTLEAD_MASTER_API_KEY: 'MASTERKEY' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.campaign_route.campaign_id, '4236533');
  assert.deepStrictEqual(made[1], ['create', 'MASTERKEY', '4236533', 'https://rh.example/webhook/smartlead/vec']);
  const insert = sqls.find(([s]) => /^INSERT INTO clients/.test(s));
  assert.strictEqual(insert[1][5], null);
  assert.ok(!sqls.some(([, p]) => (p || []).includes('MASTERKEY')));
  assert.ok(!JSON.stringify(r.json).includes('MASTERKEY'));
  assert.ok(sqls.some(([s]) => /INSERT INTO smartlead_campaign_routes/.test(s)));
});

test('onboarding: existing webhook is not duplicated', async () => {
  const fq = async (sql, p) => {
    if (/lower\(name\)/.test(sql)) return { rows: [{ ...VEC }] };
    if (/^UPDATE/.test(sql)) return { rows: [{ ...VEC }] };
    return { rows: [] };
  };
  let created = 0;
  const sl = { listCampaignWebhooks: async () => [{}], webhookHasEmailReply: () => true, createEmailReplyWebhook: async () => { created++; } };
  const r = await upsertOnboardingClient({ name: 'Vector', smartlead_campaign_id: '4236533' }, { query: fq, smartlead: sl, env: { SMARTLEAD_MASTER_API_KEY: 'M' } });
  assert.strictEqual(created, 0);
  assert.strictEqual(r.json.webhook.created, false);
});
