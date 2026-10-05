/**
 * Guard: webhook + poller must not both insert the same inbound, and
 * approving two leftover cards must not send the same outbound twice.
 *
 * Casey Buckstaff, 2026-10-05: webhook card at 12:36:00, poller "polling
 * backstop" insert at 12:36:02. alreadyPostedToSlack required slack_message_ts,
 * so the in-flight webhook row did not count.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const {
  sameOutboundText,
  inboundPrefix,
  normalizeInboundText,
} = require('../src/services/reply-dedupe');

test('same outbound text matches the inbound-style prefix / containment rules', () => {
  const a = 'Happy to jump on Thursday mid-morning or Friday early afternoon. Here is a booking link if easier: https://example.com/book';
  const b = `${a}\n\nOn Mon, Casey wrote:`;
  assert.ok(sameOutboundText(a, b), 'quoted tail must not make the same send look new');
  assert.ok(sameOutboundText(a, a), 'identical text matches');
  assert.ok(!sameOutboundText('Thursday mid-morning works', 'Friday early afternoon works'),
    'different times are different replies');
});

test('inboundAlreadyRecorded does not wait for Slack to post', () => {
  const src = read('src/services/reply-dedupe.js');
  const recorded = src.slice(
    src.indexOf('async function inboundAlreadyRecorded'),
    src.indexOf('async function alreadyPostedToSlack')
  );
  assert.ok(!/slack_message_ts/.test(recorded),
    'requiring slack_message_ts is the Casey race — webhook insert, Slack post later');
  assert.match(recorded, /COALESCE\(classification, ''\) <> 'FOLLOW_UP'/);
  assert.match(recorded, /samePersonSql/);
});

test('claimNewInbound locks before insert and rechecks', () => {
  const src = read('src/services/reply-dedupe.js');
  const claim = src.slice(
    src.indexOf('async function claimNewInbound'),
    src.indexOf('function sameOutboundText')
  );
  assert.match(claim, /pg_advisory_xact_lock/);
  assert.match(claim, /inboundAlreadyRecorded\(conn/);
  assert.match(claim, /insertFn\(conn\)/);
  assert.match(claim, /duplicate: true/);
});

test('SmartLead poller and webhook insert through claimNewInbound', () => {
  const poller = read('src/services/smartlead-poller.js');
  const webhook = read('src/routes/webhooks.js');
  const heyreach = read('src/services/heyreach-poller.js');

  const pollerInsert = poller.slice(poller.indexOf('const claimed = await claimNewInbound'));
  assert.match(poller, /claimNewInbound\(/);
  assert.match(pollerInsert, /INSERT INTO pending_replies/);
  assert.match(poller, /leadEmail: row\.lead_email/);

  assert.match(webhook, /claimNewInbound\(/);
  assert.match(webhook, /inboundAlreadyRecorded/);

  assert.match(heyreach, /claimNewInbound\(/);
});

test('send path refuses a second copy of the same outbound', () => {
  const send = read('src/services/reply-send.js');
  const slack = read('src/routes/slack.js');
  const body = send.slice(send.indexOf('async function sendReplyToPlatform'));
  assert.match(body, /alreadySentSameOutbound/);
  assert.match(body, /skippedDuplicate: true/);
  assert.ok(
    body.indexOf('alreadySentSameOutbound') < body.indexOf('smartlead.sendReply'),
    'the duplicate check must run before the outbound API call'
  );
  assert.match(slack, /Already sent this reply — skipped the duplicate/);
  assert.match(slack, /if \(!skippedDuplicate\)/);
});

test('dedupe prefix helper is still the 120-char window', () => {
  const long = `${'word '.repeat(50)}tail that diverges`;
  assert.strictEqual(inboundPrefix(long).length, 120);
  assert.ok(normalizeInboundText('Hi\u00a0there'), 'nbsp still normalizes');
});
