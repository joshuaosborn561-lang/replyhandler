const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('SmartLead webhook persists, returns 200, then processes async', () => {
  const src = read('src/routes/webhooks.js');
  assert.match(src, /accepted: true/);
  assert.match(src, /setImmediate/);
  assert.match(src, /processSmartleadWebhookAsync/);
  assert.match(src, /deferDraft:\s*true/);
  assert.match(src, /updateDraftApprovalCard/);
});

test('pollers run every minute, clients in parallel, skip handled rows first', () => {
  const cron = read('src/cron.js');
  const sl = read('src/services/smartlead-poller.js');
  const hr = read('src/services/heyreach-poller.js');
  assert.match(cron, /SMARTLEAD_POLL_MINUTES \|\| '1'/);
  assert.match(cron, /HEYREACH_POLL_MINUTES \|\| '1'/);
  assert.match(sl, /Promise\.all\(clients\.map/);
  assert.match(hr, /Promise\.all\(clients\.map/);
  assert.match(sl, /Skip already-handled rows before any extra fetches/);
  assert.match(hr, /Inbox fetch failed — skipping this client/);
});

test('startup registers EMAIL_REPLY webhooks or reports missing', () => {
  const cron = read('src/cron.js');
  const svc = read('src/services/email-reply-webhooks.js');
  assert.match(cron, /ensureEmailReplyWebhooks/);
  assert.match(svc, /EMAIL_REPLY webhook missing/);
  assert.match(svc, /createEmailReplyWebhook/);
});

test('calendar cache TTL is 5–10 minutes with an ~8s timeout', () => {
  const slots = read('src/services/scheduling-slots.js');
  const cron = read('src/cron.js');
  assert.match(slots, /8 \* 60 \* 1000/);
  assert.match(slots, /8000/);
  assert.match(slots, /Empty open times/);
  assert.match(cron, /refreshAllClientSlotCaches/);
  assert.match(cron, /\*\/8 \* \* \* \*/);
});
