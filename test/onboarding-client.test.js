const test = require('node:test');
const assert = require('node:assert');
process.env.RAILWAY_PUBLIC_DOMAIN = 'rh.example';
const { upsertOnboardingClient, validate } = require('../src/routes/onboarding');
const { evaluateAdminAuth } = require('../src/utils/admin-auth');

function fakeDb(rows = []) {
  const calls = [];
  return { calls, query: async (sql, p) => {
    calls.push(sql);
    if (/^SELECT \* FROM clients WHERE lower/.test(sql)) return { rows: rows.filter((r) => r.name.toLowerCase() === p[0].toLowerCase()) };
    if (/SELECT slack_bot_token/.test(sql)) return { rows: [{ slack_bot_token: 'xoxb-default' }] };
    if (/^INSERT/.test(sql)) return { rows: [{ id: 'new-id', name: p[0], slack_bot_token: p[1], slack_channel_id: p[2], booking_link: p[3], smartlead_api_key: p[5], active: true }] };
    if (/^UPDATE/.test(sql)) return { rows: [{ id: p[6], name: p[0], slack_channel_id: p[1], slack_bot_token: p[2], booking_link: p[3], smartlead_api_key: p[5], active: true }] };
    return { rows: [] };
  } };
}

test('validate rejects bad input', () => {
  assert.ok(validate({}).length);
  assert.ok(validate({ name: 'X', slack_channel_id: 'bad' }).length);
  assert.deepStrictEqual(validate({ name: 'X', slack_channel_id: 'C0CC420V1TK', booking_link: 'https://a.b' }), []);
});

test('create uses default token, returns webhook url, no secrets', async () => {
  const d = fakeDb();
  const r = await upsertOnboardingClient({ name: 'Acme', slack_channel_id: 'C0CC420V1TK' }, { query: d.query });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.client.smartlead_webhook_url, 'https://rh.example/webhook/smartlead/new-id');
  assert.ok(!JSON.stringify(r.json).includes('xoxb'));
});

test('dry run writes nothing; existing name updates', async () => {
  const d = fakeDb([{ id: 'e1', name: 'Acme', slack_channel_id: 'C1111111', slack_bot_token: 't' }]);
  const r = await upsertOnboardingClient({ name: 'acme', dry_run: true }, { query: d.query });
  assert.strictEqual(r.json.plan.action, 'update');
  assert.ok(!d.calls.some((s) => /^(INSERT|UPDATE)/.test(s)));
});

test('registers webhook on one campaign only when missing', async () => {
  const d = fakeDb();
  const made = [];
  const sl = { listCampaignWebhooks: async () => [], webhookHasEmailReply: () => false,
    createEmailReplyWebhook: async (k, c, u) => made.push([c, u]) };
  const r = await upsertOnboardingClient({ name: 'Acme', slack_channel_id: 'C0CC420V1TK', smartlead_api_key: 'k', smartlead_campaign_id: '42' }, { query: d.query, smartlead: sl });
  assert.deepStrictEqual(made, [['42', 'https://rh.example/webhook/smartlead/new-id']]);
  assert.strictEqual(r.json.webhook.created, true);
});

test('route is fail-closed without key', () => {
  assert.strictEqual(evaluateAdminAuth({}, 'x').ok, false);
});
