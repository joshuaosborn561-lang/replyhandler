const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  prefersInPersonMeeting,
  prefersCallbackCall,
  shouldIncludeBookingLink,
  meetingCta,
  DEEP_ROOTS_FROM_NUMBER,
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

  it('other clients get two times and the booking link', () => {
    const draft = fallbackDraftText({
      leadName: 'Dean',
      inboundMessage: 'Sure',
      classification: 'INTERESTED',
      digestTimezone: 'America/Chicago',
      voicePrompt: '',
      bookingLink: 'https://calendly.com/example/30min',
    });
    assert.match(draft, /quick call/i);
    assert.match(draft, /mid-morning|afternoon/i);
    assert.match(draft, /calendly.com\/example\/30min/);
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

  it('Vasco next-day bump refreshes in-person times and never includes a booking link', () => {
    const bump = fallbackReattempt({
      leadName: 'Don Chittum',
      voicePrompt: VASCO_VOICE,
      step: 2,
      lastOutboundMessage: 'Does Tuesday mid-morning or Wednesday early afternoon work for me to stop by?',
      bookingLink: 'https://calendly.com/example/30min',
      slots: [
        { label: 'Thu, Oct 9, 10:00 AM EDT' },
        { label: 'Fri, Oct 10, 2:00 PM EDT' },
      ],
    });
    assert.match(bump, /those times got taken/i);
    assert.match(bump, /stop by in person/i);
    assert.match(bump, /Thu, Oct 9/);
    assert.doesNotMatch(bump, /calendly|https?:\/\//i);
  });

  it('meetingCta exposes in-person time rule', () => {
    const cta = meetingCta({ voicePrompt: VASCO_VOICE, day1: 'Tuesday', day2: 'Wednesday' });
    assert.equal(cta.modality, 'in_person');
    assert.match(cta.timeRule, /IN-PERSON RULE/);
    assert.match(cta.timeRule, /Do NOT suggest Zoom/);
    assert.match(cta.suggestLine, /stop by in person/i);
  });
});

const DEEP_ROOTS_VOICE =
  'Tyler will CALL them from 218-469-3457. Ask what time works best. ' +
  'Never suggest Zoom, Calendly, or booking links.';

describe('meeting modality — Deep Roots callback', () => {
  it('detects callback from client name even with empty voice', () => {
    assert.equal(prefersCallbackCall('', 'Deep Roots'), true);
    assert.equal(prefersCallbackCall('', 'DeepRoots Landscaping'), true);
    assert.equal(shouldIncludeBookingLink('', 'Deep Roots'), false);
    assert.equal(prefersCallbackCall('', 'Goliath'), false);
  });

  it('detects callback from voice_prompt', () => {
    assert.equal(prefersCallbackCall(DEEP_ROOTS_VOICE), true);
    assert.equal(shouldIncludeBookingLink(DEEP_ROOTS_VOICE), false);
  });

  it('Deep Roots fallback drafts ask what time works, Tyler calls, no booking link', () => {
    const draft = fallbackDraftText({
      leadName: 'Pat Riley',
      inboundMessage: 'Sure',
      classification: 'INTERESTED',
      digestTimezone: 'America/Chicago',
      clientName: 'Deep Roots',
      voicePrompt: '',
      bookingLink: 'https://calendly.com/example/30min',
    });
    assert.match(draft, /what time works best/i);
    assert.match(draft, /Tyler/i);
    assert.match(draft, new RegExp(DEEP_ROOTS_FROM_NUMBER.replace(/-/g, '[-\\s]?')));
    assert.doesNotMatch(draft, /booking link|calendly|https?:\/\//i);
    assert.doesNotMatch(draft, /mid-morning|early afternoon/i);
  });

  it('Deep Roots FOLLOW_UP asks what time works and never pastes a link', () => {
    const bump = fallbackReattempt({
      leadName: 'Pat Riley',
      clientName: 'Deep Roots',
      step: 2,
      lastOutboundMessage: 'What time works best? Tyler will give you a call.',
      bookingLink: 'https://calendly.com/example/30min',
      slots: [
        { label: 'Thu, Oct 9, 10:00 AM CDT' },
        { label: 'Fri, Oct 10, 2:00 PM CDT' },
      ],
    });
    assert.match(bump, /what time works best/i);
    assert.match(bump, /Tyler/i);
    assert.match(bump, /218-469-3457/);
    assert.doesNotMatch(bump, /those times got taken/i);
    assert.doesNotMatch(bump, /calendly|https?:\/\//i);
  });

  it('meetingCta exposes callback time rule', () => {
    const cta = meetingCta({ clientName: 'Deep Roots' });
    assert.equal(cta.modality, 'callback');
    assert.match(cta.timeRule, /CALLBACK RULE/);
    assert.match(cta.suggestLine, /what time works best/i);
    assert.match(cta.suggestLine, /218-469-3457/);
  });
});
