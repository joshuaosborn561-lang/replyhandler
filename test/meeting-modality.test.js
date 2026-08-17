const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  prefersInPersonMeeting,
  meetingCta,
} = require('../src/utils/meeting-modality');
const { fallbackDraftText } = require('../src/services/classifier');
const { fallbackReattempt } = require('../src/services/follow-up-drafts');

const VASCO_VOICE =
  'You write replies for Carlos at Vasco Warranty. Carlos meets prospects IN PERSON ' +
  'at the dealership — never suggest Zoom, phone calls, "quick call", "call with our CEO", ' +
  'Calendly, or booking links. Offer to stop by in person on a couple of concrete times.';

describe('meeting modality — in person', () => {
  it('detects in-person from voice_prompt', () => {
    assert.equal(prefersInPersonMeeting(VASCO_VOICE), true);
    assert.equal(prefersInPersonMeeting(''), false);
    assert.equal(prefersInPersonMeeting('You are Joshua, suggest a quick call with me'), false);
  });

  it('Vasco fallback drafts stop-by in person, never CEO call or booking link', () => {
    const draft = fallbackDraftText({
      leadName: 'Don Chittum',
      inboundMessage: 'Be happy to talk',
      classification: 'INTERESTED',
      digestTimezone: 'America/New_York',
      voicePrompt: VASCO_VOICE,
      bookingLink: 'https://calendly.com/example/30min',
    });
    assert.match(draft, /in person|stop by/i);
    assert.doesNotMatch(draft, /our CEO|quick call|booking link|calendly|https?:\/\//i);
  });

  it('other clients still get times-first call drafts', () => {
    const draft = fallbackDraftText({
      leadName: 'Dean',
      inboundMessage: 'Sure',
      classification: 'INTERESTED',
      digestTimezone: 'America/Chicago',
      voicePrompt: '',
      bookingLink: 'https://calendly.com/example/30min',
    });
    assert.match(draft, /quick call/i);
    assert.match(draft, /booking link/i);
  });

  it('Vasco FOLLOW_UP bumps stay in-person', () => {
    const bump = fallbackReattempt({
      leadName: 'Don Chittum',
      voicePrompt: VASCO_VOICE,
      step: 1,
      lastOutboundMessage: 'Be happy to talk',
    });
    assert.match(bump, /in person|stop by/i);
    assert.doesNotMatch(bump, /quick video|quick call/i);
  });

  it('meetingCta exposes in-person time rule', () => {
    const cta = meetingCta({ voicePrompt: VASCO_VOICE, day1: 'Tuesday', day2: 'Wednesday' });
    assert.equal(cta.modality, 'in_person');
    assert.match(cta.timeRule, /IN-PERSON RULE/);
    assert.match(cta.timeRule, /Do NOT suggest Zoom/);
    assert.match(cta.suggestLine, /stop by in person/i);
  });
});
