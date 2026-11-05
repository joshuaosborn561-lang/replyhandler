const test = require('node:test');
const assert = require('node:assert');
process.env.RAILWAY_PUBLIC_DOMAIN = 'rh.example';
const {
  withSmartleadKey, routeClientForCampaign, loadRoutes, resetCampaignRouteCache,
  pollTargetsFromClients, applyAgencyKey, clientForSlug,
} = require('../src/services/campaign-routing');
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
  assert.strictEqual(await routeClientForCampaign(SG, '1', { query: q, routes: new Map([['1', 'sg']]), env: {} }), SG);
  assert.strictEqual(await routeClientForCampaign(SG, '1', { query: q, routes: new Map([['1', 'gone']]), env: {} }), SG);
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

test('withSmartleadKey leaves keyed clients identical and fills the agency key when the row has none', () => {
  assert.strictEqual(withSmartleadKey(SG, { SMARTLEAD_MASTER_API_KEY: 'm' }), SG);
  const plain = { id: 'x', smartlead_api_key: null, smartlead_use_master_key: false };
  assert.strictEqual(withSmartleadKey(plain, {}), plain);
  assert.strictEqual(withSmartleadKey(undefined), undefined);
  const filled = withSmartleadKey(plain, { SMARTLEAD_API_KEY: 'agency' });
  assert.strictEqual(filled.smartlead_api_key, 'agency');
  assert.strictEqual(plain.smartlead_api_key, null);
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

const BPL = {
  id: 'bpl', name: 'BPLTG', smartlead_api_key: null, smartlead_use_master_key: false,
  active: true, slack_channel_id: 'CBPL', slack_bot_token: 'xoxb-bpl',
};
const NUT = {
  id: 'nut', name: 'Nutter', smartlead_api_key: 'nut-key', smartlead_use_master_key: false,
  active: true, slack_channel_id: 'CNUT', slack_bot_token: 'xoxb-nut',
};
const AGENCY = { SMARTLEAD_MASTER_API_KEY: 'master' };
const roster = [SG, VEC, BPL, NUT];

test('sg-owner tag selects that client Slack channel and the agency key', async () => {
  const r = await routeClientForCampaign(SG, '55', {
    tags: [{ name: 'sg-owner:bpltg' }],
    routes: new Map([['55', 'sg']]),
    clients: roster,
    env: AGENCY,
    mode: 'master',
    campaignName: 'SalesGlider | Should Not Win',
  });
  assert.strictEqual(r.id, 'bpl');
  assert.strictEqual(r.slack_channel_id, 'CBPL');
  assert.notStrictEqual(r.slack_channel_id, SG.slack_channel_id);
  assert.strictEqual(r.smartlead_api_key, 'master');
  assert.strictEqual(r._ownerVia, 'tag');
  assert.strictEqual(BPL.smartlead_api_key, null);
  assert.strictEqual(SG.smartlead_api_key, 'sg-key');
});

test('routes are the fallback when the campaign has no owner tag', async () => {
  const r = await routeClientForCampaign(SG, '55', {
    tags: ['warmup'],
    routes: new Map([['55', 'bpl']]),
    clients: roster,
    env: AGENCY,
    mode: 'master',
    fetchTags: async () => { throw new Error('should not fetch when tags were passed'); },
  });
  assert.strictEqual(r.id, 'bpl');
  assert.strictEqual(r.slack_channel_id, 'CBPL');
  assert.notStrictEqual(r.slack_channel_id, 'CSG');
  assert.strictEqual(r._ownerVia, 'route');
  assert.strictEqual(r.smartlead_api_key, 'master');
});

test('BPLTG with no stored key and no master flag still resolves from a tag', async () => {
  assert.strictEqual(BPL.smartlead_use_master_key, false);
  assert.strictEqual(BPL.smartlead_api_key, null);
  const r = await routeClientForCampaign(
    { id: null, name: '(smartlead master)', smartlead_api_key: 'master', slack_channel_id: null },
    '90',
    { tags: ['sg-owner:bpltg'], routes: new Map(), clients: roster, env: AGENCY, mode: 'master' }
  );
  assert.strictEqual(r.id, 'bpl');
  assert.strictEqual(r.slack_channel_id, 'CBPL');
  assert.strictEqual(r.smartlead_api_key, 'master');
  assert.ok(r.slack_channel_id);
});

test('title heuristic is last and does not override a tag or a route', async () => {
  const titled = await routeClientForCampaign(SG, '91', {
    tags: [],
    routes: new Map(),
    clients: roster,
    env: AGENCY,
    mode: 'master',
    legacyOwner: null,
    campaignName: 'BPLTG | Owners',
  });
  assert.strictEqual(titled.id, 'bpl');
  assert.strictEqual(titled.slack_channel_id, 'CBPL');
  assert.strictEqual(titled._ownerVia, 'title');

  const tagged = await routeClientForCampaign(SG, '91', {
    tags: ['sg-owner:nutter'],
    routes: new Map([['91', 'bpl']]),
    clients: roster,
    env: AGENCY,
    mode: 'master',
    campaignName: 'BPLTG | Owners',
  });
  assert.strictEqual(tagged.id, 'nut');
  assert.strictEqual(tagged.slack_channel_id, 'CNUT');
  assert.notStrictEqual(tagged.slack_channel_id, 'CBPL');
});

test('a previously keyed client uses the agency key for a tagged campaign without clearing the stored key', async () => {
  const sent = await applyAgencyKey(NUT, '77', {
    env: AGENCY,
    tags: ['sg-owner:nutter'],
    clients: roster,
    routes: new Map(),
    fetchTags: async () => [],
  });
  assert.strictEqual(sent.id, 'nut');
  assert.strictEqual(sent.slack_channel_id, 'CNUT');
  assert.strictEqual(sent.smartlead_api_key, 'master');
  assert.strictEqual(NUT.smartlead_api_key, 'nut-key');
});

test('agency inbox does not guess a Slack channel when nothing identifies the campaign', async () => {
  const r = await routeClientForCampaign(
    { id: null, name: '(smartlead master)', smartlead_api_key: 'master', slack_channel_id: 'CSG' },
    '404',
    { tags: [], routes: new Map(), clients: roster, env: AGENCY, mode: 'master', legacyOwner: null, campaignName: 'Untitled sequence' }
  );
  assert.strictEqual(r, null);
});

test('owner slugs match client_map tags, including underscore forms', () => {
  const rows = [
    { id: '1', name: 'Culture Fits', active: true },
    { id: '2', name: 'Virtual Pulsar', active: true },
    { id: '3', name: 'Ciotola', active: true },
    { id: '4', name: 'Bolder Cyber Partners', active: true },
    { id: '5', name: 'Vector Energy Group', active: true },
  ];
  assert.strictEqual(clientForSlug('culture_fits', rows).id, '1');
  assert.strictEqual(clientForSlug('virtual_pulsar', rows).id, '2');
  assert.strictEqual(clientForSlug('ciotola', rows).id, '3');
  assert.strictEqual(clientForSlug('bcp', rows).id, '4');
  assert.strictEqual(clientForSlug('vector', rows).id, '5');
});

test('poll targets cover stored keys and one agency scan, including a keyless client only via that scan', () => {
  const targets = pollTargetsFromClients(roster, AGENCY);
  assert.strictEqual(targets.filter((t) => t.mode === 'master').length, 1);
  assert.ok(targets.some((t) => t.mode === 'client' && t.apiKey === 'sg-key'));
  assert.ok(targets.some((t) => t.mode === 'client' && t.apiKey === 'nut-key'));
  assert.ok(!targets.some((t) => t.client.id === 'bpl'));
  assert.strictEqual(targets.find((t) => t.mode === 'master').apiKey, 'master');
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
