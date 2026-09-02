/**
 * Approve/send needs email_lead_id + SENT stats_id.
 * Master-inbox URLs use leadMap (sl_email_lead_map_id); storing that id makes
 * message-history 404 and Approve cannot send.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const {
  normalizeSmartleadLeadId,
  normalizeSmartleadLeadMapId,
} = require('../src/utils/smartlead-webhook-helpers');
const { extractStatsIdFromHistory } = require('../src/services/smartlead');

const MAP_ID = '3512474990';
const EMAIL_LEAD_ID = '4324451336';

test('normalizeSmartleadLeadId prefers email_lead_id and never stores leadMap', () => {
  assert.strictEqual(
    normalizeSmartleadLeadId({
      sl_email_lead_map_id: MAP_ID,
      email_lead_id: EMAIL_LEAD_ID,
      lead_id: MAP_ID,
    }),
    EMAIL_LEAD_ID,
  );
  assert.strictEqual(
    normalizeSmartleadLeadMapId({ sl_email_lead_map_id: MAP_ID, email_lead_id: EMAIL_LEAD_ID }),
    MAP_ID,
  );
  assert.strictEqual(
    normalizeSmartleadLeadId({ lead_id: MAP_ID, sl_email_lead_map_id: MAP_ID }),
    null,
    'generic lead_id that equals leadMap must be ignored',
  );
  assert.strictEqual(
    normalizeSmartleadLeadId({ lead_id: EMAIL_LEAD_ID }),
    EMAIL_LEAD_ID,
  );
});

test('extractStatsIdFromHistory uses the most recent SENT stats_id', () => {
  const stats = extractStatsIdFromHistory({
    history: [
      { type: 'SENT', stats_id: '111', time: '2026-01-01T00:00:00Z' },
      { type: 'REPLY', stats_id: '222', time: '2026-01-02T00:00:00Z' },
      { type: 'SENT', stats_id: '333', time: '2026-01-03T00:00:00Z' },
    ],
  });
  assert.strictEqual(stats, '333');
});

test('webhook, poller, admin, and send resolve sendable ids before a card can Approve', () => {
  const helpers = read('src/utils/smartlead-webhook-helpers.js');
  const leadFn = helpers.slice(
    helpers.indexOf('function normalizeSmartleadLeadId'),
    helpers.indexOf('function normalizeSmartleadCampaignId'),
  );
  assert.doesNotMatch(
    leadFn,
    /payload\.sl_email_lead_map_id/,
    'lead_id picker must not treat leadMap as a candidate',
  );

  const webhook = read('src/routes/webhooks.js');
  assert.match(webhook, /resolveSendableThread/, 'webhook must resolve email_lead_id + stats_id before insert');
  assert.match(webhook, /unresolved_smartlead_stats_id/, 'webhook must not insert a card that cannot send');

  const poller = read('src/services/smartlead-poller.js');
  assert.match(poller, /resolveSendableThread/, 'poller must resolve sendable ids when history/stats are missing');
  assert.match(poller, /missing_stats_id/, 'poller must skip posting without stats_id');

  const admin = read('src/routes/admin.js');
  assert.match(admin, /resolveSendableThread/, 'admin recover must resolve sendable ids, not trust caller leadId');
  assert.match(admin, /smartlead_email_stats_id/, 'admin recover must persist stats_id');
  assert.match(admin, /leadEmail/, 'admin recover needs email to look up email_lead_id from inbox');

  const send = read('src/services/reply-send.js');
  assert.match(send, /resolveSendableThread/, 'Approve must re-resolve email_lead_id if the row still has a map id');

  const dedupe = read('src/services/reply-dedupe.js');
  assert.match(dedupe, /ensureSmartleadSendableIds/, 'Slack recovery must fix ids before posting');
  assert.match(dedupe, /c\.smartlead_api_key/, 'recovery query must load the SmartLead key');
});
