const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDays,
  parseDryRun,
  shouldResurface,
  resurfaceSuppressedReplies,
} = require('../src/services/resurface-suppressed');
const { looksLikeMixedIntent } = require('../src/utils/mixed-intent');

const MIXED = "Let's hold off for now. What's your typical timeline to get started?";
const DECLINE = 'Not interested. Please do not email again.';
const QUESTION = "What's your typical timeline to get started?";

function row(overrides) {
  return {
    id: 'row-1',
    client_id: 'client-1',
    platform: 'smartlead',
    campaign_id: 'camp-1',
    campaign_name: null,
    lead_id: 'lead-1',
    lead_name: 'redacted',
    lead_email: 'redacted@example.com',
    inbound_message: MIXED,
    thread_context: null,
    classification: 'NOT_INTERESTED',
    draft_reply: null,
    slack_message_ts: null,
    status: 'suppressed',
    client_name: 'redacted-client',
    voice_prompt: null,
    booking_link: null,
    digest_timezone: 'America/Chicago',
    slack_bot_token: 'xoxb-test',
    slack_channel_id: 'C1',
    active: true,
    ...overrides,
  };
}

function fakeDb(rows, updates) {
  return {
    async query(sql, params) {
      if (/FROM pending_replies/i.test(sql) && /status = 'suppressed'/i.test(sql) && /SELECT/i.test(sql)) {
        return { rows };
      }
      if (/UPDATE pending_replies/i.test(sql)) {
        updates.push({ sql, params });
        return { rows: [{ id: params[params.length - 1] }] };
      }
      return { rows: [] };
    },
  };
}

test('parseDays defaults to 3 and caps', () => {
  assert.equal(parseDays(undefined), 3);
  assert.equal(parseDays('7'), 7);
  assert.equal(parseDays('99'), 30);
  assert.equal(parseDays('0'), 3);
});

test('parseDryRun defaults true; only explicit falsey flags run live', () => {
  assert.equal(parseDryRun(undefined), true);
  assert.equal(parseDryRun(''), true);
  assert.equal(parseDryRun('1'), true);
  assert.equal(parseDryRun('false'), false);
  assert.equal(parseDryRun('0'), false);
});

test('shouldResurface is mixed or QUESTION, not a clear decline', () => {
  assert.equal(shouldResurface({ classification: 'NOT_INTERESTED', inboundMessage: MIXED }), true);
  assert.equal(shouldResurface({ classification: 'QUESTION', inboundMessage: QUESTION }), true);
  assert.equal(shouldResurface({ classification: 'NOT_INTERESTED', inboundMessage: DECLINE }), false);
  assert.equal(shouldResurface({ classification: 'INTERESTED', inboundMessage: 'Sure, let us talk next week.' }), false);
});

test('dry_run default returns counts only and does not post', async () => {
  const updates = [];
  const posted = [];
  const classifyFn = async (_tc, inbound) => {
    if (looksLikeMixedIntent(inbound)) {
      return { classification: 'QUESTION', draft: 'draft', reasoning: 'mixed' };
    }
    if (inbound.includes('timeline')) {
      return { classification: 'QUESTION', draft: 'draft', reasoning: 'q' };
    }
    return { classification: 'NOT_INTERESTED', draft: null, reasoning: 'no' };
  };

  const counts = await resurfaceSuppressedReplies({
    dbClient: fakeDb([
      row({ id: 'a', inbound_message: MIXED }),
      row({ id: 'b', inbound_message: DECLINE }),
      row({ id: 'c', inbound_message: QUESTION }),
    ], updates),
    classifyFn,
    postFn: async (args) => {
      posted.push(args);
      return { ts: '1.2' };
    },
  });

  assert.equal(counts.dry_run, true);
  assert.equal(counts.days, 3);
  assert.equal(counts.scanned, 3);
  assert.equal(counts.resurfaceable, 2);
  assert.equal(counts.still_suppressed, 1);
  assert.equal(counts.posted, 0);
  assert.equal(posted.length, 0);
  assert.equal(updates.length, 0);
  const json = JSON.stringify(counts);
  assert.equal(json.includes('hold off'), false);
  assert.equal(json.includes('redacted'), false);
  assert.equal(json.includes('@example.com'), false);
});

test('live mode resets status and posts mixed/question only', async () => {
  const updates = [];
  const posted = [];
  const classifyFn = async (_tc, inbound) => ({
    classification: looksLikeMixedIntent(inbound) ? 'QUESTION' : 'NOT_INTERESTED',
    draft: looksLikeMixedIntent(inbound) ? 'Happy to pick this up.' : null,
    reasoning: 'bulk',
  });

  const counts = await resurfaceSuppressedReplies({
    dryRun: false,
    dbClient: fakeDb([
      row({ id: 'a', inbound_message: MIXED }),
      row({ id: 'b', inbound_message: DECLINE }),
    ], updates),
    classifyFn,
    postFn: async (args) => {
      posted.push(args.replyId);
      return { ts: '9.9' };
    },
  });

  assert.equal(counts.dry_run, false);
  assert.equal(counts.resurfaceable, 1);
  assert.equal(counts.still_suppressed, 1);
  assert.equal(counts.posted, 1);
  assert.deepEqual(posted, ['a']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[0], 'pending');
  assert.equal(updates[0].params[1], 'QUESTION');
  assert.equal(updates[0].params[3], 'a');
});

test('inactive clients and classify failures are counted, not posted', async () => {
  const posted = [];
  const counts = await resurfaceSuppressedReplies({
    dryRun: false,
    dbClient: fakeDb([
      row({ id: 'inactive', active: false, inbound_message: MIXED }),
      row({ id: 'boom', inbound_message: MIXED }),
    ], []),
    classifyFn: async () => {
      throw new Error('classifier down');
    },
    postFn: async () => {
      posted.push(1);
      return { ts: '1' };
    },
  });
  assert.equal(counts.skipped_inactive, 1);
  assert.equal(counts.classify_errors, 1);
  assert.equal(counts.posted, 0);
  assert.equal(posted.length, 0);
});
