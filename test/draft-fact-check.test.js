const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  FACT_GROUNDING_RULES,
  findUnsupportedClaims,
  stripUnsupportedClaims,
  factSourceText,
  enforceDraftGrounding,
  applyFactCheckToPolicy,
} = require('../src/utils/draft-fact-check');
const { buildDraftApprovalCard } = require('../src/services/slack');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Recorded Oct 13 2026 case (anonymized). Client brand is a cyber firm
 * named for Boulder. Prospect asked where the sender is based. The model
 * answered Denver. Field names / counts only — no live lead names.
 */
const RECORDED = {
  leadName: 'Jordan P.',
  clientName: 'Bolder Cyber Partners',
  inboundMessage: [
    'Where are you guys based out of? What services do you provide?',
    '',
    'Jordan P.',
    'IT Manager',
    '455 W. 1100 N.',
    'North Salt Lake, UT 84054',
  ].join('\n'),
  threadContext: [
    {
      type: 'SENT',
      email_body: [
        'Hi there Jordan,',
        '',
        "I've got a pair of Jazz tickets yours if you want them.",
        '',
        "We're a cybersecurity firm that acts as your outsourced security leader, running the program so you don't need a full-time hire.",
        '',
        'We grew this kind of program from $0 to $900K in engaged work in 2.5 years for PE-backed companies.',
        '',
        'Tickets are yours just for checking it out... want them?',
        '',
        'Kofi Nguyen',
        'Bolder Cyber Partners',
      ].join('\n'),
    },
  ],
  schedulingPromptBlock: [
    'VERIFIED OPEN START TIMES (use exactly these two in the draft wording; do not invent other times):',
    'Wednesday 10:00 AM CDT',
    'Thursday 10:00 AM CDT',
    'https://book.gosalesglider.com/bolder',
  ].join('\n'),
  hallucinatedDraft: [
    'Hey Jordan,',
    '',
    "Thanks for getting back to me! We're based out of Denver, CO, but work with clients all over the US. We provide outsourced cybersecurity program management, essentially acting as your security leader without the need for a full-time hire.",
    '',
    'Would you be open to a quick chat tomorrow, Wednesday, at 10 AM CDT or Thursday at 10 AM CDT? Or grab a time here if easier: https://book.gosalesglider.com/bolder',
  ].join('\n'),
};

function recordedSource() {
  return factSourceText({
    inboundMessage: RECORDED.inboundMessage,
    threadContext: RECORDED.threadContext,
    leadName: RECORDED.leadName,
    clientName: RECORDED.clientName,
    schedulingPromptBlock: RECORDED.schedulingPromptBlock,
  });
}

test('recorded Oct 13 case: Denver is not in the source context', () => {
  const source = recordedSource();
  assert.equal((source.match(/\bDenver\b/gi) || []).length, 0);
  assert.equal((source.match(/\bBoulder\b/gi) || []).length, 0);
  assert.match(source, /Bolder Cyber Partners/);
  assert.match(source, /Where are you guys based out of/);
  assert.match(source, /Jazz tickets/);
  assert.match(source, /North Salt Lake/);
});

test('recorded Oct 13 case: hallucinated draft must not keep Denver', async () => {
  const source = recordedSource();
  const unsupported = findUnsupportedClaims(RECORDED.hallucinatedDraft, source);
  const labels = unsupported.map((c) => c.value);
  assert.ok(labels.some((v) => /denver/i.test(v)), `expected Denver in ${labels.join(', ')}`);
  assert.ok(labels.some((v) => v === 'CO' || /colorado/i.test(v)), `expected CO in ${labels.join(', ')}`);

  const grounded = await enforceDraftGrounding({
    draft: RECORDED.hallucinatedDraft,
    sourceText: source,
    regenerate: async () => [
      'Hey Jordan,',
      '',
      "Thanks for getting back to me! We're based out of Denver, CO.",
      '',
      'Would you be open to a quick chat Wednesday at 10 AM CDT or Thursday at 10 AM CDT?',
    ].join('\n'),
  });

  assert.doesNotMatch(grounded.text, /\bDenver\b/i);
  assert.doesNotMatch(grounded.text, /\bCO\b/);
  assert.equal(grounded.regenerated, true);
  assert.equal(grounded.stripped, true);
  assert.match(grounded.text, /Wednesday/);
  assert.match(grounded.text, /Jordan/);
});

