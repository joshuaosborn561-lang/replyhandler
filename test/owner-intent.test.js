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

/**
 * Failure text for an owner decision.
 *
 * A red test here is not a bug report — it means someone is about to reverse a
 * call Josh made. Say so plainly, name the decision, and ask them to check with
 * him rather than leaving them to guess or delete the guard.
 */
function reversal(decision, detail) {
  return [
    '',
    'STOP — this reverses one of Josh\'s decisions.',
    '',
    `  Decision: ${decision}`,
    `  Problem:  ${detail}`,
    '',
    '  This is not a bug. Josh chose this deliberately — see DECISIONS.md for',
    '  the reasoning and the tradeoff he accepted. Several of these were already',
    '  reversed once before settling, so the current state is the considered one.',
    '',
    '  Check with Josh before changing it. Do not delete this guard to go green.',
    '',
  ].join('\n');
}

// ── Decision: silence exactly three things ────────────────────────────
// Asked for OOO + unsubscribe silent, then added wrong-person, then
// explicitly pulled NOT_INTERESTED back out: "not interested should be on
// there but everything else is right."
test('NOT_INTERESTED reaches Slack and drafts — reversed once, settled', () => {
  const { slackSuppressionReason } = require('../src/utils/smartlead-webhook-helpers');
  const { DRAFT_CLASSIFICATIONS } = require('../src/services/classifier');

  assert.strictEqual(slackSuppressionReason('Not interested at this time'), null,
    reversal('NOT_INTERESTED must reach Slack', 'a not-interested reply is being silenced'));
  assert.strictEqual(slackSuppressionReason('We are not interested'), null,
    reversal('NOT_INTERESTED must reach Slack', 'a not-interested reply is being silenced'));
  assert.ok(DRAFT_CLASSIFICATIONS.includes('NOT_INTERESTED'),
    reversal('NOT_INTERESTED must get a draft', 'it has been moved back to alert-only'));
});

// ── Decision: declines get a graceful draft, never a pitch ────────────
// "still draft for not interested replies" — but the default times-first
// prompt would have pushed meeting slots at someone who just said no.
test('declines draft without pitch, times or link', () => {
  const { DECLINE_CLASSIFICATIONS, fallbackDraftText } = require('../src/services/classifier');
  assert.ok(DECLINE_CLASSIFICATIONS.has('NOT_INTERESTED'),
    reversal('declines draft in decline mode', 'NOT_INTERESTED no longer uses decline mode'));

  const draft = fallbackDraftText({
    leadName: 'Marina Chen',
    classification: 'NOT_INTERESTED',
    bookingLink: 'https://cal.com/x',
    digestTimezone: 'America/Chicago',
  });
  assert.ok(!/https?:\/\//.test(draft),
    reversal('a decline draft carries no pitch', 'a booking link is being sent to someone who declined'));
  assert.ok(!/\b(mid-morning|early afternoon)\b/.test(draft),
    reversal('a decline draft carries no pitch', 'meeting times are being pushed at someone who declined'));
  assert.match(draft, /check back|take you off/i,
    reversal('a decline draft asks about checking back later', 'that closing question has been removed'));
});

// ── Decision: keep the prospect's signature on the card ───────────────
// I stripped it as noise; he wanted it: "no i like the sig on there."
// Title, phones and booking link are useful context on a reply.
test("the prospect's signature stays on inbound cards", () => {
  const { cleanInboundReply } = require('../src/utils/smartlead-webhook-helpers');
  const raw = 'Got my attention! What are the next steps? Best, Chris Chris Arnold Managing Partner P (727)828-9021 chrisa@capmri.com From: Joshua Osborn <j@x.org>';
  const out = cleanInboundReply(raw);

  assert.match(out, /Managing Partner/,
    reversal("the prospect's signature stays on cards", 'the job title is being stripped'));
  assert.match(out, /\(727\)828-9021/,
    reversal("the prospect's signature stays on cards", 'the phone number is being stripped'));
  assert.match(out, /chrisa@capmri\.com/,
    reversal("the prospect's signature stays on cards", 'the email address is being stripped'));
  // Quoted thread history is still noise and must go.
  assert.ok(!/From:\s*Joshua Osborn/.test(out), 'quoted thread history must still be stripped');
});

// ── Decision: no sign-off on our drafts ───────────────────────────────
// "remove sigs from ai drafts. just keep the sig on the email account."
// SmartLead sends with add_signature: true, so a draft sign-off stacks.
test('our drafts add no sign-off, mailbox signature only', () => {
  const classifier = read('src/services/classifier.js');
  assert.match(classifier, /Do NOT add any sign-off/i,
    reversal('our drafts carry no sign-off', 'the prompt no longer forbids one; the mailbox already signs'));
  assert.match(read('src/services/smartlead.js'), /add_signature:\s*true/, 'SmartLead must keep appending the real signature');
});

