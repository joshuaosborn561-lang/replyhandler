const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fallbackDraftText } = require('../src/services/classifier');

describe('Claude fail falls through to Gemini', () => {
  it('classifier no longer dumps Claude failures into deterministic fallback only', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/classifier.js'),
      'utf8'
    );
    assert.match(src, /falling through to Gemini/);
    assert.doesNotMatch(
      src,
      /Claude retrieval draft failed — using deterministic fallback/
    );
    assert.match(src, /draftWithGemini/);
  });

  it('MEETING_PROPOSED fallback confirms their times instead of inventing mid-morning', () => {
    const draft = fallbackDraftText({
      leadName: 'Chase Dawson',
      inboundMessage: 'Wednesday works. 1-3pm est if possible.',
      classification: 'MEETING_PROPOSED',
      digestTimezone: 'America/New_York',
      voicePrompt: 'You are Joshua Osborn, founder/CEO. I am the CEO.',
    });
    assert.match(draft, /wednesday.*1-3pm|appreciate you throwing times/i);
    assert.doesNotMatch(draft, /happy to jump on a quick call/i);
    assert.doesNotMatch(draft, /mid-morning or .+ early afternoon/i);
  });

  it('bare INTERESTED still uses times-first last-resort template', () => {
    const draft = fallbackDraftText({
      leadName: 'Dean',
      inboundMessage: 'Sure',
      classification: 'INTERESTED',
      digestTimezone: 'America/Chicago',
      voicePrompt: '',
    });
    assert.match(draft, /quick call/i);
  });
});