test('recorded case: clean regen without Denver is accepted', async () => {
  const source = recordedSource();
  const grounded = await enforceDraftGrounding({
    draft: RECORDED.hallucinatedDraft,
    sourceText: source,
    regenerate: async () => [
      'Hey Jordan,',
      '',
      "Thanks for getting back to me — I don't want to guess on HQ over email. Happy to cover where we sit and the program on a short call.",
      '',
      'Would Wednesday at 10 AM CDT or Thursday at 10 AM CDT work?',
    ].join('\n'),
  });
  assert.doesNotMatch(grounded.text, /\bDenver\b/i);
  assert.equal(grounded.needsReview, false);
  assert.equal(grounded.stripped, false);
  assert.equal(grounded.regenerated, true);
});

test('ungrounded leftover after strip flags needs review', async () => {
  const grounded = await enforceDraftGrounding({
    draft: "We're based out of Denver, CO.",
    sourceText: 'Prospect asked where you are based. No city is given.',
    regenerate: async () => "We're based out of Denver.",
  });
  assert.equal(grounded.needsReview, true);
  assert.ok(grounded.claims.some((c) => /denver/i.test(c.value)));
});

test('supported locations and numbers are left alone', () => {
  const draft = 'Hey Jordan — those Jazz tickets are still yours. The $900K program we mentioned is the same one. North Salt Lake works for a call Wednesday at 10 AM CDT.';
  const unsupported = findUnsupportedClaims(draft, recordedSource());
  assert.deepEqual(unsupported, []);
});

test('stripUnsupportedClaims drops only the invented sentence', () => {
  const claims = findUnsupportedClaims(RECORDED.hallucinatedDraft, recordedSource());
  const stripped = stripUnsupportedClaims(RECORDED.hallucinatedDraft, claims);
  assert.doesNotMatch(stripped.text, /\bDenver\b/i);
  assert.match(stripped.text, /Hey Jordan/);
  assert.match(stripped.text, /Wednesday/);
  assert.ok(stripped.removed.length >= 1);
});

test('applyFactCheckToPolicy flags Slack-bound drafts as needs review', () => {
  const policy = {
    isDraft: true,
    draft: "We're based out of Denver, CO.",
    status: 'pending',
    reasoning: 'Classified as QUESTION; draft generated.',
  };
  const out = applyFactCheckToPolicy(policy, {
    text: policy.draft,
    needsReview: true,
    claims: [{ value: 'Denver', kind: 'city' }],
  });
  assert.equal(out.status, 'flagged');
  assert.equal(out.needsReview, true);
  assert.match(out.reasoning, /needs review/);
  assert.match(out.reasoning, /Denver/);
});

test('Slack draft card prints needs review when flagged', () => {
  const card = buildDraftApprovalCard({
    replyId: '1',
    leadName: 'Jordan P.',
    platform: 'smartlead',
    classification: 'QUESTION',
    draft: 'Hey Jordan',
    inboundMessage: 'Where are you based?',
    reasoning: 'Classified as QUESTION; draft generated. needs review — unsupported claims: Denver',
    needsReview: true,
  });
  const blob = JSON.stringify(card.blocks);
  assert.match(blob, /needs review/);
  assert.match(blob, /Do not send until checked/);
});

test('Claude and Gemini prompts include the grounding rules', () => {
  const claude = read('src/services/claude-reply-draft.js');
  const classifier = read('src/services/classifier.js');
  assert.match(claude, /FACT_GROUNDING_RULES/);
  assert.match(classifier, /FACT_GROUNDING_RULES/);
  assert.match(FACT_GROUNDING_RULES, /Never state or guess a location/);
  assert.match(classifier, /enforceDraftGrounding/);
  assert.match(read('src/routes/webhooks.js'), /applyFactCheckToPolicy/);
  assert.match(read('src/services/smartlead-poller.js'), /applyFactCheckToPolicy/);
  assert.match(read('src/services/heyreach-poller.js'), /applyFactCheckToPolicy/);
});
