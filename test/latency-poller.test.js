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
  assert.match(src, /updateDraftApprovalCard|patchPostedCard/);
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

test('poller recovery counts only real Slack posts', () => {
  const sl = read('src/services/smartlead-poller.js');
  const hr = read('src/services/heyreach-poller.js');
  const recover = read('src/services/reply-dedupe.js');
  const slEarlyAt = sl.indexOf('if (unpostedEarly)');
  const slLateAt = sl.indexOf('if (unposted) {');
  const slEarly = sl.slice(slEarlyAt, slLateAt);
  const slLate = sl.slice(slLateAt, sl.indexOf('if (await alreadyPostedToSlack', slLateAt));
  const hrAt = hr.indexOf('if (unposted) {');
  const hrBlock = hr.slice(hrAt, hr.indexOf('if (await alreadyPostedToSlack', hrAt));
  for (const block of [slEarly, slLate, hrBlock]) {
    assert.match(block, /const posted = await repostReplyRowToSlack/);
    assert.match(block, /if \(!posted\)/);
    assert.match(block, /skipped: 'already_posted'/);
  }
  const recoverFn = recover.slice(recover.indexOf('async function recoverUnpostedSlackCards'));
  assert.match(recoverFn, /if \(!posted\)/);
  assert.match(recoverFn, /recovered\+\+/);
  assert.ok(
    recoverFn.indexOf('if (!posted)') < recoverFn.indexOf('recovered++'),
    'recoverUnpostedSlackCards must not count a skipped already-posted card'
  );
});

test('startup registers EMAIL_REPLY webhooks or reports missing', () => {
  const cron = read('src/cron.js');
  const svc = read('src/services/email-reply-webhooks.js');
  assert.match(cron, /ensureEmailReplyWebhooks/);
  assert.match(svc, /EMAIL_REPLY webhook missing/);
  assert.match(svc, /createEmailReplyWebhook/);
  assert.match(svc, /isActiveCampaign/);
  assert.match(svc, /=== 'ACTIVE'/);
  assert.match(svc, /unknown/);
  assert.match(svc, /list_webhooks_failed|list_campaigns_failed/);
  assert.match(svc, /KEY_GAP_MS/);
  assert.ok(/1000/.test(svc), 'startup webhook check throttles to ~1 call/s per key');
});

test('poller fetches, webhook list/create, and listEmailAccounts retry 429s', () => {
  const sl = read('src/services/smartlead.js');
  const poller = read('src/services/smartlead-poller.js');
  assert.match(sl, /fetchWith429Retry/);
  assert.match(sl, /status !== 429/);
  assert.match(poller, /fetchWith429Retry/);
  const listAccounts = sl.slice(sl.indexOf('async function listEmailAccounts'));
  assert.match(listAccounts, /fetchWith429Retry/);
  const listHooks = sl.slice(sl.indexOf('async function listCampaignWebhooks'));
  assert.match(listHooks, /fetchWith429Retry/);
  const createHook = sl.slice(sl.indexOf('async function createEmailReplyWebhook'));
  assert.match(createHook, /fetchWith429Retry/);
});

test('listEmailAccounts pages until empty with no 500 cap', () => {
  const sl = read('src/services/smartlead.js');
  const fn = sl.slice(sl.indexOf('async function listEmailAccounts'), sl.indexOf('async function listCampaigns'));
  assert.doesNotMatch(fn, /offset < 500/);
  assert.match(fn, /offset \+= pageSize/);
  assert.match(fn, /if \(!rows\.length\) break/);
});

test('findUnpostedReply skips rows created in the last ~2 minutes', () => {
  const src = read('src/services/reply-dedupe.js');
  const unposted = src.slice(
    src.indexOf('async function findUnpostedReply'),
    src.indexOf('function formatCampaignDisplayFromReply')
  );
  assert.match(unposted, /created_at < now\(\) - interval '2 minutes'/);
});

test('webhook registration is ACTIVE-only; list failures are unknown not missing', () => {
  const { isActiveCampaign } = require('../src/services/email-reply-webhooks');
  assert.equal(isActiveCampaign({ id: 1, status: 'ACTIVE' }), true);
  assert.equal(isActiveCampaign({ id: 1, status: 'active' }), true);
  assert.equal(isActiveCampaign({ id: 1, status: 'PAUSED' }), false);
  assert.equal(isActiveCampaign({ id: 1, status: 'STOPPED' }), false);
  assert.equal(isActiveCampaign({ id: 1 }), false);
  const svc = read('src/services/email-reply-webhooks.js');
  const listFail = svc.slice(svc.indexOf('campaigns = await withKeyGap'));
  assert.match(listFail, /unknown\.push/);
  assert.doesNotMatch(
    listFail.slice(0, listFail.indexOf('for (const camp of campaigns)')),
    /missing\.push/
  );
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