// ── Decision: times-first, link only on request ───────────────────────
// Offered to always include the booking link; he chose to keep times-first.
test('booking link is withheld until the prospect asks', () => {
  const { sanitizeDraft, looksLikeBookingLinkRequest } = require('../src/services/classifier');
  const link = 'https://calendly.com/joshua-salesglidergrowth/30min';

  // Model leaked a link on a times-first reply — it must be stripped.
  const stripped = sanitizeDraft(`Does Tuesday work? ${link}`, { bookingLink: link, includeBookingLink: false });
  assert.ok(!stripped.includes(link),
    reversal('times-first — the link waits until asked', 'a booking link is leaking into an unasked-for draft'));

  // Asked for it — it must be present.
  const withLink = sanitizeDraft('Sure, here you go.', { bookingLink: link, includeBookingLink: true });
  assert.ok(withLink.includes(link), 'a requested link must be included');

  assert.ok(looksLikeBookingLinkRequest('send me the link', ''), 'an explicit ask must be detected');
  assert.ok(!looksLikeBookingLinkRequest('what does pricing look like?', ''), 'a question is not a link request');
});

// ── Decision: follow-ups after meeting propose at 2h/24h/48h/1w ───────
test('follow-ups after meeting propose at 2h/24h/48h/1w', () => {
  delete process.env.FOLLOW_UP_HOURS;
  delete process.env.FOLLOW_UP_REMINDER_HOURS;
  delete process.env.FOLLOW_UP_MAX_AGE_HOURS;

  // Clear require cache so env deletes take effect
  delete require.cache[require.resolve('../src/services/outbound-follow-up')];
  delete require.cache[require.resolve('../src/services/follow-up-runner')];

  const {
    followUpCadenceHours,
    DEFAULT_CADENCE,
  } = require('../src/services/outbound-follow-up');
  const { outboundProposesMeeting } = require('../src/utils/outbound-meeting-propose');
  const { maxAgeHours, retireStaleFollowUps } = require('../src/services/follow-up-runner');
  const scheduleSrc = read('src/services/outbound-follow-up.js');

  assert.deepStrictEqual(followUpCadenceHours(), DEFAULT_CADENCE);
  assert.deepStrictEqual(DEFAULT_CADENCE, [2, 24, 48, 168],
    reversal('follow-ups after meeting propose at 2h/24h/48h/1w', 'the cadence has been changed'));
  assert.strictEqual(maxAgeHours(), 24,
    reversal('no backlog — follow-ups from deploy onward', 'the stale guard has been widened or removed'));
  assert.strictEqual(typeof retireStaleFollowUps, 'function', 'the backlog guard must remain');

  assert.ok(scheduleSrc.includes('outboundProposesMeeting'),
    'scheduling must gate on meeting-propose detection');
  assert.ok(scheduleSrc.includes("FOLLOW_UP"),
    'FOLLOW_UP sends must not restart the cadence');

  assert.ok(outboundProposesMeeting(
    'Wanted to see if you can do tomorrow or Wednesday. Can I send you a Calendly link or would you prefer me to book for you?'
  ), 'Calendly / book-for-you must count as proposing');
  assert.ok(outboundProposesMeeting(
    'Would Thursday mid-morning or Friday early afternoon work for a quick call with our CEO?'
  ), 'times-first call ask must count as proposing');
  assert.ok(!outboundProposesMeeting(
    'Thanks — tickets are yours either way, no strings attached.'
  ), 'ticket-only send must not schedule follow-ups');
});

// ── Decision: a call that booked skips silently ───────────────────────
// Offered a Slack note on skip; he chose "Skip silently."
test('a call-transcript booking suppresses without posting', () => {
  const runner = read('src/services/follow-up-runner.js');
  const skipBlock = runner.slice(runner.indexOf('if (bookedReason)'), runner.indexOf('await postFollowUpCard'));
  assert.ok(!/postProspectSlackCard|postAlert|postError/.test(skipBlock),
    reversal('a call-transcript booking skips silently', 'the skip path now posts to Slack'));
});

