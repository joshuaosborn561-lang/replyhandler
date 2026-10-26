const test = require('node:test');
const assert = require('node:assert');
process.env.RAILWAY_PUBLIC_DOMAIN = 'rh.example';
const { upsertOnboardingClient, validate, campaignIdsFrom } = require('../src/routes/onboarding');
const { autoRouteClientCampaigns, autoRouteEnabled } = require('../src/services/campaign-auto-route');

function routesDb(existingRoutes = {}) {
  const routes = new Map(Object.entries(existingRoutes));
  const client = { id: 'c1', name: 'Acme', slack_channel_id: 'C0CC420V1TK', slack_bot_token: 't', active: true };
  return { routes, query: async (sql, p = []) => {
    if (/^SELECT \* FROM clients WHERE id/.test(sql)) return { rows: [client] };
    if (/^UPDATE clients SET smartlead_client_id/.test(sql)) { client.smartlead_client_id = p[0]; return { rows: [{ ...client }] }; }
    if (/^UPDATE/.test(sql)) return { rows: [{ ...client }] };
    if (/INSERT INTO smartlead_campaign_routes/.test(sql)) {
      if (/DO NOTHING/.test(sql) && routes.has(p[0])) return { rows: [] };
      routes.set(p[0], p[1]); return { rows: [] };
    }
    if (/SELECT campaign_id FROM smartlead_campaign_routes WHERE client_id/.test(sql)) {
      return { rows: [...routes].filter(([, c]) => c === p[0]).map(([k]) => ({ campaign_id: k })).sort((a, b) => a.campaign_id.localeCompare(b.campaign_id)) };
    }
    if (/SELECT campaign_id FROM smartlead_campaign_routes/.test(sql)) return { rows: [...routes.keys()].map((k) => ({ campaign_id: k })) };
    if (/FROM clients WHERE active/.test(sql)) return { rows: [{ id: 'c1', smartlead_client_id: '77' }] };
    return { rows: [] };
  } };
}
const env = { SMARTLEAD_MASTER_API_KEY: 'mk' };
function fakeSl(campaigns = []) {
  const made = [];
  return { made, listCampaigns: async () => campaigns, listCampaignWebhooks: async () => [],
    webhookHasEmailReply: () => false, createEmailReplyWebhook: async (k, c) => made.push(c) };
}

test('validate campaign_ids and smartlead_client_id', () => {
  assert.ok(validate({ client_id: 'x', campaign_ids: ['1', 'a'] }).length);
  assert.ok(validate({ client_id: 'x', campaign_ids: '1' }).length);
  assert.ok(validate({ client_id: 'x', smartlead_client_id: 'abc' }).length);
  assert.deepStrictEqual(validate({ client_id: 'x', campaign_ids: [1, '2'], smartlead_client_id: 77 }), []);
  assert.deepStrictEqual(campaignIdsFrom({ smartlead_campaign_id: 1, campaign_ids: ['1', 2] }), ['1', '2']);
});

test('campaign_ids list ADDS routes and keeps existing ones', async () => {
  const d = routesDb({ 100: 'c1' });
  const sl = fakeSl();
  const r = await upsertOnboardingClient({ client_id: 'c1', campaign_ids: ['200', '201'] }, { query: d.query, smartlead: sl, env });
  assert.deepStrictEqual(r.json.routed_campaign_ids, ['100', '200', '201']);
  assert.deepStrictEqual(sl.made, ['200', '201']);
  assert.strictEqual(r.json.campaigns.length, 2);
  assert.ok(!JSON.stringify(r.json).includes('mk'));
});

test('single campaign keeps legacy response shape', async () => {
  const d = routesDb();
  const r = await upsertOnboardingClient({ client_id: 'c1', smartlead_campaign_id: '5' }, { query: d.query, smartlead: fakeSl(), env });
  assert.deepStrictEqual(r.json.campaign_route, { campaign_id: '5', client_id: 'c1' });
  assert.strictEqual(r.json.webhook.created, true);
});

test('auto-route adds only unrouted campaigns for the SmartLead client', async () => {
  const d = routesDb({ 1: 'other' });
  const sl = fakeSl([{ id: 1, client_id: 77 }, { id: 2, client_id: 77 }, { id: 3, client_id: 99 }, { id: 4, client_id: null }]);
  const dry = await autoRouteClientCampaigns({ dryRun: true }, { query: d.query, smartlead: sl, env });
  assert.deepStrictEqual(dry.added.map((a) => a.campaign_id), ['2']);
  assert.strictEqual(d.routes.has('2'), false);
  const r = await autoRouteClientCampaigns({}, { query: d.query, smartlead: sl, env });
  assert.deepStrictEqual(r.added.map((a) => a.campaign_id), ['2']);
  assert.strictEqual(d.routes.get('1'), 'other');
  assert.strictEqual(d.routes.get('2'), 'c1');
  assert.deepStrictEqual(sl.made, ['2']);
});

test('auto-route cron is opt-in', () => {
  assert.strictEqual(autoRouteEnabled({}), false);
  assert.strictEqual(autoRouteEnabled({ AUTO_ROUTE_SMARTLEAD_CLIENTS: 'true' }), true);
});
