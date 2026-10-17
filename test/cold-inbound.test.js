const test = require('node:test');
const assert = require('node:assert/strict');

const { isColdInbound } = require('../src/services/heyreach-poller');
const {
  slackChannelSuppressionReason,
  PITCH_INBOUND_THRESHOLD,
  PITCH_INBOUND_REASON,
} = require('../src/utils/slack-channel-policy');
const { pitchHiddenSummaryText } = require('../src/services/slack');
const { postPitchHiddenSummaries } = require('../src/services/pitch-hidden-summary');

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const theyFirst = [
  { role: 'prospect', message: 'Hi — saw your post. What tools do you use for mailboxes?' },
];
const weFirst = [
  { sender: 'ME', message: 'Want a pair of tickets?' },
  { is_reply: true, message: 'What game?' },
];

test('isColdInbound is true when there is no campaign and they wrote first', () => {
  assert.equal(isColdInbound({ campaignId: null }, theyFirst), true);
  assert.equal(isColdInbound({}, theyFirst), true);
  assert.equal(isColdInbound({ campaign_id: '—' }, theyFirst), true);
  assert.equal(isColdInbound({}, []), true);
});

test('isColdInbound is false when we sent first, even without a campaign id', () => {
  assert.equal(isColdInbound({ campaignId: null }, weFirst), false);
});

test('isColdInbound is false on campaign threads even if they wrote first', () => {
  assert.equal(isColdInbound({ campaignId: '375995' }, theyFirst), false);
  assert.equal(isColdInbound({ campaign: { id: 99 } }, theyFirst), false);
  assert.equal(
    isColdInbound(
      { correspondentProfile: { autoTags: [{ campaignId: 12, creationTime: '2026-01-01' }] } },
      theyFirst,
    ),
    false,
  );
});

test('isColdInbound is true when there is no campaign and no outbound before their reply', () => {
  const msgs = [
    { role: 'prospect', message: 'hello' },
    { role: 'us', message: 'thanks for writing' },
  ];
  assert.equal(isColdInbound({}, msgs), true);
});

test('pitch threshold 0.8 suppresses only cold inbound', async () => {
  assert.equal(PITCH_INBOUND_THRESHOLD, 0.8);
  await withEnv({ SUPPRESS_PITCHES: undefined }, () => {
    assert.equal(
      slackChannelSuppressionReason({
        classification: 'QUESTION',
        inboundMessage: 'How do you scale outbound?',
        isColdInbound: true,
        pitchToUsProb: 0.8,
      }),
      PITCH_INBOUND_REASON,
    );
    assert.equal(
      slackChannelSuppressionReason({
        classification: 'QUESTION',
        inboundMessage: 'How do you scale outbound?',
        isColdInbound: true,
        pitchToUsProb: 0.79,
      }),
      null,
    );
    assert.equal(
      slackChannelSuppressionReason({
        classification: 'INTERESTED',
        inboundMessage: 'Sure, tell me more.',
        isColdInbound: false,
        pitchToUsProb: 0.99,
      }),
      null,
    );
    assert.equal(
      slackChannelSuppressionReason({
        classification: 'QUESTION',
        inboundMessage: 'What game?',
        isColdInbound: true,
        pitchToUsProb: null,
      }),
      null,
    );
  });
});

test('SUPPRESS_PITCHES=0 never hides a pitch', async () => {
  await withEnv({ SUPPRESS_PITCHES: '0' }, () => {
    assert.equal(
      slackChannelSuppressionReason({
        classification: 'QUESTION',
        inboundMessage: 'How do you scale outbound?',
        isColdInbound: true,
        pitchToUsProb: 0.99,
      }),
      null,
    );
  });
});

test('pitch hidden summary is one line and skipped when N is 0', () => {
  assert.equal(pitchHiddenSummaryText(1), '1 pitch hidden today');
  assert.equal(pitchHiddenSummaryText(3), '3 pitches hidden today');
});

test('postPitchHiddenSummaries posts once per channel when N > 0', async () => {
  const posted = [];
  const inserts = [];
  const dbClient = {
    async query(sql, params) {
      if (/FROM pending_replies/i.test(sql)) {
        return {
          rows: [
            { client_id: 'c1', slack_bot_token: 'xoxb', slack_channel_id: 'C1', n: 2 },
          ],
        };
      }
      if (/INSERT INTO pitch_hidden_summaries/i.test(sql)) {
        inserts.push(params);
        return { rows: [{ id: 'sum-1' }] };
      }
      if (/UPDATE pitch_hidden_summaries/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const result = await postPitchHiddenSummaries({
    now: new Date('2026-10-17T20:05:00-05:00'),
    dbClient,
    postFn: async (token, channelId, n) => {
      posted.push({ token, channelId, n, text: pitchHiddenSummaryText(n) });
      return { ts: '1.1' };
    },
  });
  assert.equal(result.posted, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].text, '2 pitches hidden today');
  assert.equal(inserts.length, 1);
});
