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
