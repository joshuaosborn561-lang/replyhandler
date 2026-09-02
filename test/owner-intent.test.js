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

// ── Decision: AI reply channels are interested-only ───────────────────
// "i only want interested replies to come through there. no OOO and no
// not interested" — supersedes the older "NOT_INTERESTED reaches Slack".
test('Slack channels are interested-only — OOO and NOT_INTERESTED suppressed', () => {
  const {
    slackChannelSuppressionReason,
    SLACK_CHANNEL_CLASSIFICATIONS,
  } = require('../src/utils/slack-channel-policy');
  const { DRAFT_CLASSIFICATIONS } = require('../src/services/classifier');

  assert.ok(SLACK_CHANNEL_CLASSIFICATIONS.has('INTERESTED'));
  assert.ok(SLACK_CHANNEL_CLASSIFICATIONS.has('MEETING_PROPOSED'));
  assert.ok(SLACK_CHANNEL_CLASSIFICATIONS.has('QUESTION'));
  assert.strictEqual(
    slackChannelSuppressionReason({ classification: 'OOO', inboundMessage: 'out of office' }),
    'ooo',
    reversal('Slack channels are interested-only', 'OOO is posting again'),
  );
  assert.strictEqual(
    slackChannelSuppressionReason({ classification: 'NOT_INTERESTED', inboundMessage: 'not interested' }),
    'not_interested',
    reversal('Slack channels are interested-only', 'NOT_INTERESTED is posting again'),
  );
  assert.strictEqual(
    slackChannelSuppressionReason({ classification: 'INTERESTED', inboundMessage: 'Sure' }),
    null,
  );
  assert.ok(!DRAFT_CLASSIFICATIONS.includes('NOT_INTERESTED'),
    reversal('Slack channels are interested-only', 'NOT_INTERESTED is drafting again'));
  assert.ok(!DRAFT_CLASSIFICATIONS.includes('OOO'));
  assert.deepEqual([...DRAFT_CLASSIFICATIONS].sort(), ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION'].sort());
});

// ── Decision: Josh drafts ack-first + first vs continuation ───────────
test('Josh drafts ack-first with first vs continuation and CEO handoff scrub', () => {
  const claude = read('src/services/claude-reply-draft.js');
  const classifier = read('src/services/classifier.js');
  const learning = read('src/services/approved-reply-learning.js');
  const guard = read('src/utils/principal-draft-guard.js');
  const ordinal = read('src/utils/reply-ordinal.js');
  assert.ok(claude.includes('ACK FIRST') || claude.includes('Acknowledge their latest point'),
    reversal('Josh drafts ack-first', 'ack-first rules were removed from Claude drafts'));
  assert.ok(claude.includes('CONTINUATION') && claude.includes('FIRST_TOUCH'),
    reversal('Josh drafts ack-first', 'first/continuation modes were removed'));
  assert.ok(classifier.includes('replyMode') && ordinal.includes('resolveReplyOrdinal'),
    reversal('Josh drafts ack-first', 'reply ordinal wiring was removed'));
  assert.ok(guard.includes('our\\s+ceo') || guard.includes('our CEO') || guard.includes('HANDOFF_RE'),
    reversal('Josh drafts ack-first', 'CEO/founder handoff scrub was removed'));
  assert.ok(learning.includes('follow_up') || learning.includes('FOLLOW_UP'),
    reversal('Josh drafts ack-first', 'FOLLOW_UP learning skip was removed'));
});

// ── Decision: Claude fail → Gemini, not robotic template ──────────────
test('Claude draft failures fall through to Gemini not the robotic template', () => {
  const classifier = read('src/services/classifier.js');
  assert.ok(classifier.includes('falling through to Gemini'),
    reversal('Claude fail → Gemini', 'Claude failures skip Gemini again'));
  assert.ok(!classifier.includes('Claude retrieval draft failed — using deterministic fallback'),
    reversal('Claude fail → Gemini', 'Claude failures dump straight to template again'));
  assert.ok(classifier.includes('draftWithGemini'),
    reversal('Claude fail → Gemini', 'Gemini draft path was removed'));
});

// ── Decision: Claude never runs on poller/backfill; drafts positives only ─
test('Claude never runs on bulk backfill; only positives get drafts', () => {
  const classifier = read('src/services/classifier.js');
  const sl = read('src/services/smartlead-poller.js');
  const hr = read('src/services/heyreach-poller.js');
  const { DRAFT_CLASSIFICATIONS, shouldUseAnthropicDrafts } = require('../src/services/classifier');
  assert.ok(classifier.includes('shouldUseAnthropicDrafts') && classifier.includes("=== 'bulk'"),
    reversal('Claude bulk gate', 'bulk Anthropic gate was removed'));
  assert.ok(sl.includes("draftMode: 'bulk'") && hr.includes("draftMode: 'bulk'"),
    reversal('Claude bulk gate', 'pollers no longer mark drafts as bulk'));
  assert.equal(shouldUseAnthropicDrafts({ draftMode: 'bulk' }), false,
    reversal('Claude bulk gate', 'bulk mode can call Claude again'));
  assert.deepEqual([...DRAFT_CLASSIFICATIONS].sort(), ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION'].sort(),
    reversal('Claude bulk gate', 'draft classifications expanded past positives'));
});

// ── Decision: Vasco / Carlos offers in-person meetings only ───────────
test('Vasco / Carlos drafts offer in-person meetings only', () => {
  const modality = read('src/utils/meeting-modality.js');
  const classifier = read('src/services/classifier.js');
  const bumps = read('src/services/follow-up-drafts.js');
  assert.ok(modality.includes('prefersInPersonMeeting'),
    reversal('Vasco in-person meetings', 'meeting-modality helper was removed'));
  assert.ok(classifier.includes('meeting-modality') && classifier.includes('IN-PERSON'),
    reversal('Vasco in-person meetings', 'classifier no longer honors in-person voice'));
  assert.ok(bumps.includes('prefersInPersonMeeting') && bumps.includes('stopping by in person'),
    reversal('Vasco in-person meetings', 'FOLLOW_UP bumps ignore in-person voice'));
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

// ── Decision: follow-ups after any positive reply at 2h/24h/48h/1w ─────
// Supersedes "only after meeting propose". "no any positive reply should
// be on that cadence"
test('follow-ups after any positive reply at 2h/24h/48h/1w', () => {
  delete process.env.FOLLOW_UP_HOURS;
  delete process.env.FOLLOW_UP_REMINDER_HOURS;
  delete process.env.FOLLOW_UP_MAX_AGE_HOURS;

  delete require.cache[require.resolve('../src/services/outbound-follow-up')];
  delete require.cache[require.resolve('../src/services/follow-up-runner')];

  const {
    followUpCadenceHours,
    DEFAULT_CADENCE,
    isPositiveFollowUpClassification,
    POSITIVE_FOLLOW_UP_CLASSIFICATIONS,
  } = require('../src/services/outbound-follow-up');
  const { maxAgeHours, retireStaleFollowUps } = require('../src/services/follow-up-runner');
  const scheduleSrc = read('src/services/outbound-follow-up.js');

  assert.deepStrictEqual(followUpCadenceHours(), DEFAULT_CADENCE);
  assert.deepStrictEqual(DEFAULT_CADENCE, [2, 24, 48, 168],
    reversal('follow-ups after any positive reply at 2h/24h/48h/1w', 'the cadence has been changed'));
  assert.strictEqual(maxAgeHours(), 24,
    reversal('no backlog — follow-ups from deploy onward', 'the stale guard has been widened or removed'));
  assert.strictEqual(typeof retireStaleFollowUps, 'function', 'the backlog guard must remain');

  assert.deepStrictEqual(
    [...POSITIVE_FOLLOW_UP_CLASSIFICATIONS].sort(),
    ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION'].sort(),
    reversal('follow-ups after any positive reply at 2h/24h/48h/1w', 'the positive allowlist changed')
  );
  assert.ok(isPositiveFollowUpClassification('INTERESTED'));
  assert.ok(isPositiveFollowUpClassification('QUESTION'));
  assert.ok(!isPositiveFollowUpClassification('NOT_INTERESTED'),
    reversal('follow-ups after any positive reply at 2h/24h/48h/1w', 'declines are being put on the cadence'));
  assert.ok(!scheduleSrc.includes('outboundProposesMeeting'),
    reversal('follow-ups after any positive reply at 2h/24h/48h/1w', 'scheduling still gates on meeting-propose text'));
  assert.ok(scheduleSrc.includes('isPositiveFollowUpClassification'),
    reversal('follow-ups after any positive reply at 2h/24h/48h/1w', 'scheduling no longer gates on positive classification'));
  assert.ok(scheduleSrc.includes('FOLLOW_UP'),
    'FOLLOW_UP sends must not restart the cadence');
  assert.match(scheduleSrc, /MAX_SCHEDULE_AGE_DAYS\s*=\s*3/,
    reversal('follow-ups after any positive reply at 2h/24h/48h/1w', '3-day backfill cap was removed'));
});

// ── Decision: a call that booked skips silently ───────────────────────
// Offered a Slack note on skip; he chose "Skip silently."
test('a call-transcript booking suppresses without posting', () => {
  const runner = read('src/services/follow-up-runner.js');
  const skipBlock = runner.slice(runner.indexOf('if (bookedReason)'), runner.indexOf('await postFollowUpCard'));
  assert.ok(!/postProspectSlackCard|postAlert|postError/.test(skipBlock),
    reversal('a call-transcript booking skips silently', 'the skip path now posts to Slack'));
});

// ── Decision: FOLLOW_UP cards post top-level with thread context
test('FOLLOW_UP cards post in the main channel with thread context', () => {
  const runner = read('src/services/follow-up-runner.js');
  const poster = read('src/services/slack-reply-post.js');
  const slackSrc = read('src/services/slack.js');
  assert.ok(runner.includes('postInThread: false'),
    reversal('FOLLOW_UP cards post in the main channel with thread context', 'FOLLOW_UP cards are threading again'));
  assert.ok(/postInThread\s*=\s*true/.test(poster) || poster.includes('postInThread = true'),
    reversal('FOLLOW_UP cards post in the main channel with thread context', 'postProspectSlackCard lost the postInThread option'));
  assert.ok(runner.includes('inbound_message') && runner.includes('sent_reply'),
    reversal('FOLLOW_UP cards post in the main channel with thread context', 'source reply context is no longer loaded'));
  assert.ok(runner.includes('getPermalink') || slackSrc.includes('getPermalink'),
    reversal('FOLLOW_UP cards post in the main channel with thread context', 'original-thread permalink helper was removed'));
  assert.ok(slackSrc.includes('followUpContext') || slackSrc.includes('buildFollowUpConversationBlocks'),
    reversal('FOLLOW_UP cards post in the main channel with thread context', 'FOLLOW_UP conversation order was removed'));
});

// ── Decision: FOLLOW_UP bumps go to dedicated Slack channel with buttons up top
test('FOLLOW_UP bumps go to dedicated channel with easy-to-reach buttons', () => {
  const runner = read('src/services/follow-up-runner.js');
  const slackSrc = read('src/services/slack.js');
  assert.ok(runner.includes('followUpSlackChannelId') && runner.includes('C0BRRS8DV19'),
    reversal('FOLLOW_UP dedicated Slack channel', 'follow-ups no longer target C0BRRS8DV19'));
  assert.ok(!/channelId:\s*client\.slack_channel_id/.test(
    runner.slice(runner.indexOf('await postProspectSlackCard'), runner.indexOf('return newReply'))
  ), reversal('FOLLOW_UP dedicated Slack channel', 'FOLLOW_UP cards still post to the client inbox channel'));
  assert.ok(slackSrc.includes('buildFollowUpConversationBlocks') && slackSrc.includes('Original message'),
    reversal('FOLLOW_UP dedicated Slack channel', 'FOLLOW_UP layout lost original → our reply → rest'));
  assert.ok(slackSrc.includes('draftApprovalActionsBlock'),
    reversal('FOLLOW_UP dedicated Slack channel', 'shared approval actions helper missing'));
  // Buttons must be assembled before the long conversation for FOLLOW_UP.
  const postFn = slackSrc.slice(slackSrc.indexOf('async function postDraftApproval'));
  const followUpBranch = postFn.slice(postFn.indexOf('const blocks = isFollowUp'), postFn.indexOf('if (!isFollowUp && platform'));
  assert.ok(
    followUpBranch.indexOf('draftApprovalActionsBlock') < followUpBranch.indexOf('...conversation'),
    reversal('FOLLOW_UP dedicated Slack channel', 'FOLLOW_UP buttons are buried under the conversation again'),
  );
});

// ── Decision: FOLLOW_UP bumps are offer-first, full thread, Meeting booked ──
test('FOLLOW_UP bumps are offer-first with full thread and Meeting booked button', () => {
  const drafts = read('src/services/follow-up-drafts.js');
  const runner = read('src/services/follow-up-runner.js');
  const slackSrc = read('src/services/slack.js');
  const routes = read('src/routes/slack.js');
  const booked = read('src/services/meeting-booked.js');
  assert.ok(drafts.includes('detectOffer') && drafts.includes('bumpForOffer'),
    reversal('FOLLOW_UP bumps are offer-first with full thread and Meeting booked button', 'offer-first bump helpers were removed'));
  assert.ok(!/return\s*\(?\s*`Hey \$\{name\}, thanks for getting back to me/.test(drafts),
    reversal('FOLLOW_UP bumps are offer-first with full thread and Meeting booked button', 'FOLLOW_UP drafts reused the first-reply opener'));
  assert.ok(runner.includes('threadMessages') && runner.includes('extractThreadMessages'),
    reversal('FOLLOW_UP bumps are offer-first with full thread and Meeting booked button', 'full thread history is no longer passed to Slack'));
  assert.ok(slackSrc.includes("action_id: 'meeting_booked'") || slackSrc.includes('action_id: "meeting_booked"'),
    reversal('FOLLOW_UP bumps are offer-first with full thread and Meeting booked button', 'Meeting booked button missing from Slack cards'));
  assert.ok(routes.includes('handleMeetingBooked') && routes.includes('meeting_booked'),
    reversal('FOLLOW_UP bumps are offer-first with full thread and Meeting booked button', 'Meeting booked Slack handler missing'));
  assert.ok(booked.includes("status = 'booked'") && booked.includes('cancelPendingForThread'),
    reversal('FOLLOW_UP bumps are offer-first with full thread and Meeting booked button', 'Meeting booked no longer records meeting + cancels cadence'));
});

// ── Decision: FOLLOW_UP bumps reframe value prop; 3rd bump no dashes ──
test('FOLLOW_UP bumps reframe value prop and 3rd bump has no dashes', () => {
  const drafts = read('src/services/follow-up-drafts.js');
  const { fallbackReattempt } = require('../src/services/follow-up-drafts');
  assert.ok(drafts.includes('valuePropPhrase') && drafts.includes('scrubDashes'),
    reversal('FOLLOW_UP value-prop bumps', 'value-prop / dash scrub helpers were removed'));
  const step3 = fallbackReattempt({
    leadName: 'Scott',
    lastOutboundMessage: 'Free campaign to 10k leads on me for more business clients.',
    step: 3,
  });
  assert.match(step3, /still interested in meeting for/i,
    reversal('FOLLOW_UP value-prop bumps', '3rd bump dropped the value-prop reframe'));
  assert.doesNotMatch(step3, /[—–]/,
    reversal('FOLLOW_UP value-prop bumps', '3rd bump has dashes again'));
  assert.match(step3, /\.\.\./,
    reversal('FOLLOW_UP value-prop bumps', '3rd bump should use ellipsis instead of dashes'));
});

// ── Decision: follow-up draft tolerates null digest_timezone ──────────
test('follow-up draft tolerates null digest_timezone', () => {
  const { nextBusinessDayLabel } = require('../src/services/classifier');
  const { draftReattemptToBook } = require('../src/services/follow-up-drafts');
  assert.doesNotThrow(() => nextBusinessDayLabel(null));
  assert.doesNotThrow(() => nextBusinessDayLabel(undefined));
  assert.doesNotThrow(() => nextBusinessDayLabel(''));
  assert.match(nextBusinessDayLabel(null), /day$/i);
  return draftReattemptToBook({ leadName: 'Jim Sprague', digestTimezone: null })
    .then((draft) => {
      assert.ok(draft && draft.includes('Jim'), 'draft must still render with null TZ');
    });
});

// ── Decision: Allo booking check matches the prospect phone ───────────
test('Allo booking check matches the prospect phone', () => {
  const { callInvolvesContact, phoneKey } = require('../src/services/allo');
  assert.strictEqual(phoneKey('+1 (952) 567-3901'), '9525673901');
  assert.ok(callInvolvesContact({ to_number: '+19525673901', from_number: '+12149107558' }, '+19525673901'));
  assert.ok(!callInvolvesContact({ to_number: '+19044089681', from_number: '+18633049904' }, '+19525673901'),
    reversal('Allo booking check matches the prospect phone', 'unrelated calls can still suppress follow-ups'));
});

// ── Decision: poller dedupe is text-only (stats_id is not identity) ───
test('poller dedupe never matches on stats_id alone', () => {
  const dedupe = read('src/services/reply-dedupe.js');
  assert.ok(!/COALESCE\(smartlead_email_stats_id/.test(dedupe),
    reversal('dedupe on text only', 'reply-dedupe still has a stats_id SQL branch'));
  assert.ok(!/smartlead_email_stats_id,\s*''\)\s*=\s*\$/.test(dedupe),
    reversal('dedupe on text only', 'poller still matches on stats_id equality'));
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

// ── Decision: Slack campaign field shows the campaign name ────────────
// "also i need the campaign ID in slack to be the name of the cmapaign
// not just the numbers"
test('Slack campaign field shows the campaign name', () => {
  const display = read('src/utils/campaign-display.js');
  const webhooks = read('src/routes/webhooks.js');
  const poller = read('src/services/smartlead-poller.js');
  const slackRoute = read('src/routes/slack.js');
  assert.match(display, /formatCampaignDisplay/,
    reversal('Slack campaign field shows the campaign name', 'shared campaign display helper is gone'));
  assert.match(webhooks, /resolveCampaignName|campaign_name/,
    reversal('Slack campaign field shows the campaign name', 'SmartLead webhook no longer resolves/stores campaign name'));
  assert.match(poller, /resolveCampaignName|campaign_name/,
    reversal('Slack campaign field shows the campaign name', 'SmartLead poller no longer resolves/stores campaign name'));
  assert.match(slackRoute, /resolveCampaignName|campaignNameFromReply/,
    reversal('Slack campaign field shows the campaign name', 'approve confirmation no longer resolves campaign name'));
});

// ── Decision: missing phone says "phone number not found" ─────────────
// "and if you cant find one say phone number not found"
test('missing phone says phone number not found on Slack', () => {
  const slackService = read('src/services/slack.js');
  const fnStart = slackService.indexOf('function phoneEnrichmentLine');
  const fnEnd = slackService.indexOf('/** Slack block-quote', fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  assert.match(
    slackService.slice(fnStart, fnEnd),
    /phone number not found/,
    reversal(
      'missing phone says phone number not found on Slack',
      'the not-found label was changed or removed'
    )
  );
});

// ── Decision: phone stays on the Slack card after approve ─────────────
// "also i dont want the persons number to disappear in slack after i approve"
test('phone stays on Slack card after approve', () => {
  const slackRoute = read('src/routes/slack.js');
  const slackService = read('src/services/slack.js');
  assert.match(slackRoute, /leadPhone:\s*reply\.lead_phone/,
    reversal('phone stays on Slack card after approve', 'sentCardPayload no longer passes lead_phone'));
  const confStart = slackService.indexOf('function buildSentConfirmationBlocks');
  const confEnd = slackService.indexOf('async function updateSentConfirmationCard');
  assert.ok(confStart >= 0 && confEnd > confStart);
  assert.match(slackService.slice(confStart, confEnd), /phoneEnrichmentLine/,
    reversal('phone stays on Slack card after approve', 'confirmation card no longer renders the phone'));
});

// ── Decision: Slack DQ button excludes follow-up nudges ───────────────
// "also add in a DQ button in slack that excludes form followup nudges"
test('Slack DQ button excludes follow-up nudges', () => {
  const slackService = read('src/services/slack.js');
  const slackRoute = read('src/routes/slack.js');
  const followUp = read('src/services/outbound-follow-up.js');
  const runner = read('src/services/follow-up-runner.js');

  assert.match(slackService, /action_id:\s*'dq_prospect'/,
    reversal('Slack DQ button excludes follow-up nudges', 'draft/alert cards no longer expose a DQ button'));
  assert.match(slackRoute, /dq_prospect/,
    reversal('Slack DQ button excludes follow-up nudges', 'Slack actions no longer handle DQ'));
  assert.match(slackRoute, /markDisqualified/,
    reversal('Slack DQ button excludes follow-up nudges', 'DQ handler no longer marks the prospect'));
  assert.match(followUp, /isReplyDisqualified|isDisqualified/,
    reversal('Slack DQ button excludes follow-up nudges', 'follow-up scheduling no longer checks DQ'));
  assert.match(runner, /disqualified/,
    reversal('Slack DQ button excludes follow-up nudges', 'follow-up runner no longer skips DQ\'d prospects'));
});

// ── Decision: Parlay DQs .io / .ai from drafting ──────────────────────
// "for parlay. please exclude all .io and .ai form drafting replies,
// DQd at client request"
test('Parlay excludes .io and .ai from drafting', () => {
  const {
    draftSkipReason,
    applyClientDraftPolicy,
    PARLAY_DQ_TLDS,
  } = require('../src/utils/client-draft-policy');
  const parlay = {
    id: '9760132c-1dd3-4e97-8f29-c5d4d01f5054',
    name: 'Parlay Tech',
  };

  assert.ok(PARLAY_DQ_TLDS.has('io'));
  assert.ok(PARLAY_DQ_TLDS.has('ai'));
  assert.ok(draftSkipReason(parlay, 'a@x.io'));
  assert.ok(draftSkipReason(parlay, 'a@x.ai'));
  assert.equal(draftSkipReason(parlay, 'a@x.com'), null,
    reversal('Parlay excludes .io and .ai from drafting', 'non-.io/.ai Parlay emails are being blocked'));

  const blocked = applyClientDraftPolicy(parlay, 'ceo@agent.ai', {
    classification: 'INTERESTED',
    draft: 'Want to hop on a call?',
    reasoning: 'yes',
  });
  assert.equal(blocked.isDraft, false,
    reversal('Parlay excludes .io and .ai from drafting', 'a .ai Parlay reply still got a draft'));
  assert.equal(blocked.draft, null);

  const webhook = read('src/routes/webhooks.js');
  const poller = read('src/services/smartlead-poller.js');
  assert.match(webhook, /applyClientDraftPolicy/,
    reversal('Parlay excludes .io and .ai from drafting', 'SmartLead webhook no longer applies the policy'));
  assert.match(poller, /applyClientDraftPolicy/,
    reversal('Parlay excludes .io and .ai from drafting', 'SmartLead poller no longer applies the policy'));
});
