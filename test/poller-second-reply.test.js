/**
 * A new reply on a thread that already has a card is its own card.
 * The same Message-ID is still one card. Lookback uses the newest reply
 * time, so a later message inside the window is not dropped.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listInboundReplies } = require('../src/utils/smartlead-webhook-helpers');
const { outsideLookback, nextUnrecordedInbound } = require('../src/services/smartlead-poller');
const { canonicalInboundMessageId } = require('../src/utils/inbound-message-id');

const INFO_ID = '<info-reply@pacocean.net>';
const SLOT_ID = '<C472638D-01F3-4902-B61B-C0C8AE0A923A@pacocean.net>';
const NOW = Date.parse('2026-10-27T16:00:00.000Z');
const HOUR = 3600 * 1000;

function history() {
  return {
    history: [
      {
        type: 'SENT',
        time: '2026-10-27T14:23:00.000Z',
        message_id: '<sent@salesglider.com>',
        email_body: 'Would Wed, Oct 28 at 11:00 AM PDT work?',
      },
      {
        type: 'REPLY',
        time: '2026-10-27T14:22:00.000Z',
        message_id: INFO_ID,
        email_body: 'Info',
      },
      {
        type: 'REPLY',
        time: '2026-10-27T14:32:00.000Z',
        message_id: SLOT_ID,
        email_body: 'Wed, Oct 28 at 11:00 AM PDT',
      },
    ],
  };
}

test('a later reply inside the window is not older_than_lookback', () => {
  const hist = history();
  const lookbackMs = 168 * HOUR;
  const staleLead = { last_reply_time: new Date(NOW - 200 * HOUR).toISOString() };
  assert.equal(outsideLookback(staleLead, hist, lookbackMs, NOW), false);

  const bothOld = {
    history: [
      { type: 'REPLY', time: new Date(NOW - 200 * HOUR).toISOString(), message_id: INFO_ID, email_body: 'Info' },
    ],
  };
  assert.equal(
    outsideLookback({ last_reply_time: new Date(NOW - 200 * HOUR).toISOString() }, bothOld, lookbackMs, NOW),
    true,
  );

  assert.equal(
    outsideLookback({ last_reply_time: new Date(NOW - HOUR).toISOString() }, bothOld, lookbackMs, NOW),
    false,
  );
});

test('a second Message-ID on an already-carded thread is one new card', async () => {
  const hist = history();
  const replies = listInboundReplies(hist, 'marbella@pacocean.net');
  assert.deepEqual(replies.map((r) => r.messageId), [
    canonicalInboundMessageId(SLOT_ID),
    canonicalInboundMessageId(INFO_ID),
  ]);

  const recorded = new Set([canonicalInboundMessageId(INFO_ID)]);
  const chosen = await nextUnrecordedInbound({
    threadContext: hist,
    lookbackMs: 168 * HOUR,
    leadReplyTime: new Date(NOW - HOUR),
    now: NOW,
    isRecorded: async (reply) => recorded.has(reply.messageId),
  });
  assert.equal(chosen.messageId, canonicalInboundMessageId(SLOT_ID));
  assert.equal(chosen.body, 'Wed, Oct 28 at 11:00 AM PDT');

  recorded.add(chosen.messageId);
  const again = await nextUnrecordedInbound({
    threadContext: hist,
    lookbackMs: 168 * HOUR,
    leadReplyTime: new Date(NOW - HOUR),
    now: NOW,
    isRecorded: async (reply) => recorded.has(reply.messageId),
  });
  assert.equal(again, null);
});

test('the poller checks the next Message-ID before counting the lead already posted', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/smartlead-poller.js'), 'utf8');
  assert.match(src, /outsideLookback\(row, threadContext, lookbackMs\)/);
  const earlyStart = src.indexOf('if (inbound && !staleHistory)');
  const earlyEnd = src.indexOf('if (staleHistory && client.smartlead_api_key)');
  const early = src.slice(earlyStart, earlyEnd);
  const earlyPosted = early.slice(early.indexOf('if (await alreadyPostedToSlack'));
  assert.match(earlyPosted, /nextUnrecordedInbound\(/);
  assert.match(earlyPosted, /return returnPostedOrRecoverReferral\(/);
  const lateStart = src.indexOf('const smartleadEmailStatsId');
  const lateEnd = src.indexOf('await cancelForInboundReply');
  const late = src.slice(lateStart, lateEnd);
  const latePosted = late.slice(late.indexOf('if (await alreadyPostedToSlack'));
  assert.match(latePosted, /nextUnrecordedInbound\(/);
  assert.match(latePosted, /return returnPostedOrRecoverReferral\(/);
});
