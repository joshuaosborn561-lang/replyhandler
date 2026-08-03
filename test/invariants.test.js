/**
 * Guard tests for the rules in CLAUDE.md.
 *
 * Each assertion here corresponds to a change that broke production, or to an
 * explicit owner decision. Documentation asks people not to break these; this
 * file fails the build when they do. No DB and no network — pure module checks
 * so it runs anywhere.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function walkSrc() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  })(path.join(ROOT, 'src'));
  return out;
}

// ── Body limit ────────────────────────────────────────────────────────
// On the Express default (100kb) real SmartLead payloads 413 before the
// route runs: no log line, no Slack card, replies silently lost.
test('express.json keeps a raised body limit', () => {
  const index = read('src/index.js');
  assert.match(
    index,
    /express\.json\(\s*\{\s*limit:/,
    'express.json() must set an explicit limit — the 100kb default drops real SmartLead replies'
  );
  assert.match(index, /JSON_BODY_LIMIT\s*\|\|\s*'5mb'/, 'default body limit must remain 5mb');
});

// ── Suppression policy ────────────────────────────────────────────────
// Exactly three things are silent. Everything else reaches Slack.
test('only OOO, unsubscribe and wrong-person are suppressed', () => {
  const { slackSuppressionReason } = require('../src/utils/smartlead-webhook-helpers');

  const silent = {
    'I am out of the office until Monday': 'ooo',
    'Automatic reply: on vacation': 'ooo',
    'Please unsubscribe me from this list': 'unsubscribe',
    'Remove me from your list': 'unsubscribe',
    'Do not contact me again': 'unsubscribe',
    'John no longer works here': 'wrong_person',
    'I am not the right person': 'wrong_person',
  };
  for (const [text, reason] of Object.entries(silent)) {
    assert.strictEqual(slackSuppressionReason(text), reason, `"${text}" should be silenced as ${reason}`);
  }

  // NOT_INTERESTED is an objection worth working, not a dead lead.
  const mustReachSlack = [
    'Not interested at this time',
    'We are not interested in this service',
    'No thanks, we are all set',
    'This is too expensive',
    'Who else do you work with?',
    'Sounds good, lets book a time',
  ];
  for (const text of mustReachSlack) {
    assert.strictEqual(slackSuppressionReason(text), null, `"${text}" must reach Slack`);
  }
});

test('NOT_INTERESTED still gets a draft', () => {
  const { DRAFT_CLASSIFICATIONS } = require('../src/services/classifier');
  assert.ok(
    DRAFT_CLASSIFICATIONS.includes('NOT_INTERESTED'),
    'NOT_INTERESTED must draft — in decline mode, but it must draft'
  );
});

// ── Deleted nudge system ──────────────────────────────────────────────
// Removed at the owner's explicit request. Do not reintroduce.
test('no "you haven\'t actioned this" nudge code exists', () => {
  const banned = [/postPendingNudge/, /postReminder\b/, /already_replied_yes/, /already_replied_no/, /snooze_nudge/, /haven'?t actioned/i];
  for (const file of walkSrc()) {
    const body = fs.readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.ok(
        !pattern.test(body),
        `${path.relative(ROOT, file)} reintroduces the deleted nudge system (${pattern})`
      );
    }
  }
});

// ── Dedupe ────────────────────────────────────────────────────────────
// The webhook and poller render the same reply differently and diverge in
// the tail, so the key must be a leading slice, not the whole body.
test('dedupe key survives tail divergence but separates real replies', () => {
  const { inboundPrefix } = require('../src/services/reply-dedupe');

  const a = 'Joshua: Got my attention! What are the next steps? Best, Chris Chris Arnold Managing Partner CA Partners P (727)828-9021 C (734)377-9629 Book time with Chris Arnold chrisa@capmri.com From: Joshua Osborn <j@x.org';
  const b = 'Joshua: Got my attention! What are the next steps? Best, Chris Chris Arnold Managing Partner CA Partners P (727)828-9021 C (734)377-9629 Book time with Chris Arnold [https://outlook.office.com/x] chrisa@capmri.com [cid:image001.png]';
  assert.strictEqual(inboundPrefix(a), inboundPrefix(b), 'two renderings of one reply must share a key');

  assert.notStrictEqual(inboundPrefix('Yes'), inboundPrefix('No'));
  assert.notStrictEqual(
    inboundPrefix('Sounds good, Tuesday works'),
    inboundPrefix('Sounds good, Wednesday works'),
    'genuinely different replies must not collapse'
  );
});

// ── Drafts ────────────────────────────────────────────────────────────
// The mailbox appends the real signature; a draft sign-off stacks a second.
test('drafts carry no sign-off', () => {
  const { stripSignOff } = require('../src/services/classifier');
  assert.strictEqual(stripSignOff('Does Tuesday work?\n\nBest,\nJosh'), 'Does Tuesday work?');
  assert.strictEqual(stripSignOff('Happy to chat.\n\n- Josh'), 'Happy to chat.');
  // Must not eat real content that merely ends politely.
  assert.strictEqual(
    stripSignOff('Hey Josh, thanks for getting back to me. Does Tuesday work?'),
    'Hey Josh, thanks for getting back to me. Does Tuesday work?'
  );
});

// ── Backstop ──────────────────────────────────────────────────────────
// Webhooks are not the only path. The pollers recovered the 413 backlog.
test('the polling backstop is still wired up', () => {
  for (const f of ['src/services/smartlead-poller.js', 'src/services/heyreach-poller.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is the webhook backstop — do not remove it`);
  }
  const cron = read('src/cron.js');
  assert.match(cron, /pollSmartleadReplies/, 'SmartLead poller must stay scheduled');
  assert.match(cron, /pollHeyReachReplies/, 'HeyReach poller must stay scheduled');
  assert.match(cron, /runDueFollowUps/, 'follow-up runner must stay scheduled');
});

// ── Fail-open ─────────────────────────────────────────────────────────
// A broken integration must produce a redundant nudge, never a swallowed one.
test('call booking checks fail open when unconfigured', async () => {
  delete process.env.ALLO_API_KEY;
  delete process.env.CUBE_ACR_DRIVE_FOLDER_ID;
  const { callSaysBooked } = require('../src/services/call-booking-check');
  const result = await callSaysBooked('00000000-0000-0000-0000-000000000000', {
    platform: 'smartlead', leadEmail: 'nobody@example.com', leadId: '1', since: new Date(),
  });
  assert.strictEqual(result, null, 'an unconfigured call check must report "not booked", never throw');
});

// ── Client notify ─────────────────────────────────────────────────────
// One notify path, on send, enriched. A second on inbound was rejected.
test('client notification stays on the enriched send path', () => {
  const smartlead = read('src/services/smartlead.js');
  assert.match(smartlead, /forwardThreadToClient/, 'the enriched client forward must remain');
  const webhooks = read('src/routes/webhooks.js');
  assert.ok(
    !/forwardEmail\s*\(/.test(webhooks),
    'do not forward inbound replies from the webhook — it fires before classification and emails clients every auto-reply'
  );
});

// OOO / REMOVE_ME may still alert in Slack, but never burn enrichment credits.
test('OOO and REMOVE_ME replies are not phone-enriched for client channels', () => {
  const {
    shouldSkipEnrichment,
    SKIP_ENRICH_CLASSIFICATIONS,
  } = require('../src/services/reply-phone-enrichment');
  const post = read('src/services/slack-reply-post.js');

  assert.ok(SKIP_ENRICH_CLASSIFICATIONS.has('OOO'));
  assert.ok(SKIP_ENRICH_CLASSIFICATIONS.has('REMOVE_ME'));
  assert.ok(shouldSkipEnrichment('OOO'));
  assert.ok(shouldSkipEnrichment('OUT_OF_OFFICE'));
  assert.ok(shouldSkipEnrichment('REMOVE_ME'));
  assert.ok(!shouldSkipEnrichment('INTERESTED'));
  assert.ok(!shouldSkipEnrichment('QUESTION'));
  assert.match(
    post,
    /shouldSkipEnrichment\(card\?\.classification\)/,
    'Slack card posts must skip enrichment for OOO/REMOVE_ME'
  );
});
