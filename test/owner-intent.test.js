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

// ── Decision: two calendar times + booking link on positive replies ──
// Supersedes "times-first, link only on request". Vasco stays link-free.
test('positive replies include two times and the booking link', () => {
  const { fallbackDraftText, sanitizeDraft } = require('../src/services/classifier');
  const { fallbackReattempt } = require('../src/services/follow-up-drafts');
  const { shouldIncludeBookingLink } = require('../src/utils/meeting-modality');
  const link = 'https://calendly.com/joshua-salesglidergrowth/30min';
  const vasco =
    'Carlos meets prospects IN PERSON at the dealership — never suggest Zoom or booking links.';

  const first = fallbackDraftText({
    leadName: 'Dean',
    inboundMessage: 'Sure',
    classification: 'INTERESTED',
    digestTimezone: 'America/Chicago',
    bookingLink: link,
  });
  assert.match(first, /mid-morning|afternoon/i,
    reversal('two times + booking link', 'first positive reply dropped the two times'));
  assert.ok(first.includes(link),
    reversal('two times + booking link', 'first positive reply dropped the booking link'));

  const nextDay = fallbackReattempt({
    leadName: 'Dean',
    lastOutboundMessage: first,
    step: 2,
    bookingLink: link,
    slots: [
      { label: 'Thu, Oct 9, 10:00 AM CDT' },
      { label: 'Fri, Oct 10, 2:00 PM CDT' },
    ],
  });
  assert.match(nextDay, /those times got taken/i,
    reversal('two times + booking link', 'next-day follow-up no longer says the first times were taken'));
  assert.match(nextDay, /Thu, Oct 9/);
  assert.match(nextDay, /Fri, Oct 10/);
  assert.ok(nextDay.includes(link),
    reversal('two times + booking link', 'next-day follow-up dropped the booking link'));

  assert.equal(shouldIncludeBookingLink(vasco), false);
  const inPerson = fallbackDraftText({
    leadName: 'Don',
    inboundMessage: 'Be happy to talk',
    classification: 'INTERESTED',
    digestTimezone: 'America/New_York',
    voicePrompt: vasco,
    bookingLink: link,
  });
  assert.match(inPerson, /in person|stop by/i);
  assert.doesNotMatch(inPerson, /calendly|https?:\/\//i,
    reversal('two times + booking link', 'Vasco leaked a booking link'));

  const forcedOff = sanitizeDraft(`Does Tuesday work? ${link}`, { bookingLink: link, includeBookingLink: false });
  assert.ok(!forcedOff.includes(link), 'explicit includeBookingLink=false must still strip');
});

// ── Decision: no Calendly PAT — check the connected calendar first ──
// "ok and for PAT i dont need that. is there a way grokbot can just check first quickly?"
test('open times come from the connected calendar, not a Calendly PAT', () => {
  const slots = read('src/services/scheduling-slots.js');
  const resolve = slots.slice(slots.indexOf('async function resolveVerifiedSchedulingSlots'));
  assert.match(resolve, /fetchCalendarFreeStarts/,
    reversal('check calendar first, no PAT', 'the live slot lookup no longer reads the connected calendar'));
  assert.doesNotMatch(resolve, /calendly_personal_access_token/,
    reversal('check calendar first, no PAT', 'slot lookup still requires a Calendly PAT'));
  assert.match(resolve, /2500/,
    reversal('check calendar first, no PAT', 'the poller/webhook quick path lost its short timeout'));
  assert.ok(
    resolve.includes('skipExternalFetch') && resolve.includes('fetchCalendarFreeStarts'),
    reversal('check calendar first, no PAT', 'skipExternalFetch no longer does a quick calendar check')
  );
});

