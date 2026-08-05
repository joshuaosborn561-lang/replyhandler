const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { speaksAsPrincipal, callWithWhom } = require('../src/utils/principal-voice');
const { fallbackReattempt } = require('../src/services/follow-up-drafts');
const { fallbackDraftText } = require('../src/services/classifier');

const SALESGLIDER_VOICE =
  'You are Joshua Osborn, founder/CEO of SalesGlider Growth (InsightSpeak). ' +
  'Speak in first person as yourself. I am the CEO. Never say "our CEO" or hand off to a CEO.';

describe('principal voice', () => {
  it('detects SalesGlider CEO voice prompt', () => {
    assert.equal(speaksAsPrincipal(SALESGLIDER_VOICE), true);
    assert.equal(speaksAsPrincipal(''), false);
    assert.equal(callWithWhom(SALESGLIDER_VOICE), 'me');
    assert.equal(callWithWhom(''), 'our CEO');
  });

  it('follow-up and fallback drafts say "with me" for CEO voice', () => {
    const fu = fallbackReattempt({
      leadName: 'Brian Donigan',
      digestTimezone: 'America/Chicago',
      voicePrompt: SALESGLIDER_VOICE,
    });
    assert.match(fu, /quick call with me/);
    assert.doesNotMatch(fu, /our CEO/);

    const draft = fallbackDraftText({
      leadName: 'Brian Donigan',
      inboundMessage: "I'd be open to a conversation",
      classification: 'INTERESTED',
      digestTimezone: 'America/Chicago',
      voicePrompt: SALESGLIDER_VOICE,
    });
    assert.match(draft, /quick call with me/);
    assert.doesNotMatch(draft, /our CEO/);
  });
});
