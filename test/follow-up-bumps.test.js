const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fallbackReattempt,
  detectOffer,
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
    assert.match(draft, /free campaign/i);
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
    assert.match(draft, /still interested|meeting|video/i);
  });

  it('uses the video bump when prior send mentioned a video', () => {
    const draft = fallbackReattempt({
      leadName: 'Hilary Trader',
      lastOutboundMessage: 'Just sent over a quick video walkthrough.',
      step: 1,
    });
    assert.match(draft, /video come through|video/i);
  });

  it('generic bump stays short and soft', () => {
    const draft = fallbackReattempt({
      leadName: 'Dean Demori',
      lastOutboundMessage: 'Happy to jump on a quick call and walk through it.',
      step: 1,
    });
    assert.match(draft, /still interested in a meeting or a quick video/i);
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