// ── Decision: follow-ups after any positive reply; first step 3:30pm CT ─
// Soft positives get the cadence. First step is 3:30pm CT the inbound day
// (next day if after 2pm CT), then 24h/48h/1w after our send.
test('follow-ups after any positive reply at 3:30pm CT then 24h/48h/1w', () => {
  delete process.env.FOLLOW_UP_HOURS;
  delete process.env.FOLLOW_UP_REMINDER_HOURS;
  delete process.env.FOLLOW_UP_MAX_AGE_HOURS;

  delete require.cache[require.resolve('../src/services/outbound-follow-up')];
  delete require.cache[require.resolve('../src/services/follow-up-runner')];

  const {
    followUpCadenceHours,
    DEFAULT_CADENCE,
    DEFAULT_LATER_CADENCE_HOURS,
    usesClockFirstStep,
    firstFollowUpDueAt,
    isPositiveFollowUpClassification,
    POSITIVE_FOLLOW_UP_CLASSIFICATIONS,
  } = require('../src/services/outbound-follow-up');
  const { maxAgeHours, retireStaleFollowUps } = require('../src/services/follow-up-runner');
  const scheduleSrc = read('src/services/outbound-follow-up.js');

  assert.ok(usesClockFirstStep(),
    reversal('first follow-up at 3:30pm CT same day unless inbound after 2pm CT', 'clock first-step was disabled'));
  assert.deepStrictEqual(followUpCadenceHours(), DEFAULT_LATER_CADENCE_HOURS);
  assert.deepStrictEqual(DEFAULT_CADENCE, [24, 48, 168],
    reversal('first follow-up at 3:30pm CT same day unless inbound after 2pm CT', 'the later-step cadence has been changed'));
  assert.strictEqual(typeof firstFollowUpDueAt, 'function',
    reversal('first follow-up at 3:30pm CT same day unless inbound after 2pm CT', 'firstFollowUpDueAt was removed'));
  assert.ok(scheduleSrc.includes('SAME_DAY_CUTOFF_HOUR') && scheduleSrc.includes('FIRST_DUE_HOUR'),
    reversal('first follow-up at 3:30pm CT same day unless inbound after 2pm CT', '3:30pm / 2pm CT constants were removed'));
  assert.match(scheduleSrc, /MIN_FOLLOW_UP_HOURS\s*=\s*2/,
    reversal('first follow-up at 3:30pm CT same day unless inbound after 2pm CT', '2h minimum floor was removed'));
  assert.ok(read('src/services/booking-check.js').includes('campaignIntelligenceSaysBooked'),
    'follow-up booked check must pull campaignintelligence booking_events');
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

// ── Decision: follow-up Slack cards stay compact; only after we sent ──
test('FOLLOW_UP cards show draft + last message; only after we have sent', () => {
  const slackSrc = read('src/services/slack.js');
  const runner = read('src/services/follow-up-runner.js');
  const scheduleSrc = read('src/services/outbound-follow-up.js');
  const cron = read('src/cron.js');
  const { lastThreadTurn, buildFollowUpConversationBlocks } = require('../src/services/slack');

  assert.ok(slackSrc.includes('lastThreadTurn') && slackSrc.includes('Last message'),
    reversal('FOLLOW_UP cards show draft + last message', 'last-thread-turn helper was removed'));
  assert.ok(!/label: 'Original message'/.test(slackSrc),
    reversal('FOLLOW_UP cards show draft + last message', 'full original-message dump is back'));
  const blocks = buildFollowUpConversationBlocks({
    draft: 'Hey Pat, still interested in meeting for this?',
    inboundMessage: 'Tell me more.',
    lastOutboundMessage: 'Happy to share tickets.',
    threadMessages: [
      { role: 'them', body: 'Tell me more.' },
      { role: 'us', body: 'Happy to share tickets.' },
    ],
  });
  const text = blocks.filter((b) => b.type === 'section').map((b) => b.text.text).join('\n');
  assert.match(text, /Suggested follow-up/);
  assert.match(text, /Hey Pat, still interested/);
  assert.match(text, /Last message \(them\)/);
  assert.match(text, /Tell me more/);
  assert.doesNotMatch(text, /Original message/);
  const last = lastThreadTurn({
    inboundMessage: 'Yes please.\nOn Monday Jane wrote: old',
  });
  assert.doesNotMatch(last.body, /Jane wrote/);

  assert.ok(runner.includes('threadHasOurSend') && runner.includes('no_prior_send'),
    reversal('follow-ups only after we have replied', 'runner no longer requires a prior Slack send'));
  assert.ok(scheduleSrc.includes("sent_reply || '').trim()") || scheduleSrc.includes('sent_reply || ""'),
    reversal('follow-ups only after we have replied', 'scheduleAfterOutboundSend no longer requires sent_reply'));
  assert.ok(cron.includes('threadHasOurSend') && cron.includes('no_prior_send'),
    reversal('follow-ups only after we have replied', 'digest can still post follow-ups before we have sent'));
});

// ── Decision: no follow-up messages past 5pm CT or on the weekend ────
test('no follow-up messages past 5pm CT or on the weekend', () => {
  delete process.env.FOLLOW_UP_HOURS;
  delete process.env.FOLLOW_UP_REMINDER_HOURS;
  delete require.cache[require.resolve('../src/services/outbound-follow-up')];
  delete require.cache[require.resolve('../src/services/follow-up-runner')];

  const {
    firstFollowUpDueAt,
    buildCadenceSteps,
    inSendWindow,
    snapDueToSendWindow,
    zonedWallTimeToUtc,
    SEND_WINDOW_START_HOUR,
    SEND_WINDOW_END_HOUR,
    SEND_WINDOW_FRIDAY_END_HOUR,
  } = require('../src/services/outbound-follow-up');
  const runner = read('src/services/follow-up-runner.js');
  const cron = read('src/cron.js');
  const scheduleSrc = read('src/services/outbound-follow-up.js');

  assert.strictEqual(SEND_WINDOW_START_HOUR, 8,
    reversal('no follow-up messages past 5pm CT or on the weekend', 'send-window start is no longer 8am CT'));
  assert.strictEqual(SEND_WINDOW_END_HOUR, 17,
    reversal('no follow-up messages past 5pm CT or on the weekend', 'send-window end is no longer 5pm CT'));
  assert.strictEqual(SEND_WINDOW_FRIDAY_END_HOUR, 12,
    reversal('Friday follow-ups stop at noon CT', 'Friday cutoff is no longer noon CT'));
  assert.ok(scheduleSrc.includes('snapDueToSendWindow'),
    reversal('no follow-up messages past 5pm CT or on the weekend', 'due times are no longer snapped into the send window'));
  assert.ok(runner.includes('inSendWindow') && runner.includes('deferOffHoursFollowUps'),
    reversal('no follow-up messages past 5pm CT or on the weekend', 'the runner no longer defers/skips nights and weekends'));
  assert.ok(cron.includes('inSendWindow') && cron.includes('followUpsToPost'),
    reversal('no follow-up messages past 5pm CT or on the weekend', 'the attention digest can still post follow-up cards off-hours'));

  const friAfter2 = zonedWallTimeToUtc(2026, 1, 16, 15, 0);
  const due = firstFollowUpDueAt(friAfter2, friAfter2);
  assert.ok(inSendWindow(due),
    reversal('no follow-up messages past 5pm CT or on the weekend', 'Friday-afternoon first step landed off-hours'));
  // 2026-01-19 is the following Monday
  assert.strictEqual(due.toISOString(), zonedWallTimeToUtc(2026, 1, 19, 15, 30).toISOString(),
    reversal('no follow-up messages past 5pm CT or on the weekend', 'Friday after 2pm no longer rolls to Monday 3:30pm CT'));

  const friMorning = zonedWallTimeToUtc(2026, 1, 16, 10, 0);
  const friFirst = firstFollowUpDueAt(friMorning, friMorning);
  assert.ok(inSendWindow(friFirst),
    reversal('Friday follow-ups stop at noon CT', 'Friday-morning first step landed off-hours'));
  assert.strictEqual(friFirst.toISOString(), zonedWallTimeToUtc(2026, 1, 19, 15, 30).toISOString(),
    reversal('Friday follow-ups stop at noon CT', 'Friday 3:30pm is after noon and must roll to Monday'));
  assert.equal(inSendWindow(zonedWallTimeToUtc(2026, 1, 16, 11, 0)), true);
  assert.equal(inSendWindow(zonedWallTimeToUtc(2026, 1, 16, 12, 0)), false,
    reversal('Friday follow-ups stop at noon CT', 'Friday noon is still inside the send window'));

  const satNight = zonedWallTimeToUtc(2026, 1, 17, 21, 0);
  assert.equal(inSendWindow(satNight), false);
  assert.ok(inSendWindow(snapDueToSendWindow(satNight)),
    reversal('no follow-up messages past 5pm CT or on the weekend', 'a Saturday night due does not snap into the weekday window'));

  const steps = buildCadenceSteps(
    zonedWallTimeToUtc(2026, 1, 16, 16, 30),
    zonedWallTimeToUtc(2026, 1, 16, 15, 0)
  );
  for (const step of steps) {
    assert.ok(
      inSendWindow(step.due),
      reversal('no follow-up messages past 5pm CT or on the weekend', `cadence due ${step.due.toISOString()} is outside weekday 8am–5pm CT`)
    );
  }
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
  assert.ok(slackSrc.includes('buildFollowUpConversationBlocks') && slackSrc.includes('Last message'),
    reversal('FOLLOW_UP dedicated Slack channel', 'FOLLOW_UP layout lost the last-message block'));
  assert.ok(slackSrc.includes('updateDraftApprovalCard') && slackSrc.includes('buildDraftApprovalCard'),
    reversal('FOLLOW_UP cards show draft + last message', 'pending FOLLOW_UP cards can no longer be rewritten compact'));
  assert.ok(slackSrc.includes('draftApprovalActionsBlock'),
    reversal('FOLLOW_UP dedicated Slack channel', 'shared approval actions helper missing'));
  // Suggested send must appear on the card (not only after Slack "See more").
  const postFn = slackSrc.slice(slackSrc.indexOf('function buildDraftApprovalCard'));
  const followUpBranch = postFn.slice(postFn.indexOf('const blocks = isFollowUp'), postFn.indexOf('if (!isFollowUp && platform'));
  assert.ok(
    followUpBranch.includes('...conversation') && followUpBranch.includes('draftApprovalActionsBlock'),
    reversal('FOLLOW_UP dedicated Slack channel', 'FOLLOW_UP card lost draft or buttons'),
  );
});

// ── Decision: next-day FOLLOW_UP refreshes times + link; Meeting booked stays ──
test('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', () => {
  const drafts = read('src/services/follow-up-drafts.js');
  const runner = read('src/services/follow-up-runner.js');
  const slackSrc = read('src/services/slack.js');
  const routes = read('src/routes/slack.js');
  const booked = read('src/services/meeting-booked.js');
  const { fallbackReattempt } = require('../src/services/follow-up-drafts');
  const link = 'https://calendly.com/joshua-salesglidergrowth/30min';
  assert.ok(drafts.includes('timesTakenBump') && drafts.includes('bumpForOffer'),
    reversal('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', 'times-taken / offer-first helpers were removed'));
  assert.ok(!/return\s*\(?\s*`Hey \$\{name\}, thanks for getting back to me/.test(drafts),
    reversal('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', 'FOLLOW_UP drafts reused the first-reply opener'));
  const bump = fallbackReattempt({
    leadName: 'Scott',
    lastOutboundMessage: 'Happy to send you some Rangers tix just for the convo.',
    step: 2,
    bookingLink: link,
    slots: [
      { label: 'Tue, Oct 7, 10:00 AM CDT' },
      { label: 'Wed, Oct 8, 2:00 PM CDT' },
    ],
  });
  assert.match(bump, /those times got taken/i,
    reversal('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', 'next-day bump is not a times-taken refresh'));
  assert.ok(bump.includes(link),
    reversal('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', 'next-day bump dropped the booking link'));
  assert.ok(runner.includes('threadMessages') && runner.includes('extractThreadMessages'),
    reversal('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', 'thread history is no longer loaded for the last-message line'));
  assert.ok(runner.includes('resolveVerifiedSchedulingSlots') && runner.includes('slotOffsetForFollowUpStep'),
    reversal('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', 'FOLLOW_UP runner no longer fetches later calendar slots'));
  assert.ok(slackSrc.includes("action_id: 'meeting_booked'") || slackSrc.includes('action_id: "meeting_booked"'),
    reversal('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', 'Meeting booked button missing from Slack cards'));
  assert.ok(routes.includes('handleMeetingBooked') && routes.includes('meeting_booked'),
    reversal('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', 'Meeting booked Slack handler missing'));
  assert.ok(booked.includes("status = 'booked'") && booked.includes('cancelPendingForThread'),
    reversal('FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button', 'Meeting booked no longer records meeting + cancels cadence'));
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
    bookingLink: 'https://calendly.com/joshua-salesglidergrowth/30min',
    slots: [
      { label: 'Tue, Oct 7, 10:00 AM CDT' },
      { label: 'Wed, Oct 8, 2:00 PM CDT' },
    ],
  });
  assert.match(step3, /more business clients/i,
    reversal('FOLLOW_UP value-prop bumps', '3rd bump dropped the value-prop reframe'));
  assert.match(step3, /those times got taken/i,
    reversal('FOLLOW_UP value-prop bumps', '3rd bump is no longer a times refresh'));
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

// Same inbound must not produce two Slack cards / two outbound sends.
// Casey Buckstaff 2026-10-05: webhook inserted, poller inserted 2s later
// because alreadyPosted required slack_message_ts.
test('the same inbound cannot be carded or sent twice', () => {
  const dedupe = read('src/services/reply-dedupe.js');
  const poller = read('src/services/smartlead-poller.js');
  const heyreach = read('src/services/heyreach-poller.js');
  const webhook = read('src/routes/webhooks.js');
  const send = read('src/services/reply-send.js');
  const slack = read('src/routes/slack.js');

  assert.match(dedupe, /async function claimNewInbound/,
    reversal('stop sending the same thing twice', 'claimNewInbound was removed — webhook and poller can both insert'));
  assert.match(dedupe, /pg_advisory_xact_lock/,
    reversal('stop sending the same thing twice', 'the insert lock is gone'));
  const recorded = dedupe.slice(
    dedupe.indexOf('async function inboundAlreadyRecorded'),
    dedupe.indexOf('async function alreadyPostedToSlack')
  );
  assert.ok(recorded.includes('FROM pending_replies'),
    reversal('stop sending the same thing twice', 'inboundAlreadyRecorded no longer queries pending_replies'));
  assert.ok(!/slack_message_ts/.test(recorded),
    reversal('stop sending the same thing twice',
      'dedupe again requires slack_message_ts — that is the Casey race'));
  assert.match(dedupe, /lower\(COALESCE\(lead_email, ''\)\)/,
    reversal('stop sending the same thing twice', 'same person is no longer matched by email as well as lead_id'));

  assert.match(poller, /claimNewInbound\(/,
    reversal('stop sending the same thing twice', 'SmartLead poller inserts without the claim lock'));
  assert.match(heyreach, /claimNewInbound\(/,
    reversal('stop sending the same thing twice', 'HeyReach poller inserts without the claim lock'));
  assert.match(webhook, /claimNewInbound\(/,
    reversal('stop sending the same thing twice', 'webhook inserts without the claim lock'));

  assert.match(send, /alreadySentSameOutbound/,
    reversal('stop sending the same thing twice',
      'approve can send the same outbound twice if two cards already exist'));
  assert.match(slack, /skippedDuplicate/,
    reversal('stop sending the same thing twice',
      'Slack no longer surfaces / short-circuits a skipped duplicate send'));

  // Philip Walker: recoverUnposted and the webhook both posted the same row.
  const post = read('src/services/slack-reply-post.js');
  assert.match(dedupe, /async function claimSlackCard/,
    reversal('stop sending the same thing twice',
      'claimSlackCard was removed — recover and webhook can both post the same inbound'));
  assert.match(post, /claimSlackCard\(/,
    reversal('stop sending the same thing twice',
      'postProspectSlackCard no longer claims the row before the Slack HTTP'));
  assert.match(post, /releaseSlackCardClaim/,
    reversal('stop sending the same thing twice',
      'a failed Slack post no longer releases the claim, so the card stays stuck'));
  const slackClaim = dedupe.slice(
    dedupe.indexOf('async function claimSlackCard'),
    dedupe.indexOf('async function releaseSlackCardClaim')
  );
  assert.match(slackClaim, /FOLLOW_UP/,
    reversal('stop sending the same thing twice',
      'Slack claim lost the FOLLOW_UP sibling skip — cadence cards would be suppressed'));
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

// ── Decision: Reject also marks Not Interested in SmartLead ───────────
// "change the reject button to be reject and mark as not interested
// where it changes the classification in smartlead"
test('Reject marks the lead Not Interested in SmartLead', () => {
  const slackService = read('src/services/slack.js');
  const slackRoute = read('src/routes/slack.js');
  const sl = read('src/services/smartlead.js');
  const { categoryIdForClassification } = require('../src/services/smartlead-category');

  assert.match(slackService, /Reject & not interested/,
    reversal('Reject marks Not Interested in SmartLead', 'the Slack button no longer says reject and mark as not interested'));
  assert.match(slackRoute, /markLeadNotInterested/,
    reversal('Reject marks Not Interested in SmartLead', 'Reject no longer updates the SmartLead category'));
  assert.match(slackRoute, /classification = 'NOT_INTERESTED'/,
    reversal('Reject marks Not Interested in SmartLead', 'Reject no longer writes NOT_INTERESTED locally'));
  assert.match(sl, /\/campaigns\/\$\{cid\}\/leads\/\$\{lid\}\/category/,
    reversal('Reject marks Not Interested in SmartLead', 'updateLeadCategory lost the SmartLead category path'));
  assert.match(sl, /fetch-categories/,
    reversal('Reject marks Not Interested in SmartLead', 'category list lookup was removed'));
  assert.strictEqual(
    categoryIdForClassification(
      [{ id: 1, name: 'Interested' }, { id: 3, name: 'Not Interested' }],
      'NOT_INTERESTED'
    ),
    3,
    reversal('Reject marks Not Interested in SmartLead', 'we no longer resolve the Not Interested category by name')
  );
  assert.strictEqual(
    categoryIdForClassification([{ id: 4, name: 'Do Not Contact' }], 'NOT_INTERESTED'),
    null,
    reversal('Reject marks Not Interested in SmartLead', 'Do Not Contact is being treated as Not Interested')
  );
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

// ── Decision: Tech Evolution uses the public booking-bridge wrap ───────
// Corey Tapper's Calendly destination changed to calendly.com/ctapper/meeting.
// That update lives in booking-bridge. Replyhandler keeps emitting the
// existing public page prospects already get.
test('Tech Evolution booking link is the public booking-bridge wrap', () => {
  const {
    prospectBookingLink,
    TECHEVO_PUBLIC_BOOKING_URL,
  } = require('../src/utils/public-booking-link');
  const { fallbackDraftText, sanitizeDraft } = require('../src/services/classifier');
  const { schedulingPromptBookingLinkOnly } = require('../src/services/scheduling-slots');

  assert.equal(
    TECHEVO_PUBLIC_BOOKING_URL,
    'https://book.gosalesglider.com/techevo',
    reversal(
      'Tech Evolution booking link is the public booking-bridge wrap',
      'the public Tech Evolution URL is no longer book.gosalesglider.com/techevo'
    )
  );

  const remapped = prospectBookingLink({
    clientName: 'TechEvolution',
    bookingLink: 'https://calendly.com/ctapper/meeting',
  });
  assert.equal(
    remapped,
    TECHEVO_PUBLIC_BOOKING_URL,
    reversal(
      'Tech Evolution booking link is the public booking-bridge wrap',
      'Tech Evolution is emitting Corey’s raw Calendly instead of the public wrap'
    )
  );

  const draft = fallbackDraftText({
    leadName: 'Dan',
    inboundMessage: 'send me the link',
    includeBookingLink: true,
    clientName: 'TechEvo',
    bookingLink: 'https://calendly.com/ctapper/new-meeting',
  });
  assert.ok(
    draft.includes(TECHEVO_PUBLIC_BOOKING_URL),
    reversal(
      'Tech Evolution booking link is the public booking-bridge wrap',
      'a Tech Evolution link-request draft does not include book.gosalesglider.com/techevo'
    )
  );
  assert.ok(
    !/calendly\.com\/ctapper/i.test(draft),
    reversal(
      'Tech Evolution booking link is the public booking-bridge wrap',
      'a Tech Evolution draft still contains calendly.com/ctapper'
    )
  );

  const leaked = sanitizeDraft(
    'Sure — grab a time here: https://calendly.com/ctapper/meeting',
    { bookingLink: TECHEVO_PUBLIC_BOOKING_URL, includeBookingLink: true }
  );
  assert.ok(leaked.includes(TECHEVO_PUBLIC_BOOKING_URL));
  assert.ok(
    !/calendly\.com\/ctapper/i.test(leaked),
    reversal(
      'Tech Evolution booking link is the public booking-bridge wrap',
      'sanitizeDraft let Corey’s raw Calendly through'
    )
  );

  const prompt = schedulingPromptBookingLinkOnly({
    name: 'TechEvolution',
    booking_link: 'https://calendly.com/ctapper/meeting',
  });
  assert.match(prompt.promptBlock, /book\.gosalesglider\.com\/techevo/);
  assert.doesNotMatch(prompt.promptBlock, /calendly\.com\/ctapper/);

  assert.equal(
    prospectBookingLink({
      clientName: 'Bolder Cyber Partners',
      bookingLink: 'https://book.gosalesglider.com/bolder',
    }),
    'https://book.gosalesglider.com/bolder',
    reversal(
      'Tech Evolution booking link is the public booking-bridge wrap',
      'Bolder’s public wrap was changed'
    )
  );

  for (const file of [
    'src/services/classifier.js',
    'src/services/follow-up-drafts.js',
    'src/services/claude-reply-draft.js',
    'src/services/follow-up-runner.js',
  ]) {
    assert.ok(
      !read(file).includes('calendly.com/ctapper/meeting'),
      reversal(
        'Tech Evolution booking link is the public booking-bridge wrap',
        `${file} hardcodes Corey’s raw Calendly into outbound copy`
      )
    );
  }
});

test('portal takeover stops sends and follow-ups', () => {
  const route = read('src/routes/client-action.js');
  const claimed = read('src/services/client-claimed.js');
  const send = read('src/services/reply-send.js');
  const runner = read('src/services/follow-up-runner.js');
  const cron = read('src/cron.js');

  assert.ok(route.includes('/client-action'),
    reversal('portal takeover stops sends and follow-ups', 'POST /client-action missing'));
  assert.ok(claimed.includes('PORTAL_WEBHOOK_SECRET') && claimed.includes('x-portal-secret'),
    reversal('portal takeover stops sends and follow-ups', 'portal secret check was removed'));
  assert.ok(claimed.includes('client_has_it') && claimed.includes('booked_offline') && claimed.includes('not_a_fit'),
    reversal('portal takeover stops sends and follow-ups', 'claim statuses were removed'));
  assert.ok(send.includes('assertNotClaimedOrThrow'),
    reversal('portal takeover stops sends and follow-ups', 'send path no longer checks client_claimed'));
  assert.ok(runner.includes('isLeadClaimed') && runner.includes('client_claimed'),
    reversal('portal takeover stops sends and follow-ups', 'follow-up runner no longer skips claimed leads'));
  assert.ok(cron.includes('isLeadClaimed') && cron.includes('client_claimed'),
    reversal('portal takeover stops sends and follow-ups', 'digest can still post follow-ups for claimed leads'));
});

test('onboarding mirrors to the client portal', () => {
  const admin = read('src/routes/admin.js');
  const provision = read('src/services/portal-provision.js');
  const dash = read('src/public/index.html');
  const schema = read('schema.sql');

  assert.ok(provision.includes('handler_client_id') && provision.includes('/functions/v1/provision-client'),
    reversal('onboarding mirrors to the client portal', 'provision payload or path was removed'));
  assert.ok(provision.includes('skip_invite') && provision.includes('normalizeContactEmail'),
    reversal('onboarding mirrors to the client portal', 'empty contact_email no longer skips the invite'));
  assert.ok(provision.includes('PORTAL_SKIP_INVITE') && provision.includes('invitesDisabled'),
    reversal('onboarding mirrors to the client portal', 'invite emails are no longer gated while salesglider.ai points at the old site'));
  assert.ok(!provision.includes('calendly_personal_access_token'),
    reversal('onboarding mirrors to the client portal', 'provision payload sends the Calendly PAT the portal does not store'));
  assert.ok(admin.includes('provisionClientToPortal') && admin.includes('/admin/clients/sync-portal'),
    reversal('onboarding mirrors to the client portal', 'create/update or sync-all no longer push to the portal'));
  assert.ok(dash.includes('f_contact_email') && dash.includes('portal_login_link') && dash.includes('syncAllToPortal'),
    reversal('onboarding mirrors to the client portal', 'dashboard lost contact email, login-link copy, or sync-all'));
  assert.ok(schema.includes('contact_email'),
    reversal('onboarding mirrors to the client portal', 'clients.contact_email was dropped'));
});

// ── Decision: portal invite emails go out for new clients ─────────────
// "Tell ReplyHandler to stop sending skip_invite: true. New clients will
// now get a real invite email that lands on the new portal."
// Supersedes the DNS-gated skip_invite default from onboarding.
test('portal invite emails go out for new clients', () => {
  const provision = read('src/services/portal-provision.js');
  const dash = read('src/public/index.html');

  assert.ok(
    /PORTAL_SKIP_INVITE \?\? ['"]false['"]/.test(provision),
    reversal('portal invite emails go out for new clients', 'unset PORTAL_SKIP_INVITE no longer defaults to sending invites')
  );
  assert.ok(
    /skip_invite:\s*!contactEmail\s*\|\|\s*invitesDisabled\(\)/.test(provision),
    reversal('portal invite emails go out for new clients', 'skip_invite is no longer only empty-email or the env kill switch')
  );
  assert.ok(
    !/PORTAL_SKIP_INVITE \?\? ['"]true['"]/.test(provision),
    reversal('portal invite emails go out for new clients', 'invite default flipped back to skip')
  );
  assert.ok(
    dash.includes('gets an invite email') && dash.includes('PORTAL_SKIP_INVITE=true'),
    reversal('portal invite emails go out for new clients', 'dashboard no longer says new clients get an invite')
  );
});

// ── Decision: portal fills itself from ReplyHandler ───────────────────
// "Backfill provision-client for every existing active client."
// "On every positive reply, POST new-positive-reply."
// "when a client's keys change in ReplyHandler, re-send provision-client"
test('portal fills itself from ReplyHandler', () => {
  const provision = read('src/services/portal-provision.js');
  const positive = read('src/services/portal-positive-reply.js');
  const slackPost = read('src/services/slack-reply-post.js');
  const admin = read('src/routes/admin.js');
  const schema = read('schema.sql');

  assert.ok(provision.includes('allo_api_key'),
    reversal('portal fills itself from ReplyHandler', 'provision no longer sends allo_api_key'));
  assert.ok(admin.includes('active IS DISTINCT FROM false') && admin.includes('sync-portal'),
    reversal('portal fills itself from ReplyHandler', 'sync-portal no longer backfills active clients only'));
  assert.ok(admin.includes('provisionClientToPortal') && admin.includes('allo_api_key'),
    reversal('portal fills itself from ReplyHandler', 'create/update no longer re-provisions when keys change'));
  assert.ok(positive.includes('/functions/v1/new-positive-reply'),
    reversal('portal fills itself from ReplyHandler', 'new-positive-reply path was removed'));
  assert.ok(positive.includes("'email'") && positive.includes("'linkedin'") && positive.includes("'call'"),
    reversal('portal fills itself from ReplyHandler', 'channel mapping lost email/linkedin/call'));
  assert.ok(slackPost.includes('notifyPortalPositiveReply'),
    reversal('portal fills itself from ReplyHandler', 'Slack-carded positives no longer notify the portal'));
  assert.ok(positive.includes('FOLLOW_UP') || /not_positive/.test(positive),
    reversal('portal fills itself from ReplyHandler', 'FOLLOW_UP bumps can now alert the client as a new reply'));
  assert.ok(schema.includes('allo_api_key'),
    reversal('portal fills itself from ReplyHandler', 'clients.allo_api_key was dropped'));
});

// ── Decision: portal create works without contact_email ───────────────
// "The portal no longer requires contact_email on first create.
// Clients provisioned without an email get no invite until one is sent;
// re-send provision-client with contact_email when it is set."
test('portal create works without contact_email; invite waits for one', () => {
  const admin = read('src/routes/admin.js');
  const provision = read('src/services/portal-provision.js');
  const createFn = admin.slice(admin.indexOf("router.post('/admin/clients'"));
  const createBody = createFn.slice(0, admin.indexOf("router.get('/admin/clients'"));
  const patchFn = admin.slice(admin.indexOf("router.patch('/admin/clients/:clientId'"));

  assert.ok(!/if\s*\(\s*!contactEmail/.test(createBody) && !/contact_email.{0,40}required/i.test(createBody),
    reversal('portal create works without contact_email', 'create now rejects a client with no portal email'));
  assert.ok(/skip_invite:\s*!contactEmail\s*\|\|\s*invitesDisabled\(\)/.test(provision),
    reversal('portal create works without contact_email', 'empty email no longer skips the invite'));
  assert.ok(createBody.includes('provisionClientToPortal') && patchFn.includes('provisionClientToPortal'),
    reversal('portal create works without contact_email', 'setting contact_email later no longer re-sends provision-client'));
});

// ── Decision: portal contact email is the always-notify address ───────
// "the contact email is always the always notify email for positive replies"
test('portal contact email is the always-notify address', () => {
  const provision = read('src/services/portal-provision.js');
  const admin = read('src/routes/admin.js');
  const dash = read('src/public/index.html');

  assert.ok(provision.includes('portalContactEmail') && provision.includes('alwaysCcEmails'),
    reversal('portal contact email is the always-notify address', 'provision no longer derives login from Always-notify'));
  assert.ok(/contactEmail = portalContactEmail/.test(provision) || /portalContactEmail\(client\)/.test(provision),
    reversal('portal contact email is the always-notify address', 'buildProvisionPayload still reads the leftover contact_email column'));
  assert.ok(admin.includes('portalContactEmail'),
    reversal('portal contact email is the always-notify address', 'create/update/sync no longer keep contact_email on Always-notify'));
  assert.ok(dash.includes('syncPortalEmailFromAlwaysNotify') && dash.includes('Always notify'),
    reversal('portal contact email is the always-notify address', 'dashboard lets portal email drift from Always-notify'));
});

// ── Decision: client notify includes the full live thread ─────────────
test('client notify email includes the full live thread', () => {
  const send = read('src/services/reply-send.js');
  const notify = read('src/services/client-notify-email.js');
  assert.match(
    send,
    /getThreadHistory/,
    reversal(
      'client notify email includes the full live thread',
      'reply-send no longer refetches SmartLead history before the client email'
    )
  );
  assert.match(
    send,
    /resolveClientNotifyThread/,
    reversal(
      'client notify email includes the full live thread',
      'FOLLOW_UP notifies can go out on the inbound-time snapshot again'
    )
  );
  assert.match(
    send,
    /extraMessages/,
    reversal(
      'client notify email includes the full live thread',
      'prior approved sends are no longer merged into the client email'
    )
  );
  assert.doesNotMatch(
    notify,
    /slice\(\s*-12\s*\)/,
    reversal(
      'client notify email includes the full live thread',
      'the client email is capped at the last 12 messages again'
    )
  );
  assert.match(
    notify,
    /<style\[/,
    reversal(
      'client notify email includes the full live thread',
      'style/CSS junk is no longer stripped from notify bodies'
    )
  );
});

// ── Decision: weekly Friday voice learning ────────────────────────────
// "set up a routine to automatically go in every friday, learn from the weeks
// last replies, and continuously shape yourself to my voice, while also
// acknowledging client specific information. this should be from approved
// replies from slack as well as edited ones or manual replies from smartlead
// and heyreach"
test('weekly Friday voice learning from approved, edited and manual replies', () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unit-test';
  const cronSrc = read('src/cron.js');
  const learning = read('src/services/weekly-voice-learning.js');
  const profile = read('src/services/voice-profile.js');
  const classifier = read('src/services/classifier.js');
  const claude = read('src/services/claude-reply-draft.js');
  const slackRoute = read('src/routes/slack.js');
  const approved = read('src/services/approved-reply-learning.js');
  const { VOICE_LEARNING_CRON } = require('../src/cron');

  // Runs on Fridays, on a schedule, not by hand.
  assert.ok(cronSrc.includes('runWeeklyVoiceLearning'),
    reversal('weekly Friday voice learning', 'cron no longer runs the weekly voice learning job'));
  assert.match(VOICE_LEARNING_CRON, /\s5$/,
    reversal('weekly Friday voice learning', `default schedule is no longer Friday (got "${VOICE_LEARNING_CRON}")`));

  // All four sources: Slack approved, Slack edited, manual SmartLead, manual HeyReach.
  for (const source of ['slack_approved', 'slack_edited', 'manual_smartlead', 'manual_heyreach']) {
    assert.ok(learning.includes(`'${source}'`),
      reversal('weekly Friday voice learning', `the ${source} source was dropped`));
  }
  assert.ok(learning.includes('smartleadManualPairs') && learning.includes('heyreachManualPairs'),
    reversal('weekly Friday voice learning', 'manual SmartLead / HeyReach replies are no longer collected'));
  assert.ok(slackRoute.includes('original_draft'),
    reversal('weekly Friday voice learning', 'Slack edits no longer keep the original AI draft — the edit diff is the strongest voice signal'));
  assert.ok(approved.includes("'heyreach'"),
    reversal('weekly Friday voice learning', 'HeyReach approvals are no longer learned in realtime'));

  // Shapes the voice: profiles are synthesized and injected into both draft paths.
  assert.ok(learning.includes('synthesizeProfile') && learning.includes('storeProfile'),
    reversal('weekly Friday voice learning', 'voice profiles are no longer synthesized'));
  assert.ok(profile.includes('client_notes') && learning.includes('client_notes'),
    reversal('weekly Friday voice learning', 'client-specific notes were removed from the profile'));
  assert.ok(classifier.includes('loadLearnedVoiceBlock') && classifier.includes('learnedVoiceBlock'),
    reversal('weekly Friday voice learning', 'Gemini drafts no longer read the learned voice'));
  assert.ok(claude.includes('learnedVoiceBlock'),
    reversal('weekly Friday voice learning', 'Claude drafts no longer read the learned voice'));

  // Bulk job: Gemini only. Claude is never used here (Aug 2026 burn).
  assert.ok(!/anthropic/i.test(learning),
    reversal('Claude never runs on bulk backfill', 'weekly voice learning touches Anthropic'));
  // Never learns FOLLOW_UP bumps or placeholder inbounds.
  assert.ok(learning.includes("'FOLLOW_UP'") && learning.includes('isFollowUpPlaceholder'),
    reversal('weekly Friday voice learning', 'FOLLOW_UP / placeholder exclusion was removed from learning'));
});

// ── Decision: every week's voice profile is kept and revertable ──────
// "make sure you save the previous week's style so that if your updates suck
// i can revert back indefinitely" … "no have it auto update but if i come back
// in here i should be able to easily revert"
test('voice profile history is permanent, auto-updates continue, any earlier week can be restored', () => {
  const learning = read('src/services/weekly-voice-learning.js');
  const profile = read('src/services/voice-profile.js');
  const route = read('src/routes/voice-learning.js');
  const migration = read('migrations/027_voice_profiles.sql');
  const schema = read('schema.sql');

  // Each run appends; it never overwrites a previous week's row.
  const storeFn = learning.slice(learning.indexOf('async function storeProfile'));
  const storeBody = storeFn.slice(0, storeFn.indexOf('\n}\n'));
  assert.ok(/INSERT INTO voice_profiles/.test(storeBody) && !/ON CONFLICT/i.test(storeBody),
    reversal('voice history is permanent', 'storeProfile upserts/overwrites instead of appending a new version'));

  // Nothing in the app deletes profiles, and the database refuses deletes too.
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(`${dir}/${d.name}`) : d.name.endsWith('.js') ? [`${dir}/${d.name}`] : []);
  for (const file of [...walk('src'), ...walk('scripts')]) {
    assert.ok(!/DELETE\s+FROM\s+voice_profiles/i.test(read(file)),
      reversal('voice history is permanent', `${file} deletes voice_profiles rows`));
  }
  for (const [name, sql] of [['migrations/027_voice_profiles.sql', migration], ['schema.sql', schema]]) {
    assert.ok(sql.includes('prevent_voice_profiles_delete') && /BEFORE DELETE ON voice_profiles/i.test(sql),
      reversal('voice history is permanent', `${name} no longer blocks DELETE on voice_profiles`));
    assert.ok(/BEFORE TRUNCATE ON voice_profiles/i.test(sql),
      reversal('voice history is permanent', `${name} no longer blocks TRUNCATE on voice_profiles`));
    assert.ok(/restored_from/.test(sql),
      reversal('voice history is permanent', `${name} lost the restored_from column — reverts would be untraceable`));
    assert.ok(!/UNIQUE INDEX[^;]*week_ending/i.test(sql),
      reversal('voice history is permanent', `${name} has a per-week unique index, so a re-run would overwrite that week`));
  }

  // Revert = copy an earlier version forward as the new current one. Drafts
  // always read the newest row, so weekly auto-updates keep applying — there
  // is no pin / freeze that Josh would have to remember to undo.
  assert.ok(profile.includes('async function restoreProfile') && profile.includes('async function restorePreviousProfile'),
    reversal('voice history is permanent', 'restore / revert helpers were removed from voice-profile.js'));
  const restoreBody = profile.slice(profile.indexOf('async function restoreProfile'), profile.indexOf('async function restorePreviousProfile'));
  assert.ok(/INSERT INTO voice_profiles/.test(restoreBody) && !/UPDATE voice_profiles/i.test(restoreBody),
    reversal('voice updates stay automatic', 'revert no longer appends a new version — a pin/freeze would stop weekly updates from applying'));
  assert.ok(!/pinned_at|function (pin|unpin)Profile/i.test(profile + learning + route),
    reversal('voice updates stay automatic', 'a pin/freeze concept crept back in; Josh wants auto-update with easy revert, not a freeze'));
  assert.ok(/ORDER BY created_at DESC\s+LIMIT 1/.test(profile.slice(profile.indexOf('async function activeProfileRow'))),
    reversal('voice updates stay automatic', 'drafts no longer read the newest stored version'));
  assert.ok(route.includes('/admin/voice-learning/revert') && route.includes('/admin/voice-learning/history'),
    reversal('voice history is permanent', 'the revert / history admin endpoints were removed'));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'voice-profile-revert.js')),
    reversal('voice history is permanent', 'scripts/voice-profile-revert.js was removed'));
});
