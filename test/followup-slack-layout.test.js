const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFollowUpConversationBlocks,
  draftApprovalActionsBlock,
} = require('../src/services/slack');
const {
  followUpSlackChannelId,
  DEFAULT_FOLLOW_UP_SLACK_CHANNEL_ID,
} = require('../src/services/follow-up-runner');
const { extractThreadMessages } = require('../src/utils/thread-transcript');

describe('FOLLOW_UP Slack channel', () => {
  it('defaults to the dedicated follow-ups channel', () => {
    const prev = process.env.FOLLOW_UP_SLACK_CHANNEL_ID;
    delete process.env.FOLLOW_UP_SLACK_CHANNEL_ID;
    try {
      assert.equal(followUpSlackChannelId(), 'C0BRRS8DV19');
      assert.equal(DEFAULT_FOLLOW_UP_SLACK_CHANNEL_ID, 'C0BRRS8DV19');
    } finally {
      if (prev == null) delete process.env.FOLLOW_UP_SLACK_CHANNEL_ID;
      else process.env.FOLLOW_UP_SLACK_CHANNEL_ID = prev;
    }
  });

  it('honors FOLLOW_UP_SLACK_CHANNEL_ID override', () => {
    const prev = process.env.FOLLOW_UP_SLACK_CHANNEL_ID;
    process.env.FOLLOW_UP_SLACK_CHANNEL_ID = 'C_OVERRIDE';
    try {
      assert.equal(followUpSlackChannelId(), 'C_OVERRIDE');
    } finally {
      if (prev == null) delete process.env.FOLLOW_UP_SLACK_CHANNEL_ID;
      else process.env.FOLLOW_UP_SLACK_CHANNEL_ID = prev;
    }
  });
});

describe('FOLLOW_UP card conversation layout', () => {
  it('shows original → our reply → rest without dupes or truncated markers', () => {
    const blocks = buildFollowUpConversationBlocks({
      inboundMessage: 'Sure, Tuesday works.',
      lastOutboundMessage: 'Great — talk Tuesday at 2.',
      draft: 'Still interested in meeting for a free campaign?',
      threadMessages: [
        { role: 'them', body: 'Sure, Tuesday works.' },
        { role: 'us', body: 'Great — talk Tuesday at 2.' },
        { role: 'us', body: 'Bump #1 checking in' },
        { role: 'them', body: 'Still around next week?' },
      ],
    });

    const texts = blocks
      .filter((b) => b.type === 'section')
      .map((b) => b.text.text);

    assert.ok(texts.some((t) => t.includes('*Original message*') && t.includes('Sure, Tuesday works.')));
    assert.ok(texts.some((t) => t.includes('*Our reply*') && t.includes('Great')));
    assert.ok(texts.some((t) => t.includes('Bump #1 checking in')));
    assert.ok(texts.some((t) => t.includes('Still around next week?')));
    assert.ok(texts.some((t) => t.includes('*Suggested follow-up*')));

    // Original + our reply appear once each (not again in the rest).
    const originalHits = texts.filter((t) => t.includes('Sure, Tuesday works.')).length;
    const ourHits = texts.filter((t) => t.includes('Great — talk Tuesday at 2.')).length;
    assert.equal(originalHits, 1);
    assert.equal(ourHits, 1);

    assert.ok(!texts.some((t) => t.includes('_(truncated)_')));
  });

  it('approval actions sit in a reusable block (pinned above the thread on FOLLOW_UP)', () => {
    const actions = draftApprovalActionsBlock('reply-123');
    assert.equal(actions.type, 'actions');
    const ids = actions.elements.map((e) => e.action_id);
    assert.deepEqual(ids, [
      'approve_reply',
      'open_edit_modal',
      'reject_reply',
      'dq_prospect',
      'meeting_booked',
    ]);
  });
});

describe('thread extract pinStart', () => {
  it('keeps the opening exchange when history is long', () => {
    const list = Array.from({ length: 30 }, (_, i) => ({
      type: i % 2 === 0 ? 'REPLY' : 'SENT',
      email_body: `msg ${i + 1}`,
      time: new Date(Date.UTC(2026, 7, 1, 12, i)).toISOString(),
    }));

    const msgs = extractThreadMessages('smartlead', { history: list }, {
      maxMessages: 6,
      pinStart: true,
    });
    assert.ok(msgs.some((m) => m.body === 'msg 1'), 'original kept');
    assert.ok(msgs.some((m) => m.body === 'msg 2'), 'our first reply kept');
    assert.ok(msgs.some((m) => m.body === 'msg 30'), 'latest kept');
    assert.ok(msgs.length <= 6);
  });
});
