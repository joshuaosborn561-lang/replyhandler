const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
process.env.SMARTLEAD_WEBHOOK_CHECK_GAP_MS = '200';

function load(routeRows) {
  const dbPath = path.resolve(__dirname, '../src/db.js');
  const slPath = path.resolve(__dirname, '../src/services/smartlead.js');
  for (const k of Object.keys(require.cache)) if (/src[\\/](services[\\/](email-reply-webhooks|campaign-routing)|db)\.js$/.test(k)) delete require.cache[k];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: async (sql) => {
    if (/smartlead_campaign_routes/.test(sql)) { if (routeRows === 'throw') throw new Error('no table'); return { rows: routeRows }; }
    return { rows: [] };
  } } };
  const created = [];
  const realSl = require(slPath);
  require.cache[slPath].exports = { ...realSl,
    listCampaigns: async () => [{ id: 1, status: 'ACTIVE' }, { id: 2, status: 'ACTIVE' }],
    listCampaignWebhooks: async () => [],
    webhookHasEmailReply: () => false,
    createEmailReplyWebhook: async (k, c) => created.push(String(c)) };
  const mod = require('../src/services/email-reply-webhooks');
  require.cache[slPath].exports = realSl;
  return { mod, created };
}

test('no routes: every active campaign is hooked exactly as before', async () => {
  for (const rows of [[], 'throw']) {
    const { mod, created } = load(rows);
    const r = await mod.ensureClientEmailReplyWebhooks({ id: 'sg', smartlead_api_key: 'k' });
    assert.deepStrictEqual(created, ['1', '2']);
    assert.strictEqual(r.campaigns, 2);
  }
});

test('campaign routed to another client is skipped; routed to self is hooked', async () => {
  const { mod, created } = load([{ campaign_id: '2', client_id: 'vec' }, { campaign_id: '1', client_id: 'sg' }]);
  await mod.ensureClientEmailReplyWebhooks({ id: 'sg', smartlead_api_key: 'k' });
  assert.deepStrictEqual(created, ['1']);
});
