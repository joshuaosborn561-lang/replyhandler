const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fallbackReattempt,
  detectOffer,
  valuePropPhrase,
  scrubDashes,
  bumpForOffer,
} = require('../src/services/follow-up-drafts');
const { extractThreadMessages } = require('../src/utils/thread-transcript');

describe('offer-first FOLLOW_UP bumps', () => {
  it('does not reuse the first-reply times-first template', () => {
    const draft = fallbackReattempt({
      leadName: 'Scott Hagan',
      lastOutboundMessage:
        'Hey Scott, just gave you a ring. I was offering to give you a free campaign to 10k leads on me.',
      step: 1,
    });
    assert.doesNotMatch(draft, /thanks for getting back to me/i);
    assert.doesNotMatch(draft, /mid-morning or early afternoon/i);
    assert.doesNotMatch(draft, /booking link/i);
    assert.match(draft, /free campaign|more business clients/i);
    assert.match(draft, /still interested in meeting for/i);
  });

  it('references tickets when the prior send offered tix', () => {
    const offer = detectOffer('Happy to send you some Marlins tix just for the convo.');
    assert.equal(offer.kind, 'tickets');
    assert.equal(offer.team, 'Marlins');
    const draft = fallbackReattempt({
      leadName: 'Max Spanier',
      lastOutboundMessage: 'Happy to send you some Marlins tix just for the convo.',
      step: 1,
    });
    assert.match(draft, /Marlins tix|tickets/i);
    assert.match(draft, /still interested in meeting for/i);
  });

  it('uses the video bump when prior send mentioned a video', () => {
    const draft = fallbackReattempt({
      leadName: 'Hilary Trader',
      lastOutboundMessage: 'Just sent over a quick video walkthrough.',
      step: 1,
    });
    assert.match(draft, /video/i);
    assert.match(draft, /still interested in meeting for/i);
  });

  it('generic bump reframes the value prop from the outbound', () => {
    const draft = fallbackReattempt({
      leadName: 'Dean Demori',
      lastOutboundMessage: 'Happy to jump on a quick call and walk through getting you more business clients.',
      step: 1,
    });
    assert.match(draft, /still interested in meeting for getting you more business clients/i);
  });

  it('every step reframes the original value prop', () => {
    const outbound = 'Happy to send you some Rangers tix just for the convo.';
    for (const step of [1, 2, 3, 4]) {
      const draft = fallbackReattempt({
        leadName: 'Todd',
        lastOutboundMessage: outbound,
        step,
      });
      assert.match(draft, /Rangers tickets|Rangers tix|tickets/i, `step ${step} lost the value prop`);
      assert.match(draft, /meeting for|chat about/i, `step ${step} missing meeting reframe`);
    }
  });

  it('3rd bump never uses dashes — ellipsis only', () => {
    const drafts = [
      fallbackReattempt({
        leadName: 'Scott',
        lastOutboundMessage: 'Free campaign to 10k leads on me.',
        step: 3,
      }),
      fallbackReattempt({
        leadName: 'Max',
        lastOutboundMessage: 'Some Marlins tix for the convo.',
        step: 3,
      }),
      bumpForOffer({
        name: 'Don',
        offer: { kind: 'generic' },
        step: 3,
        inPerson: true,
        lastOutboundMessage: 'stop by about the warranty program',
      }),
    ];
    for (const draft of drafts) {
      assert.doesNotMatch(draft, /[—–]/, `dash found: ${draft}`);
      assert.doesNotMatch(draft, /\s-\s/, `spaced hyphen dash found: ${draft}`);
      assert.match(draft, /\.\.\./, `expected ellipsis: ${draft}`);
      assert.match(draft, /still interested in meeting for|meet in person for/i);
    }
  });

  it('scrubDashes turns em dashes into ellipsis', () => {
    assert.equal(scrubDashes('Hey Dan — still interested'), 'Hey Dan...still interested');
    assert.equal(valuePropPhrase({ kind: 'tickets', team: 'Marlins' }, ''), 'Marlins tickets');
  });
});

describe('thread transcript for FOLLOW_UP cards', () => {
  it('flattens SmartLead history into us/them turns', () => {
    const msgs = extractThreadMessages('smartlead', {
      history: [
        { type: 'SENT', email_body: 'Initial outreach', time: '2026-08-01T10:00:00Z' },
        { type: 'REPLY', email_body: 'Sure', time: '2026-08-01T12:00:00Z' },
        { type: 'SENT', email_body: 'Great — Thursday?', time: '2026-08-01T13:00:00Z' },
      ],
    });
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs.map((m) => m.role), ['us', 'them', 'us']);
    assert.match(msgs[1].body, /Sure/);
  });

  it('merges extra sent replies without duplicating', () => {
    const msgs = extractThreadMessages('smartlead', {
      history: [
        { type: 'REPLY', email_body: 'Sure', time: '2026-08-01T12:00:00Z' },
        { type: 'SENT', email_body: 'First reply', time: '2026-08-01T13:00:00Z' },
      ],
    }, {
      extraMessages: [
        { role: 'them', body: 'Sure' },
        { role: 'us', body: 'First reply' },
        { role: 'us', body: 'Bump #1' },
      ],
    });
    assert.ok(msgs.some((m) => m.body === 'Bump #1'));
    assert.equal(msgs.filter((m) => m.body === 'Sure').length, 1);
  });
});
