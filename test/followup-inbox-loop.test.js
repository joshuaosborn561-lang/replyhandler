/**
 * Guard: inbox polling must not re-post FOLLOW_UP cadence rows, and unique
 * signature images must not break dedupe (Carter Howard loop, 2026-08-27).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { normalizeInboundText, inboundPrefix } = require('../src/services/reply-dedupe');

test('embedded signature images do not change the inbound dedupe key', () => {
  const a = 'Hi Sandy,\n\nPlease send over a booking link.\n\ndata:image/png;base64,AAA111';
  const b = 'Hi Sandy,\n\nPlease send over a booking link.\n\ndata:image/png;base64,BBB999DIFFERENT';
  assert.strictEqual(normalizeInboundText(a), normalizeInboundText(b));
  assert.strictEqual(inboundPrefix(a), inboundPrefix(b));
  assert.ok(inboundPrefix(a).startsWith('hi sandy'));
});

test('poller does not recover FOLLOW_UP rows as inbox cards', () => {
  const dedupe = read('src/services/reply-dedupe.js');
  const unposted = dedupe.slice(
    dedupe.indexOf('async function findUnpostedReply'),
    dedupe.indexOf('function formatCampaignDisplayFromReply'),
  );
  assert.match(
    unposted,
    /classification <> 'FOLLOW_UP'/,
    'findUnpostedReply must ignore cadence FOLLOW_UP rows',
  );

  const poller = read('src/services/smartlead-poller.js');
  assert.match(poller, /suppressUnpostedFollowUpInboxRows/, 'poller must retire unposted FOLLOW_UP recoveries');
  assert.match(poller, /Inbox FOLLOW_UP remapped to QUESTION/, 'inbox must not keep the cadence label');

  const admin = read('src/routes/admin.js');
  assert.match(admin, /\/admin\/stop-follow-ups/, 'admin stop-follow-ups endpoint must exist');
});
