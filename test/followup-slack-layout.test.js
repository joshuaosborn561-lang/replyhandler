const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFollowUpConversationBlocks,
  buildSentConfirmationBlocks,
  buildDraftApprovalCard,
  lastThreadTurn,
  draftApprovalActionsBlock,
} = require('../src/services/slack');
const { cleanInboundReply, stripOutlookCss } = require('../src/utils/smartlead-webhook-helpers');
const { actionKindFor } = require('../src/services/refresh-followup-cards');
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
  it('shows the suggested send and last thread turn, not the full dump', () => {
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
      .map((b) => b.text.text)
      .join('\n');

    assert.match(texts, /\*Suggested follow-up\*/);
    assert.match(texts, /Still interested in meeting for a free campaign/);
    assert.match(texts, /\*Last message \(them\)\*/);
    assert.match(texts, /Still around next week/);
    assert.doesNotMatch(texts, /\*Original message\*/);
    assert.doesNotMatch(texts, /Bump #1 checking in/);
    assert.ok(!texts.includes('Sure, Tuesday works.'), 'original inbound is not dumped');

    const last = lastThreadTurn({
      threadMessages: [
        { role: 'them', body: 'I am more interested in PowerGRYD.\n\nOn Wednesday, September 30, 2026 at 10:27 AM Rebecca White wrote: old thread' },
      ],
    });
    assert.equal(last.role, 'them');
    assert.match(last.body, /more interested in PowerGRYD/);
    assert.doesNotMatch(last.body, /Rebecca White wrote/);
  });

  it('sent confirmation stays compact — send first, last turn, no thread dump', () => {
    const blocks = buildSentConfirmationBlocks({
      leadName: 'Patrick Lefler',
      leadEmail: 'plefler@seeking-eureeka.com',
      platform: 'smartlead',
      classification: 'FOLLOW_UP',
      inboundMessage: 'I am more interested in PowerGRYD.\n\nOn Wednesday Rebecca White wrote: old pitch',
      lastOutboundMessage: 'Patrick, I have got an extra pair of 76ers tickets.',
      sentReply: 'Hey Patrick, still interested in meeting for this?',
      actionKind: 'edited',
      threadMessages: [
        { role: 'us', body: 'Patrick, I have got an extra pair of 76ers tickets.' },
        { role: 'them', body: 'I am more interested in PowerGRYD.\n\nOn Wednesday Rebecca White wrote: old pitch' },
      ],
    });
    const texts = blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');
    assert.match(texts, /\*Sent to prospect\*/);
    assert.match(texts, /still interested in meeting/);
    assert.match(texts, /\*Last message \(them\)\*/);
    assert.match(texts, /more interested in PowerGRYD/);
    assert.doesNotMatch(texts, /\*Last message \(you\)\*/);
    assert.doesNotMatch(texts, /\*Original message\*/);
    assert.doesNotMatch(texts, /\*They replied/);
    assert.doesNotMatch(texts, /Rebecca White wrote/);
  });

  it('approval actions sit in a reusable block', () => {
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
    const reject = actions.elements.find((e) => e.action_id === 'reject_reply');
    assert.match(reject.text.text, /not interested/i);
  });

  it('pending FOLLOW_UP approval card is compact — no Original / You sent dump', () => {
    const { blocks } = buildDraftApprovalCard({
      replyId: 'r1',
      leadName: 'Cory Schell',
      leadEmail: 'cory@thekellycompany.com',
      platform: 'smartlead',
      classification: 'FOLLOW_UP',
      draft: 'Hey Cory, still interested in meeting for this?',
      inboundMessage: 'P {margin-top:0;margin-bottom:0;} Hello Ethan, Were are you guys out of?',
      lastOutboundMessage: 'Cory, I have got an extra pair of AirPods.',
      campaignDisplay: 'EMCOR A Property | AirPods (4036499)',
      threadMessages: [
        { role: 'us', body: 'Cory, I have got an extra pair of AirPods.' },
        { role: 'them', body: 'P {margin-top:0;margin-bottom:0;} Hello Ethan, Were are you guys out of?' },
      ],
    });
    const texts = blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');
    assert.match(texts, /\*Suggested follow-up\*/);
    assert.match(texts, /\*Last message \(them\)\*/);
    assert.match(texts, /Were are you guys out of/);
    assert.doesNotMatch(texts, /margin-top/);
    assert.doesNotMatch(texts, /\*Original message\*/);
    assert.doesNotMatch(texts, /\*Our reply\*/);
    assert.doesNotMatch(texts, /\*You sent \(2\)\*/);
    assert.ok(blocks.some((b) => b.type === 'actions'), 'buttons stay on the pending card');
  });

  it('does not repeat the outgoing bump as Last message (you)', () => {
    const blocks = buildFollowUpConversationBlocks({
      draft: 'Hey Patrick, still interested in meeting for this?',
      inboundMessage: 'Would like to learn more.',
      lastOutboundMessage: 'Hey Patrick, still interested in meeting for this?',
      threadMessages: [
        { role: 'them', body: 'Would like to learn more.' },
        { role: 'us', body: 'Hey Patrick, still interested in meeting for this?' },
      ],
    });
    const texts = blocks
      .filter((b) => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');
    assert.match(texts, /\*Suggested follow-up\*/);
    assert.match(texts, /\*Last message \(them\)\*/);
    assert.match(texts, /Would like to learn more/);
    assert.doesNotMatch(texts, /\*Last message \(you\)\*/);
  });

  it('strips Outlook CSS from the last-message line', () => {
    const cleaned = cleanInboundReply(
      '<style>P {margin-top:0;margin-bottom:0;}</style><p>Hello Ethan,</p><p>Were are you guys out of?</p>'
    );
    assert.match(cleaned, /Hello Ethan/);
    assert.match(cleaned, /Were are you guys out of/);
    assert.doesNotMatch(cleaned, /margin-top/);
    assert.doesNotMatch(stripOutlookCss('P {margin-top:0;margin-bottom:0;} Hello Ethan,'), /margin-top/);

    const last = lastThreadTurn({
      threadMessages: [{
        role: 'them',
        body: 'v\\:* {behavior:url(#default#VML);} Hello Ethan, Were are you guys out of?',
      }],
    });
    assert.match(last.body, /Hello Ethan/);
    assert.doesNotMatch(last.body, /behavior:url/);
  });
});

describe('FOLLOW_UP card refresh', () => {
  it('maps stored status to the confirmation action kind', () => {
    assert.equal(actionKindFor('pending'), null);
    assert.equal(actionKindFor('flagged'), 'failed');
    assert.equal(actionKindFor('sent'), 'approved');
    assert.equal(actionKindFor('rejected'), 'rejected');
    assert.equal(actionKindFor('meeting_booked'), 'meeting_booked');
    assert.equal(actionKindFor('disqualified'), 'disqualified');
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
