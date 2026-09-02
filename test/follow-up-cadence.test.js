const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { outboundProposesMeeting } = require('../src/utils/outbound-meeting-propose');

describe('outboundProposesMeeting', () => {
  it('detects Calendly / book-for-you', () => {
    assert.equal(outboundProposesMeeting(
      'Hey Doug — just left you a VM. Can I send you a Calendly link or would you prefer me to book for you?'
    ), true);
  });

  it('detects times-first meeting ask', () => {
    assert.equal(outboundProposesMeeting(
      'Would Thursday mid-morning or Friday early afternoon work for a quick call with our CEO? If neither works I can send a booking link.'
    ), true);
  });

  it('ignores ticket-only / soft replies', () => {
    assert.equal(outboundProposesMeeting(
      'Thanks — tickets are yours either way, no strings attached.'
    ), false);
    assert.equal(outboundProposesMeeting('Got it, appreciate the reply.'), false);
  });
});

describe('followUpCadenceHours', () => {
  const prev = { ...process.env };

  beforeEach(() => {
    delete process.env.FOLLOW_UP_HOURS;
    delete process.env.FOLLOW_UP_REMINDER_HOURS;
    delete require.cache[require.resolve('../src/services/outbound-follow-up')];
  });

  afterEach(() => {
    process.env.FOLLOW_UP_HOURS = prev.FOLLOW_UP_HOURS;
    process.env.FOLLOW_UP_REMINDER_HOURS = prev.FOLLOW_UP_REMINDER_HOURS;
    delete require.cache[require.resolve('../src/services/outbound-follow-up')];
  });

  it('defaults to 2h → 24h → 48h → 1 week', () => {
    const { followUpCadenceHours, DEFAULT_CADENCE } = require('../src/services/outbound-follow-up');
    assert.deepEqual(followUpCadenceHours(), [2, 24, 48, 168]);
    assert.deepEqual(DEFAULT_CADENCE, [2, 24, 48, 168]);
  });

  it('parses comma-separated override', () => {
    process.env.FOLLOW_UP_HOURS = '2, 24, 48';
    delete require.cache[require.resolve('../src/services/outbound-follow-up')];
    const { followUpCadenceHours } = require('../src/services/outbound-follow-up');
    assert.deepEqual(followUpCadenceHours(), [2, 24, 48]);
  });
});
