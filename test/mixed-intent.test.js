const test = require('node:test');
const assert = require('node:assert/strict');

const {
  looksLikeHoldOff,
  looksLikeConversationContinue,
  looksLikeMixedIntent,
  promoteMixedIntent,
} = require('../src/utils/mixed-intent');
const { applySmartleadCategory, classifyFromSmartlead } = require('../src/services/smartlead-category');
const { looksLikeNotInterested } = require('../src/utils/smartlead-webhook-helpers');
const {
  slackChannelSuppressionReason,
  SLACK_CHANNEL_CLASSIFICATIONS,
} = require('../src/utils/slack-channel-policy');

const HOLD_OFF_THEN_QUESTION = [
  "Let's hold off for now. What's your typical timeline to get started?",
  "Let's hold off for now — can you send the pricing sheet though?",
  "Let's hold off for now. I'm curious how this works with our existing vendor.",
  'Not right now, but how does the onboarding work?',
  'Not interested at the moment. What would a first call cover?',
];

const CLEAR_DECLINE = [
  "Let's hold off for now. Thanks.",
  'Not interested. Please do not email again.',
  'We are not interested.',
];

const CLEAR_QUESTION = [
  "What's your typical timeline to get started?",
  'Can you send the pricing sheet?',
];

test('synthetic mixed replies are hold-off plus a later question', () => {
  for (const body of HOLD_OFF_THEN_QUESTION) {
    assert.equal(looksLikeHoldOff(body) || /not interested/i.test(body), true, body);
    assert.equal(looksLikeConversationContinue(body), true, body);
    assert.equal(looksLikeMixedIntent(body), true, body);
  }
});

test('a bare hold-off or a bare question is not mixed', () => {
  for (const body of CLEAR_DECLINE) {
    assert.equal(looksLikeMixedIntent(body), false, body);
  }
  for (const body of CLEAR_QUESTION) {
    assert.equal(looksLikeMixedIntent(body), false, body);
  }
});

test('mixed bodies promote drop labels to QUESTION and keep positives', () => {
  const body = HOLD_OFF_THEN_QUESTION[0];
  assert.equal(promoteMixedIntent('NOT_INTERESTED', body), 'QUESTION');
  assert.equal(promoteMixedIntent('OTHER', body), 'QUESTION');
  assert.equal(promoteMixedIntent('INTERESTED', body), 'INTERESTED');
  assert.equal(promoteMixedIntent('QUESTION', body), 'QUESTION');
  assert.equal(promoteMixedIntent('NOT_INTERESTED', CLEAR_DECLINE[2]), 'NOT_INTERESTED');
});

test('SmartLead Not Interested does not win on a mixed full body', () => {
  const body = HOLD_OFF_THEN_QUESTION[1];
  const sl = classifyFromSmartlead({ lead_category: 'Not Interested' });
  assert.equal(sl.classification, 'NOT_INTERESTED');

  const applied = applySmartleadCategory({
    slCategory: sl,
    classification: 'NOT_INTERESTED',
    inboundMessage: body,
    reasoning: 'model said no',
  });
  assert.equal(applied.classification, 'QUESTION');
  assert.equal(applied.source, 'body_mixed_intent');
  assert.match(applied.reasoning, /mixed\/conditional/i);

  const geminiPositive = applySmartleadCategory({
    slCategory: sl,
    classification: 'QUESTION',
    inboundMessage: body,
    reasoning: 'model asked a question',
  });
  assert.equal(geminiPositive.classification, 'QUESTION');
  assert.equal(slackChannelSuppressionReason({
    classification: geminiPositive.classification,
    inboundMessage: body,
  }), null);
  assert.ok(SLACK_CHANNEL_CLASSIFICATIONS.has(geminiPositive.classification));
});

test('clear declines still follow SmartLead Not Interested', () => {
  const body = 'We are not interested.';
  const sl = classifyFromSmartlead({ category: 'Not Interested' });
  const applied = applySmartleadCategory({
    slCategory: sl,
    classification: 'OTHER',
    inboundMessage: body,
    reasoning: 'other',
  });
  assert.equal(applied.classification, 'NOT_INTERESTED');
  assert.equal(applied.source, 'smartlead_category');
  assert.equal(
    slackChannelSuppressionReason({ classification: applied.classification, inboundMessage: body }),
    'not_interested',
  );
});

test('SmartLead Not Interested cannot drop a body already classified positive', () => {
  const body = 'Sure, send me times next week.';
  const sl = classifyFromSmartlead({ lead_category: 'Not Interested' });
  const applied = applySmartleadCategory({
    slCategory: sl,
    classification: 'INTERESTED',
    inboundMessage: body,
    reasoning: 'body is interested',
  });
  assert.equal(applied.classification, 'INTERESTED');
  assert.equal(applied.source, 'body_over_smartlead');
});

test('looksLikeNotInterested still matches a clear no, mixed is separate', () => {
  assert.equal(looksLikeNotInterested('We are not interested.'), true);
  assert.equal(looksLikeMixedIntent('We are not interested.'), false);
  assert.equal(
    looksLikeMixedIntent('Not interested right now. Can you send a one-pager?'),
    true,
  );
});
