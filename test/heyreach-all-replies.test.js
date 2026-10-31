/**
 * Josh, Oct 30 2026: "I'd like to see any heyreach reply from now on. For all
 * clients." Every inbound LinkedIn (HeyReach) reply posts a card in that
 * client's reply channel. Neutral replies, "why I accepted your connection",
 * job seekers, not interested, wrong person, cold pitches: all of them.
 * Email behavior is unchanged (interested-only, see DECISIONS.md).
 *
 * Root cause of the trigger case: three LinkedIn replies classified OTHER were
 * recorded as suppressed rows (`not_interested_channel`) and never posted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const {
  slackChannelSuppressionReason,
  shouldPostToSlackChannel,
  heyreachPostsAllReplies,
} = require('../src/utils/slack-channel-policy');
const { postStoredHeyreachApprovalCard } = require('../src/services/heyreach-approval-card');
const { heyreachFallbackThreadKey } = require('../src/routes/webhooks');

const LABELS = [
  'INTERESTED', 'MEETING_PROPOSED', 'QUESTION', 'OTHER', 'OBJECTION', 'NOT_INTERESTED',
  'REMOVE_ME', 'OOO', 'AUTOMATED_NOTICE', 'WRONG_PERSON', 'COMPETITOR', 'FOLLOW_UP', '', undefined,
];

const NEUTRAL = [
  'I generally accept all invites that look legitimate and could potentially be useful.',
  'What made you send the request? Fair question.',
  "Nice connecting. I'm looking for a new role, are you hiring?",
  'Thanks for connecting.',
];

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
  }
}

test('every HeyReach reply passes the Slack gate, whatever its label or text', () => {
  assert.equal(heyreachPostsAllReplies(), true);
  for (const classification of LABELS) {
    for (const inboundMessage of NEUTRAL) {
      assert.equal(
        slackChannelSuppressionReason({ classification, inboundMessage, platform: 'heyreach' }),
        null,
        `${classification}: ${inboundMessage.slice(0, 30)}`,
      );
      assert.equal(shouldPostToSlackChannel({ classification, inboundMessage, platform: 'heyreach' }), true);
    }
  }
});

test('cold-inbound pitch filter, OOO text and unsubscribe text do not hide a LinkedIn reply', () => {
  const texts = [
    'I am out of office until Monday.',
    'Please remove me from your list.',
    'Please contact Pat Example instead, I no longer handle this.',
  ];
  for (const inboundMessage of texts) {
    assert.equal(slackChannelSuppressionReason({
      classification: 'OTHER', inboundMessage, platform: 'HeyReach',
      isColdInbound: true, pitchToUsProb: 0.99,
    }), null, inboundMessage);
  }
});

test('email replies keep the interested-only gate (unchanged)', () => {
  const body = 'Sounds good, tell me more.';
  const expected = {
    OTHER: 'not_interested_channel',
    NOT_INTERESTED: 'not_interested',
    WRONG_PERSON: 'wrong_person',
    OOO: 'ooo',
    INTERESTED: null,
  };
  for (const platform of ['smartlead', undefined]) {
    for (const [classification, reason] of Object.entries(expected)) {
      assert.equal(
        slackChannelSuppressionReason({ classification, inboundMessage: body, platform }),
        reason,
        `${platform}/${classification}`,
      );
    }
  }
  assert.equal(slackChannelSuppressionReason({
    classification: 'INTERESTED', inboundMessage: body, platform: 'smartlead',
    isColdInbound: true, pitchToUsProb: 0.95,
  }), 'pitch_inbound');
});

test('HEYREACH_POST_ALL_REPLIES=off restores the old gate for LinkedIn', () => {
  withEnv('HEYREACH_POST_ALL_REPLIES', 'off', () => {
    assert.equal(
      slackChannelSuppressionReason({ classification: 'OTHER', inboundMessage: 'Thanks', platform: 'heyreach' }),
      'not_interested_channel',
    );
  });
});

test('webhook and poller hand the heyreach platform to the gate, so nothing is recorded as suppressed', () => {
  const webhook = read('src/routes/webhooks.js');
  const start = webhook.indexOf("router.post('/webhook/heyreach/:clientId'");
  const end = webhook.indexOf('Campaignintelligence booking page', start);
  const handler = webhook.slice(start, end);
  assert.match(handler, /slackChannelSuppressionReason\(\{[^}]*platform: 'heyreach'/s);

  const poller = read('src/services/heyreach-poller.js');
  assert.match(poller, /slackChannelSuppressionReason\(\{[^}]*platform: 'heyreach'/s);
});

test('HeyReach webhook no longer drops a reply for a missing key, missing ids, API blip, or classifier error', () => {
  const webhook = read('src/routes/webhooks.js');
  const start = webhook.indexOf("router.post('/webhook/heyreach/:clientId'");
  const end = webhook.indexOf('Campaignintelligence booking page', start);
  const handler = webhook.slice(start, end);
  for (const reason of ['no_heyreach_api_key', 'missing_campaign_id', 'missing_thread_ids', 'heyreach_api_error']) {
    assert.doesNotMatch(handler, new RegExp(`reason: '${reason}'`), reason);
  }
  // A classifier throw falls back to OTHER and still posts. No bare `return` after the error line.
  const classifierCatch = handler.slice(handler.indexOf("[Classifier] Failed for HeyReach reply"));
  assert.doesNotMatch(classifierCatch.slice(0, 500), /\breturn;/);
  assert.doesNotMatch(classifierCatch.slice(0, 500), /postError/);
  // The one remaining skip leaves an audit row: another client's campaign on this webhook URL.
  assert.match(handler, /campaign_not_in_client_workspace/);
  assert.match(handler, /recordSuppressedReply\(\{[^}]*campaign_not_in_client_workspace/s);
});

test('exact-duplicate guard is still in place for HeyReach', () => {
  const webhook = read('src/routes/webhooks.js');
  assert.match(webhook, /isHeyreachDuplicate\(dedupeKey\)/);
  assert.match(webhook, /heyreachDuplicateInDb\(/);
  const poller = read('src/services/heyreach-poller.js');
  assert.match(poller, /alreadyPostedToSlack\(/);
  assert.match(poller, /claimNewInbound\(/);
});

test('derived thread key is stable per person and text, and differs for a different reply', () => {
  const a = heyreachFallbackThreadKey({
    linkedinUrl: 'https://www.linkedin.com/in/pat-example/', inboundMessage: 'Thanks for connecting.',
  });
  const again = heyreachFallbackThreadKey({
    linkedinUrl: 'https://www.linkedin.com/in/pat-example/', inboundMessage: 'Thanks for connecting.',
  });
  const other = heyreachFallbackThreadKey({
    linkedinUrl: 'https://www.linkedin.com/in/pat-example/', inboundMessage: 'Actually, tell me more.',
  });
  assert.match(a, /^hr-derived:[0-9a-f]{16}$/);
  assert.equal(a, again);
  assert.notEqual(a, other);
  assert.match(heyreachFallbackThreadKey({}), /^hr-derived:/);
});

test('recovery retries any unposted LinkedIn row, not only the three positive labels', () => {
  const dedupe = read('src/services/reply-dedupe.js');
  const sql = dedupe.slice(dedupe.indexOf('async function recoverUnpostedSlackCards'));
  assert.match(sql, /pr\.platform = 'heyreach' AND COALESCE\(pr\.classification, ''\) <> 'FOLLOW_UP'/);
  assert.match(dedupe, /shouldPostToSlackChannel\(\{[^}]*platform: reply\.platform/s);
});

function storedRow(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    client_id: 'client-1',
    platform: 'heyreach',
    campaign_id: '321',
    campaign_name: 'LinkedIn outreach',
    lead_id: 'lead-1',
    lead_name: 'Pat Example',
    linkedin_url: 'https://www.linkedin.com/in/pat-example/',
    inbound_message: 'I generally accept all invites that look legitimate.',
    classification: 'OTHER',
    thread_context: { messages: [{ role: 'prospect', message: 'x' }], heyreach: { conversationId: 'c1' } },
    status: 'suppressed',
    slack_message_ts: null,
    slack_bot_token: 'xoxb-test',
    slack_channel_id: 'C123',
    active: true,
    created_at: '2026-10-29T19:59:00.000Z',
    ...overrides,
  };
}

function fakeQuery(row, captured = {}) {
  return async (sql, params) => {
    if (/JOIN clients/.test(sql)) return { rows: [row] };
    if (/slack_message_ts IS NOT NULL/.test(sql)) return { rows: [] };
    if (/UPDATE pending_replies/.test(sql)) {
      captured.params = params;
      return { rows: [{ ...row, classification: params[0], draft_reply: params[1], status: params[3] }] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
}

test('approval-card endpoint accepts a neutral classification and posts an alert card with no draft', async () => {
  for (const classification of ['OTHER', 'NOT_INTERESTED', 'WRONG_PERSON', 'JOB_SEEKER']) {
    const captured = {};
    let call = null;
    const result = await postStoredHeyreachApprovalCard({
      replyId: storedRow().id,
      classification,
      query: fakeQuery(storedRow(), captured),
      postFn: async (args) => { call = args; return { ts: '1.2' }; },
    });
    assert.equal(result.posted, true, classification);
    assert.equal(call.isDraft, false);
    assert.equal(call.card.draft, null);
    assert.equal(call.card.classification, classification);
    assert.equal(captured.params[1], null);
    assert.equal(captured.params[3], 'alert_only');
  }
});

test('approval-card endpoint with no label and no draft re-posts the stored label as an alert', async () => {
  let call = null;
  const result = await postStoredHeyreachApprovalCard({
    replyId: storedRow().id,
    query: fakeQuery(storedRow({ classification: 'OTHER' })),
    postFn: async (args) => { call = args; return { ts: '1.2' }; },
  });
  assert.equal(result.posted, true);
  assert.equal(call.card.classification, 'OTHER');
  assert.equal(call.isDraft, false);
});

test('approval-card endpoint still needs a draft for a positive label, and rejects junk labels', async () => {
  await assert.rejects(
    postStoredHeyreachApprovalCard({
      replyId: storedRow().id, classification: 'QUESTION', query: fakeQuery(storedRow()), postFn: async () => ({}),
    }),
    (err) => err.status === 400 && /draft is required/.test(err.message),
  );
  await assert.rejects(
    postStoredHeyreachApprovalCard({
      replyId: storedRow().id, classification: 'drop table', query: fakeQuery(storedRow()), postFn: async () => ({}),
    }),
    (err) => err.status === 400,
  );
  // Old default holds: a draft with no label is INTERESTED.
  let call = null;
  await postStoredHeyreachApprovalCard({
    replyId: storedRow().id, draft: 'Thanks, Tuesday?',
    query: fakeQuery(storedRow()), postFn: async (args) => { call = args; return { ts: '1.2' }; },
  });
  assert.equal(call.isDraft, true);
  assert.equal(call.card.classification, 'INTERESTED');
});

test('approval-card endpoint will not double post a reply that already has a card', async () => {
  const result = await postStoredHeyreachApprovalCard({
    replyId: storedRow().id,
    classification: 'OTHER',
    query: fakeQuery(storedRow({ slack_message_ts: '111.222' })),
    postFn: async () => { throw new Error('must not post'); },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'card_already_posted');
});

test('visibility-only LinkedIn cards do not start paid waterfall enrichment; positives and email are unchanged', () => {
  const { isVisibilityOnlyHeyreach, shouldSkipEnrichment } = require('../src/services/reply-phone-enrichment');
  for (const classification of ['OTHER', 'NOT_INTERESTED', 'WRONG_PERSON', 'OBJECTION', 'COMPETITOR']) {
    assert.equal(isVisibilityOnlyHeyreach({ platform: 'heyreach', classification }), true, classification);
    assert.equal(isVisibilityOnlyHeyreach({ platform: 'smartlead', classification }), false, classification);
  }
  for (const classification of ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION', 'FOLLOW_UP']) {
    assert.equal(isVisibilityOnlyHeyreach({ platform: 'heyreach', classification }), false, classification);
  }
  assert.equal(shouldSkipEnrichment('OTHER'), false);
  const src = read('src/services/reply-phone-enrichment.js');
  assert.match(src, /isVisibilityOnlyHeyreach\(existing\) \|\|\s+existing\.status === 'suppressed'/);
});