// ── Decision: track both Allo lines ───────────────────────────────────
// "there are 2 allo numbers track them both" — discovered, not configured.
test('all Allo lines are searched, discovered from the API', () => {
  const allo = read('src/services/allo.js');
  assert.match(allo, /\/numbers/, 'numbers must be discovered from GET /numbers');
  assert.match(allo, /for \(const from of numbers\)/,
    reversal('track both Allo lines', 'only one line is being searched'));
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

// ── Decision: same text = duplicate, new text = always show me ────────
// "no the same text from the same client shouldnt come through. i need to
// see if a client responds, ever." An earlier fix used a 90-minute
// lead-level window; that could swallow a genuinely new reply, which is
// worse than a double. Dedupe is on the text only, and unbounded in time.
test('the same reply never repeats, a new reply always shows', () => {
  const { inboundPrefix, normalizeInboundText, MIN_CONTAINMENT_LEN, STORED_NORM_SQL } = require('../src/services/reply-dedupe');

  const sameReply = (x, y) => {
    if (inboundPrefix(x) && inboundPrefix(x) === inboundPrefix(y)) return true;
    const a = normalizeInboundText(x);
    const b = normalizeInboundText(y);
    return a.length >= MIN_CONTAINMENT_LEN && b.length >= MIN_CONTAINMENT_LEN
      && (a.startsWith(b) || b.startsWith(a));
  };

  // LinkedIn/HeyReach often inserts NBSP before URLs. JS `\s` collapses it;
  // Postgres `\s` does not — SQL must replace chr(160) first or the poller
  // re-posts the same card every cycle (Braden Ricchini incident).
  const withNbsp = 'Joshua here ya go man:\u00a0https://files.gpsocials.com/notion-giveaway';
  const withSpace = 'Joshua here ya go man: https://files.gpsocials.com/notion-giveaway';
  assert.strictEqual(normalizeInboundText(withNbsp), normalizeInboundText(withSpace),
    reversal('same text must not come through twice', 'NBSP vs space is being treated as a different reply'));
  assert.match(STORED_NORM_SQL, /chr\(160\)/,
    reversal('same text must not come through twice', 'SQL dedupe no longer collapses NBSP'));

  // One reply, rendered two ways by the webhook and the poller.
  const withQuote = 'Joshua: Got my attention! What are the next steps? Best, Chris Chris Arnold Managing Partner CA Partners P (727)828-9021 Book time with Chris From: Joshua Osborn';
  const withLinks = 'Joshua: Got my attention! What are the next steps? Best, Chris Chris Arnold Managing Partner CA Partners P (727)828-9021 Book time with Chris [https://x] [cid:i.png]';
  const truncated = 'Joshua: Got my attention! What are the next steps?';
  assert.ok(sameReply(withQuote, withLinks),
    reversal('the same text must not come through twice', 'divergent renderings are being treated as different replies'));
  assert.ok(sameReply(withQuote, truncated),
    reversal('the same text must not come through twice', 'a truncated rendering is being treated as a different reply'));

  // Different replies from the same person must every one reach Slack.
  for (const [x, y] of [
    ['Got my attention! What are the next steps?', 'Actually can we do Thursday instead?'],
    ['Sounds good, Tuesday works', 'Sounds good, Wednesday works'],
    ['Yes', 'No'],
    ['Thanks, let me review with my team and come back to you', 'Reviewed it — what does pricing look like for 20 seats?'],
  ]) {
    assert.ok(!sameReply(x, y),
      reversal('every new reply must reach Slack', `a different reply is being suppressed as a duplicate: "${y}"`));
  }
});

// No time-based suppression may exist on the posting path: a prospect who
// replies twice in an hour must produce two cards.
test('no time window can swallow a reply', () => {
  const post = read('src/services/slack-reply-post.js');
  assert.ok(!/leadCardPostedRecently|LEAD_CARD_WINDOW/.test(post),
    reversal('every new reply must reach Slack',
      'a time-window lead check is back on the posting path — it suppresses real replies'));
});

// ── Decision: SmartLead classifies its own email replies ──────────────
// "just use smartleads classifier." Gemini still writes the draft, and
// LinkedIn stays fully on Gemini since it has no category.
test("SmartLead's category wins over Gemini for email", () => {
  const { categoryToClassification, classifyFromSmartlead } = require('../src/services/smartlead-category');

  assert.strictEqual(categoryToClassification('Interested'), 'INTERESTED',
    reversal("SmartLead's category classifies email", 'the category mapping is broken'));
  assert.strictEqual(categoryToClassification('Meeting Request'), 'MEETING_PROPOSED');
  assert.strictEqual(categoryToClassification('Not Interested'), 'NOT_INTERESTED');
  assert.strictEqual(categoryToClassification('Out Of Office'), 'OOO');

  // An unrecognised category must still surface, never silently drop.
  const unmapped = classifyFromSmartlead({ lead_category: 'Referred to colleague' });
  assert.strictEqual(unmapped.classification, 'OTHER',
    reversal("SmartLead's category classifies email", 'an unknown category is no longer surfaced'));

  // No category at all → fall back to Gemini rather than guessing.
  assert.strictEqual(classifyFromSmartlead({ foo: 1 }), null);

  const webhooks = read('src/routes/webhooks.js');
  assert.match(webhooks, /classifyFromSmartlead/,
    reversal("SmartLead's category classifies email", 'the SmartLead webhook no longer consults its category'));
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
