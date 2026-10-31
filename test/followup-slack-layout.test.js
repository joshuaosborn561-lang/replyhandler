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
  it('shows WILL SEND in full, then the thread oldest to newest', () => {
    const blocks = buildFollowUpConversationBlocks({
      inboundMessage: 'Sure, Tuesday works.',
      lastOutboundMessage: 'Great — talk Tuesday at 2.',
      draft: 'Still interested in meeting for a free campaign?',
      threadMessages: [
        { role: 'them', body: 'Sure, Tuesday works.', time: '2026-09-01T12:00:00.000Z' },
        { role: 'us', body: 'Great — talk Tuesday at 2.', time: '2026-09-01T13:00:00.000Z' },
        { role: 'us', body: 'Bump #1 checking in', time: '2026-09-02T13:00:00.000Z' },
        { role: 'them', body: 'Still around next week?', time: '2026-09-03T13:00:00.000Z' },
      ],
    });

    const texts = blocks
      .filter((b) => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');

    assert.match(texts, /\*WILL SEND\*/);
    assert.match(texts, /Still interested in meeting for a free campaign/);
    assert.match(texts, /Sure, Tuesday works/);
    assert.match(texts, /Bump #1 checking in/);
    assert.match(texts, /Still around next week/);
    assert.doesNotMatch(texts, /\*Suggested follow-up\*/);
    assert.doesNotMatch(texts, /\*Original message\*/);

    const last = lastThreadTurn({
      threadMessages: [
        { role: 'them', body: 'I am more interested in a different product.\n\nOn Wednesday, September 30, 2026 at 10:27 AM Jordan wrote: old thread' },
      ],
    });
    assert.equal(last.role, 'them');
    assert.match(last.body, /more interested in a different product/);
    assert.doesNotMatch(last.body, /Jordan wrote/);
  });

  it('sent confirmation keeps WILL SEND as Sent to prospect plus the thread', () => {
    const blocks = buildSentConfirmationBlocks({
      leadName: 'Alex Rivera',
      leadEmail: 'alex@example.com',
      platform: 'smartlead',
      classification: 'FOLLOW_UP',
      inboundMessage: 'I am more interested in staffing help.\n\nOn Wednesday Jordan wrote: old pitch',
      lastOutboundMessage: 'Alex, I have an extra pair of tickets.',
      sentReply: 'Hey Alex, looping in Myles from our side to send that over.',
      actionKind: 'edited',
      threadMessages: [
        { role: 'us', body: 'Alex, I have an extra pair of tickets.' },
        { role: 'them', body: 'I am more interested in staffing help.\n\nOn Wednesday Jordan wrote: old pitch' },
      ],
      needsClient: true,
      whatToSend: 'one-pager',
    });
    const texts = blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');
    assert.match(texts, /\*Sent to prospect\*/);
    assert.match(texts, /looping in Myles from our side/);
    assert.match(texts, /more interested in staffing help/);
    assert.match(texts, /LOOP IN CLIENT/);
    assert.doesNotMatch(texts, /\*Original message\*/);
    assert.doesNotMatch(texts, /\*They replied/);
    assert.doesNotMatch(texts, /Jordan wrote/);
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
    assert.equal(reject.text.text, '❌ Reject');
    assert.doesNotMatch(reject.text.text, /not interested/i);
  });

  it('pending FOLLOW_UP card puts WILL SEND then buttons, never truncates the draft', () => {
    const longDraft = `Hey Alex, looping in Myles from our side to send the one-pager you asked for.\n\n${'Details '.repeat(80)}`;
    const { blocks } = buildDraftApprovalCard({
      replyId: 'r1',
      leadName: 'Alex Rivera',
      leadEmail: 'alex@example.com',
      platform: 'smartlead',
      classification: 'FOLLOW_UP',
      draft: longDraft,
      inboundMessage: 'P {margin-top:0;margin-bottom:0;} Hello, can you send details first?',
      lastOutboundMessage: 'Alex, want to grab time Tuesday?',
      campaignDisplay: 'Example Co | Intro (1)',
      threadMessages: [
        { role: 'us', body: 'Alex, want to grab time Tuesday?' },
        { role: 'them', body: 'P {margin-top:0;margin-bottom:0;} Hello, can you send details first?' },
      ],
      needsClient: true,
      whatToSend: 'one-pager',
      ccEmails: 'contact@example.com',
    });
    const texts = blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');
    assert.match(texts, /\*Draft\*/);
    assert.doesNotMatch(texts, /WILL SEND/);
    assert.ok(texts.includes(longDraft.split('\n')[0]));
    assert.doesNotMatch(texts, /_\(truncated\)_/);
    assert.match(texts, /LOOP IN CLIENT/);
    assert.match(texts, /one-pager/);
    assert.match(texts, /send details first/);
    assert.doesNotMatch(texts, /margin-top/);
    assert.doesNotMatch(texts, /\*Suggested follow-up\*/);
    const types = blocks.map((b) => b.type);
    const draftIdx = blocks.findIndex((b) => b.type === 'section' && /\*Draft\*/.test(b.text?.text || ''));
    const actionIdx = types.indexOf('actions');
    assert.ok(draftIdx >= 0 && actionIdx >= 0 && actionIdx > draftIdx, 'buttons stay below the draft');
    assert.equal(types[0], 'section');
    assert.ok(types.indexOf('context') > actionIdx, 'context line sits under the buttons');
    const actionIds = blocks
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements.map((e) => e.action_id));
    assert.ok(actionIds.includes('approve_reply'));
    assert.ok(actionIds.includes('approve_reply_cc_client'));
    const loopIdx = blocks.findIndex((b) => b.type === 'section' && /LOOP IN CLIENT/.test(b.text?.text || ''));
    assert.ok(loopIdx < actionIdx, 'LOOP IN CLIENT sits before the buttons');
  });

  it('hides Send + CC client when there is no client contact email', () => {
    const { blocks } = buildDraftApprovalCard({
      replyId: 'r-no-cc',
      leadName: 'Alex Rivera',
      platform: 'smartlead',
      classification: 'FOLLOW_UP',
      draft: 'Hey Alex, looping in Myles from our side to send the deck.',
      needsClient: true,
      whatToSend: 'deck',
    });
    const actionIds = blocks
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements.map((e) => e.action_id));
    assert.ok(actionIds.includes('approve_reply'));
    assert.ok(!actionIds.includes('approve_reply_cc_client'));
    const texts = blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');
    assert.match(texts, /LOOP IN CLIENT/);
  });

  it('shows Send + CC client when Always-forward is set even if the draft does not loop anyone in', () => {
    const { blocks } = buildDraftApprovalCard({
      replyId: 'r-no-loop',
      leadName: 'Alex Rivera',
      platform: 'smartlead',
      classification: 'FOLLOW_UP',
      draft: 'Hey Alex, happy to walk through pricing on a quick call.',
      needsClient: true,
      whatToSend: 'info',
      ccEmails: 'contact@example.com',
    });
    const actionIds = blocks
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements.map((e) => e.action_id));
    assert.ok(actionIds.includes('approve_reply'));
    assert.ok(actionIds.includes('approve_reply_cc_client'));
  });

  it('still shows the last prospect turn in the thread, not as a duplicate last-message line', () => {
    const blocks = buildFollowUpConversationBlocks({
      draft: 'Hey Alex, looping in Myles from our side to send that over.',
      inboundMessage: 'Would like to learn more.',
      lastOutboundMessage: 'Hey Alex, still interested in meeting for this?',
      threadMessages: [
        { role: 'them', body: 'Would like to learn more.' },
        { role: 'us', body: 'Hey Alex, still interested in meeting for this?' },
      ],
    });
    const texts = blocks
      .filter((b) => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');
    assert.match(texts, /\*WILL SEND\*/);
    assert.match(texts, /Would like to learn more/);
    assert.doesNotMatch(texts, /\*Last message \(them\)\*/);
    assert.doesNotMatch(texts, /\*Suggested follow-up\*/);
  });

  it('keeps a long thread off the card: You said / They replied / draft carry the context', () => {
    const threadMessages = Array.from({ length: 45 }, (_, i) => ({
      role: i % 2 === 0 ? 'us' : 'them',
      body: `Turn ${i + 1} ${'word '.repeat(30)}`,
      time: new Date(Date.UTC(2026, 8, 1, 12, i)).toISOString(),
    }));
    const { blocks, overflowThread } = buildDraftApprovalCard({
      replyId: 'r-overflow',
      leadName: 'Alex Rivera',
      platform: 'smartlead',
      classification: 'FOLLOW_UP',
      draft: 'Hey Alex, circling back on hiring help.',
      inboundMessage: 'We need help with hiring techs.',
      threadMessages,
    });
    assert.ok(blocks.length <= 50, `card has ${blocks.length} blocks`);
    assert.equal((overflowThread || []).length, 0, 'nothing the sender needs lives only in a thread (Josh, Oct 29 2026)');
    assert.doesNotMatch(JSON.stringify(blocks), /Turn 1 /);
  });

  it('strips Outlook CSS from the last-message line', () => {
    const cleaned = cleanInboundReply(
      '<style>P {margin-top:0;margin-bottom:0;}</style><p>Hello there,</p><p>Were are you guys out of?</p>'
    );
    assert.match(cleaned, /Hello there/);
    assert.match(cleaned, /Were are you guys out of/);
    assert.doesNotMatch(cleaned, /margin-top/);
    assert.doesNotMatch(stripOutlookCss('P {margin-top:0;margin-bottom:0;} Hello there,'), /margin-top/);

    const last = lastThreadTurn({
      threadMessages: [{
        role: 'them',
        body: 'v\\:* {behavior:url(#default#VML);} Hello there, Were are you guys out of?',
      }],
    });
    assert.match(last.body, /Hello there/);
    assert.doesNotMatch(last.body, /behavior:url/);
  });
});

describe('FOLLOW_UP card refresh', () => {
  it('maps stored status to the confirmation action kind', () => {
    assert.equal(actionKindFor('pending'), null);
    assert.equal(actionKindFor('flagged'), 'failed');
    assert.equal(actionKindFor('sent'), 'approved');
    assert.equal(actionKindFor('rejected'), 'rejected');
    assert.equal(actionKindFor('skipped'), 'skipped');
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
