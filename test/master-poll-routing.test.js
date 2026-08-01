const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('master SmartLead polling requires an explicit campaign route', () => {
  const poller = read('src/services/smartlead-poller.js');
  const migration = read('migrations/020_smartlead_campaign_routes.sql');

  assert.match(poller, /pollSmartleadMasterRecovery/);
  assert.match(poller, /loadRouteMap/);
  assert.match(poller, /unroutable_campaign/);
  assert.match(poller, /routedByMaster:\s*true/);
  assert.match(poller, /SMARTLEAD_MASTER_POLL_SCAN_LIMIT/);
  assert.match(poller, /scanned < maxScannedReplies && routed < maxRoutedReplies/);
  assert.doesNotMatch(
    poller,
    /client\.smartlead_api_key\s*\|\|\s*process\.env\.SMARTLEAD_MASTER_API_KEY/
  );
  assert.match(migration, /campaign_id TEXT PRIMARY KEY/);
  assert.doesNotMatch(migration, /INSERT INTO smartlead_campaign_routes[\s\S]*pending_replies/);
  assert.match(poller, /seedRoutesFromDedicatedKeys/);
});

test('verified SmartLead webhooks learn campaign ownership', () => {
  const webhooks = read('src/routes/webhooks.js');
  assert.match(webhooks, /verifyCampaignAccess[\s\S]*learnRoute/);
  assert.match(webhooks, /source:\s*'webhook'/);
});

test('master key is used only for targeted send operations', () => {
  const send = read('src/services/reply-send.js');
  assert.match(
    send,
    /client\.smartlead_api_key \|\| process\.env\.SMARTLEAD_MASTER_API_KEY/
  );
  assert.match(send, /smartlead\.sendReply\(\s*smartleadApiKey/);
});

test('campaign routes have a protected explicit repair path', () => {
  const admin = read('src/routes/admin.js');
  assert.match(admin, /router\.use\(requireAdminSecret\)/);
  assert.match(admin, /\/admin\/smartlead-routes\/:campaignId/);
  assert.match(admin, /setManualRoute/);
});
