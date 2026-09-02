const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hasPrincipalHandoffLeak,
  scrubPrincipalHandoff,
  enforcePrincipalVoice,
} = require('../src/utils/principal-draft-guard');
const { slackChannelSuppressionReason } = require('../src/utils/slack-channel-policy');

describe('principal handoff scrub', () => {
  it('detects our CEO / founder leaks', () => {
    assert.equal(hasPrincipalHandoffLeak('quick call with our CEO'), true);
    assert.equal(hasPrincipalHandoffLeak('Our founder has limited hours'), true);
    assert.equal(hasPrincipalHandoffLeak('quick call with me'), false);
  });

  it('rewrites handoff to first person', () => {
    const out = scrubPrincipalHandoff(
      'Our founder has limited hours this week. Are you able to do a quick call with our CEO?'
    );
    assert.match(out, /\bI have limited hours\b/i);
    assert.match(out, /quick call with me/i);
    assert.doesNotMatch(out, /our CEO|our founder/i);
  });

  it('only scrubs when asPrincipal', () => {
    const leak = 'chat with our CEO tomorrow';
    assert.equal(enforcePrincipalVoice(leak, { asPrincipal: false }).scrubbed, false);
    assert.equal(enforcePrincipalVoice(leak, { asPrincipal: true }).scrubbed, true);
  });
});

describe('interested-only slack channel', () => {
  it('keeps positives and drops declines/OOO/other', () => {
    assert.equal(slackChannelSuppressionReason({ classification: 'INTERESTED' }), null);
    assert.equal(slackChannelSuppressionReason({ classification: 'QUESTION' }), null);
    assert.equal(slackChannelSuppressionReason({ classification: 'MEETING_PROPOSED' }), null);
    assert.equal(slackChannelSuppressionReason({ classification: 'NOT_INTERESTED' }), 'not_interested');
    assert.equal(slackChannelSuppressionReason({ classification: 'OOO' }), 'ooo');
    assert.equal(slackChannelSuppressionReason({ classification: 'OTHER' }), 'not_interested_channel');
  });
});
