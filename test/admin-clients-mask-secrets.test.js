const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../src/db');
const { toAdminClient } = require('../src/utils/public-client');

const SECRETS = {
  smartlead_api_key: 'sl-FAKE-key-0000000000000000',
  heyreach_api_key: 'hr-FAKE-key-1111111111111111',
  allo_api_key: 'allo-FAKE-key-22222222222222',
  slack_bot_token: 'xoxb-FAKE-token-3333333333',
};

function fakeRow(overrides = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Fixture Client',
    active: true,
    slack_channel_id: 'C0FIXTURE1',
    booking_link: null,
    cc_emails: 'ops@example.test',
    smartlead_use_master_key: false,
    ...SECRETS,
    ...overrides,
  };
}

function assertNoSecretValues(body) {
  const text = JSON.stringify(body);
  for (const v of Object.values(SECRETS)) assert.ok(!text.includes(v), 'secret value leaked');
  for (const k of Object.keys(SECRETS)) assert.ok(!(k in (Array.isArray(body) ? body[0] : body)), `${k} key present`);
}

test('toAdminClient swaps secret columns for has_* flags and keeps the rest', () => {
  const out = toAdminClient(fakeRow({ heyreach_api_key: '', allo_api_key: null }));
  assert.equal(out.has_smartlead_api_key, true);
  assert.equal(out.has_heyreach_api_key, false);
  assert.equal(out.has_allo_api_key, false);
  assert.equal(out.has_slack_bot_token, true);
  assert.equal(out.name, 'Fixture Client');
  assert.equal(out.slack_channel_id, 'C0FIXTURE1');
  assert.equal(out.smartlead_use_master_key, false);
  for (const k of Object.keys(SECRETS)) assert.ok(!(k in out));
});

test('toAdminClient hides a future secret-named column too', () => {
  const out = toAdminClient({ id: 'x', tidycal_api_token: 'tok-FAKE-9999999999', other: 1 });
  assert.equal(out.has_tidycal_api_token, true);
  assert.ok(!('tidycal_api_token' in out));
  assert.equal(out.other, 1);
});

async function withApp(fn) {
  const { createApp } = require('../src/app');
  const server = await new Promise((resolve) => {
    const s = http.createServer(createApp());
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try { await fn(server.address().port); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /admin/clients and PATCH /admin/clients/:id never return secret values', async () => {
  const realQuery = db.query;
  db.query = async (sql) => {
    if (/UPDATE clients SET/i.test(sql)) return { rows: [fakeRow({ name: 'Renamed' })] };
    return { rows: [fakeRow()] };
  };
  try {
    await withApp(async (port) => {
      const list = await fetch(`http://127.0.0.1:${port}/admin/clients`);
      assert.equal(list.status, 200);
      const body = await list.json();
      assertNoSecretValues(body);
      assert.equal(body[0].has_smartlead_api_key, true);
      assert.equal(body[0].has_slack_bot_token, true);
      assert.match(body[0].smartlead_webhook_url, /\/webhook\/smartlead\//);

      const patch = await fetch(`http://127.0.0.1:${port}/admin/clients/11111111-1111-1111-1111-111111111111`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      assert.equal(patch.status, 200);
      assertNoSecretValues(await patch.json());
    });
  } finally {
    db.query = realQuery;
  }
});

test('no other /admin GET selects a secret column', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['admin.js', 'test-webhooks.js', 'voice-learning.js', 'onboarding.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', f), 'utf8');
    const getRoutes = src.split(/router\.(?=get\()/).slice(1);
    for (const r of getRoutes) {
      const handler = r.split(/\nrouter\./)[0];
      assert.ok(!/smartlead_api_key|heyreach_api_key|allo_api_key|slack_bot_token|SELECT \* FROM clients/i.test(
        handler.replace(/SELECT \* FROM clients ORDER BY created_at DESC/, '')), `${f}: a GET route reads client secrets`);
    }
  }
});
