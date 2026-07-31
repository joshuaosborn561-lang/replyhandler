/**
 * Owner intent.
 *
 * Every assertion here is a product decision Josh made explicitly, not an
 * engineering judgement. They are separated from invariants.test.js on
 * purpose: those are safety rules anyone should keep, these are *his calls*.
 *
 * If one of these fails, the change is not a bug fix — it is a reversal of a
 * decision. Ask him before touching it. Several of these were reversed once
 * already during the conversation that produced them, so the current state is
 * the settled one, not the first draft.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── Decision: silence exactly three things ────────────────────────────
// Asked for OOO + unsubscribe silent, then added wrong-person, then
// explicitly pulled NOT_INTERESTED back out: "not interested should be on
// there but everything else is right."
test('NOT_INTERESTED reaches Slack and drafts — reversed once, settled', () => {
  const { slackSuppressionReason } = require('../src/utils/smartlead-webhook-helpers');
  const { DRAFT_CLASSIFICATIONS } = require('../src/services/classifier');

  assert.strictEqual(slackSuppressionReason('Not interested at this time'), null);
  assert.strictEqual(slackSuppressionReason('We are not interested'), null);
  assert.ok(DRAFT_CLASSIFICATIONS.includes('NOT_INTERESTED'));
});

// ── Decision: declines get a graceful draft, never a pitch ────────────
// "still draft for not interested replies" — but the default times-first
// prompt would have pushed meeting slots at someone who just said no.
test('declines draft without pitch, times or link', () => {
  const { DECLINE_CLASSIFICATIONS, fallbackDraftText } = require('../src/services/classifier');
  assert.ok(DECLINE_CLASSIFICATIONS.has('NOT_INTERESTED'), 'NOT_INTERESTED must use decline mode');

  const draft = fallbackDraftText({
    leadName: 'Marina Chen',
    classification: 'NOT_INTERESTED',
    bookingLink: 'https://cal.com/x',
    digestTimezone: 'America/Chicago',
  });
  assert.ok(!/https?:\/\//.test(draft), 'a decline draft must not contain a link');
  assert.ok(!/\b(mid-morning|early afternoon)\b/.test(draft), 'a decline draft must not suggest times');
  assert.match(draft, /check back|take you off/i, 'a decline draft should ask about checking back');
});

// ── Decision: keep the prospect's signature on the card ───────────────
// I stripped it as noise; he wanted it: "no i like the sig on there."
// Title, phones and booking link are useful context on a reply.
test("the prospect's signature stays on inbound cards", () => {
  const { cleanInboundReply } = require('../src/utils/smartlead-webhook-helpers');
  const raw = 'Got my attention! What are the next steps? Best, Chris Chris Arnold Managing Partner P (727)828-9021 chrisa@capmri.com From: Joshua Osborn <j@x.org>';
  const out = cleanInboundReply(raw);

  assert.match(out, /Managing Partner/, 'job title must survive');
  assert.match(out, /\(727\)828-9021/, 'phone must survive');
  assert.match(out, /chrisa@capmri\.com/, 'email must survive');
  // Quoted thread history is still noise and must go.
  assert.ok(!/From:\s*Joshua Osborn/.test(out), 'quoted thread history must still be stripped');
});

// ── Decision: no sign-off on our drafts ───────────────────────────────
// "remove sigs from ai drafts. just keep the sig on the email account."
// SmartLead sends with add_signature: true, so a draft sign-off stacks.
test('our drafts add no sign-off, mailbox signature only', () => {
  const classifier = read('src/services/classifier.js');
  assert.match(
    classifier,
    /Do NOT add any sign-off/i,
    'the prompt must forbid sign-offs — the mailbox appends the real signature'
  );
  assert.match(read('src/services/smartlead.js'), /add_signature:\s*true/, 'SmartLead must keep appending the real signature');
});

// ── Decision: times-first, link only on request ───────────────────────
// Offered to always include the booking link; he chose to keep times-first.
test('booking link is withheld until the prospect asks', () => {
  const { sanitizeDraft, looksLikeBookingLinkRequest } = require('../src/services/classifier');
  const link = 'https://calendly.com/joshua-salesglidergrowth/30min';

  // Model leaked a link on a times-first reply — it must be stripped.
  const stripped = sanitizeDraft(`Does Tuesday work? ${link}`, { bookingLink: link, includeBookingLink: false });
  assert.ok(!stripped.includes(link), 'times-first drafts must not contain a booking URL');

  // Asked for it — it must be present.
  const withLink = sanitizeDraft('Sure, here you go.', { bookingLink: link, includeBookingLink: true });
  assert.ok(withLink.includes(link), 'a requested link must be included');

  assert.ok(looksLikeBookingLinkRequest('send me the link', ''), 'an explicit ask must be detected');
  assert.ok(!looksLikeBookingLinkRequest('what does pricing look like?', ''), 'a question is not a link request');
});

// ── Decision: follow up after 3 hours, from now on only ───────────────
// "if a prospect doesnt reply to our reply after 3 hours" and
// "yea no backlog just from here on out."
test('follow-ups wait 3h and never replay a backlog', () => {
  delete process.env.FOLLOW_UP_HOURS;
  delete process.env.FOLLOW_UP_REMINDER_HOURS;
  delete process.env.FOLLOW_UP_MAX_AGE_HOURS;
  const { followUpHours } = require('../src/services/outbound-follow-up');
  const { maxAgeHours, retireStaleFollowUps } = require('../src/services/follow-up-runner');

  assert.strictEqual(followUpHours(), 3, 'the follow-up wait must default to 3 hours');
  assert.strictEqual(maxAgeHours(), 24, 'stale follow-ups must be retired, not posted');
  assert.strictEqual(typeof retireStaleFollowUps, 'function', 'the backlog guard must remain');
});

// ── Decision: a call that booked skips silently ───────────────────────
// Offered a Slack note on skip; he chose "Skip silently."
test('a call-transcript booking suppresses without posting', () => {
  const runner = read('src/services/follow-up-runner.js');
  const skipBlock = runner.slice(runner.indexOf('if (bookedReason)'), runner.indexOf('await postFollowUpCard'));
  assert.ok(
    !/postProspectSlackCard|postAlert|postError/.test(skipBlock),
    'a skipped follow-up must post nothing to Slack — it records skip_reason only'
  );
});

// ── Decision: track both Allo lines ───────────────────────────────────
// "there are 2 allo numbers track them both" — discovered, not configured.
test('all Allo lines are searched, discovered from the API', () => {
  const allo = read('src/services/allo.js');
  assert.match(allo, /\/numbers/, 'numbers must be discovered from GET /numbers');
  assert.match(allo, /for \(const from of numbers\)/, 'every line must be searched, not just the first');
  // Auth is the raw key — a Bearer prefix silently 401s.
  assert.ok(
    !/Bearer \$\{?\s*(key|apiKey)/.test(allo),
    'Allo auth is the raw key with no Bearer prefix'
  );
});

// ── Decision: cell recordings matched by phone number ─────────────────
// "it will be in sub folders of the date and be the phone number."
test('Cube ACR recordings match on the last 10 digits', () => {
  const { phoneKey } = require('../src/services/google-drive');
  assert.strictEqual(phoneKey('+1 (727) 306-8021'), '7273068021');
  assert.strictEqual(phoneKey('7273068021'), '7273068021');
  assert.strictEqual(phoneKey('17273068021'), '7273068021');
  assert.strictEqual(phoneKey('123'), '', 'too short to identify anyone');
});

// ── Decision: the pending-nudge system stays deleted ──────────────────
// "for the love of gof delete all the you havent actioned alerts."
// Also covered in invariants.test.js; repeated here because it is his call,
// not an engineering one.
test('no nudge system is reintroduced', () => {
  const slackService = read('src/services/slack.js');
  const slackRoute = read('src/routes/slack.js');
  for (const [name, body] of [['services/slack.js', slackService], ['routes/slack.js', slackRoute]]) {
    assert.ok(!/postPendingNudge|already_replied|snooze_nudge/.test(body), `${name} must stay free of nudge code`);
  }
});
