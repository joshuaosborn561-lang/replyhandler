const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const {
  toPublicClient,
  stripSecrets,
  assertNoSecretFields,
  assertNoTokenValues,
  looksSecretField,
  looksLikeTokenValue,
} = require('../src/utils/public-client');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function loadClientsSource() {
  const html = read('src/public/index.html');
  const start = html.indexOf('async function loadClients()');
  const end = html.indexOf('function renderStats()');
  assert.ok(start >= 0 && end > start, 'loadClients() must exist');
  return html.slice(start, end);
}

test('/dashboard HTML never prompts for a key on load', () => {
  const html = read('src/public/index.html');
  const load = loadClientsSource();
  assert.doesNotMatch(load, /getAdminKey|window\.prompt|adminFetch|ADMIN_API_KEY/);
  assert.match(load, /\/dashboard\/api\/clients/);
  assert.match(html, /Prompt only on edit\/create\/deactivate/);
  assert.match(html, /window\.prompt/, 'edit actions may still prompt');
});

test('open dashboard API never selects key or token columns', () => {
  const src = read('src/routes/dashboard-api.js');
  assert.doesNotMatch(src, /as smartlead_api_key/i);
  assert.doesNotMatch(src, /as heyreach_api_key/i);
  assert.doesNotMatch(src, /as slack_bot_token/i);
  assert.match(src, /has_smartlead_api_key/);
  assert.match(src, /has_heyreach_api_key/);
  assert.match(src, /has_slack_bot_token/);
  assert.doesNotMatch(src, /requireAdminApiKey/);
  assert.match(src, /toPublicClient|stripSecrets/);
});

test('toPublicClient strips keys and tokens', () => {
  const row = toPublicClient({
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Example Client',
    smartlead_api_key: 'sl_live_secret',
    heyreach_api_key: 'hr_live_secret',
    allo_api_key: 'allo_secret',
    slack_bot_token: 'xoxb-secret-token',
    slack_channel_id: 'C0123456789',
  });
  assertNoSecretFields(row);
  assert.equal(row.smartlead_api_key, undefined);
  assert.equal(row.slack_bot_token, undefined);
  assert.equal(row.has_smartlead_api_key, true);
  assert.equal(row.has_slack_bot_token, true);
  assert.equal(looksSecretField('slack_channel_id'), false);
  assert.equal(looksSecretField('smartlead_webhook_url'), false);
  const leaked = stripSecrets({ slack_bot_token: 'xoxb-x', ok: true });
  assert.equal(leaked.slack_bot_token, undefined);
  assert.equal(leaked.ok, true);
});

test('stripSecrets blanks token-shaped values regardless of field name', () => {
  // Built at runtime so the file never contains a scanner-shaped token.
  const slackBot = ['xox', 'b', '-', '1234567890-abcdefghijklmnopqrstuv'].join('');
  const slackUser = ['xox', 'p', '-', 'not-a-real-token'].join('');
  const vendorKey = ['sk', '-', 'live-', 'abcdefghijklmnopqrstuvwxyz'].join('');
  const gitPat = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz012345'].join('');
  const botInChannel = toPublicClient({
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Example Client',
    slack_channel_id: slackBot,
  });
  assert.equal(botInChannel.slack_channel_id, '');
  assert.equal(looksLikeTokenValue(slackBot), true);
  assert.equal(looksLikeTokenValue(slackUser), true);
  assert.equal(looksLikeTokenValue(vendorKey), true);
  assert.equal(looksLikeTokenValue(gitPat), true);

  const blob = 'A'.repeat(32);
  const nested = stripSecrets({
    slack_channel_id: blob,
    id: '11111111-1111-1111-1111-111111111111',
    channel: 'C0123456789',
    nested: { note: vendorKey },
  });
  assert.equal(nested.slack_channel_id, '');
  assert.equal(nested.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(nested.channel, 'C0123456789');
  assert.equal(nested.nested.note, '');
  assert.equal(looksLikeTokenValue(blob), true);
  assert.equal(looksLikeTokenValue('11111111-1111-1111-1111-111111111111'), false);
  assert.equal(looksLikeTokenValue('C0123456789'), false);
  assertNoTokenValues(nested);
});

test('/dashboard does not return 401 and open routes leak no secrets', async () => {
  const { createApp } = require('../src/app');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  try {
    const page = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.notEqual(page.status, 401, '/dashboard must load with no login');
    assert.ok(page.status === 200 || page.status === 301 || page.status === 302);
    const html = await page.text();
    assert.doesNotMatch(html.slice(0, 200), /401/);

    const api = await fetch(`http://127.0.0.1:${port}/dashboard/api/clients`);
    assert.notEqual(api.status, 401, 'open dashboard API must not require a key');
    if (api.headers.get('content-type')?.includes('json')) {
      const body = await api.json();
      assertNoSecretFields(body);
      assertNoTokenValues(body);
    }

    const admin = await fetch(`http://127.0.0.1:${port}/admin/clients`);
    assert.notEqual(admin.status, 401, '/admin must not require a key');
    const cat = await fetch(`http://127.0.0.1:${port}/public/booking-clients`);
    assert.notEqual(cat.status, 401, 'booking catalog must be public');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
