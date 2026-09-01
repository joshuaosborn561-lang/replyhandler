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

  it('defaults to later steps 24h → 48h → 1 week (clock first)', () => {
    const {
      followUpCadenceHours,
      DEFAULT_CADENCE,
      DEFAULT_LATER_CADENCE_HOURS,
      usesClockFirstStep,
    } = require('../src/services/outbound-follow-up');
    assert.equal(usesClockFirstStep(), true);
    assert.deepEqual(followUpCadenceHours(), [24, 48, 168]);
    assert.deepEqual(DEFAULT_LATER_CADENCE_HOURS, [24, 48, 168]);
    assert.deepEqual(DEFAULT_CADENCE, [24, 48, 168]);
  });

  it('parses comma-separated override (disables clock first)', () => {
    process.env.FOLLOW_UP_HOURS = '2, 24, 48';
    delete require.cache[require.resolve('../src/services/outbound-follow-up')];
    const { followUpCadenceHours, usesClockFirstStep } = require('../src/services/outbound-follow-up');
    assert.equal(usesClockFirstStep(), false);
    assert.deepEqual(followUpCadenceHours(), [2, 24, 48]);
  });
});

describe('firstFollowUpDueAt', () => {
  beforeEach(() => {
    delete process.env.FOLLOW_UP_HOURS;
    delete process.env.FOLLOW_UP_REMINDER_HOURS;
    delete require.cache[require.resolve('../src/services/outbound-follow-up')];
  });

  function chicagoParts(date) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(date)
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value])
    );
    return {
      y: parts.year,
      m: parts.month,
      d: parts.day,
      h: parseInt(parts.hour, 10),
      min: parseInt(parts.minute, 10),
    };
  }

  it('same-day 3:30pm CT when inbound is before 2pm CT', () => {
    const {
      firstFollowUpDueAt,
      zonedWallTimeToUtc,
    } = require('../src/services/outbound-follow-up');
    // 2026-01-15 10:00 America/Chicago (CST = UTC-6)
    const inbound = zonedWallTimeToUtc(2026, 1, 15, 10, 0);
    const now = zonedWallTimeToUtc(2026, 1, 15, 11, 0);
    const due = firstFollowUpDueAt(inbound, now);
    const p = chicagoParts(due);
    assert.equal(p.y, '2026');
    assert.equal(p.m, '01');
    assert.equal(p.d, '15');
    assert.equal(p.h, 15);
    assert.equal(p.min, 30);
  });

  it('next-day 3:30pm CT when inbound is at/after 2pm CT', () => {
    const {
      firstFollowUpDueAt,
      zonedWallTimeToUtc,
    } = require('../src/services/outbound-follow-up');
    const inbound = zonedWallTimeToUtc(2026, 1, 15, 14, 0);
    const now = zonedWallTimeToUtc(2026, 1, 15, 14, 30);
    const due = firstFollowUpDueAt(inbound, now);
    const p = chicagoParts(due);
    assert.equal(p.y, '2026');
    assert.equal(p.m, '01');
    assert.equal(p.d, '16');
    assert.equal(p.h, 15);
    assert.equal(p.min, 30);
  });

  it('rolls forward when same-day 3:30 is already past at schedule time', () => {
    const {
      firstFollowUpDueAt,
      zonedWallTimeToUtc,
    } = require('../src/services/outbound-follow-up');
    const inbound = zonedWallTimeToUtc(2026, 1, 15, 9, 0);
    const now = zonedWallTimeToUtc(2026, 1, 15, 16, 0); // after 3:30
    const due = firstFollowUpDueAt(inbound, now);
    const p = chicagoParts(due);
    assert.equal(p.d, '16');
    assert.equal(p.h, 15);
    assert.equal(p.min, 30);
  });

  it('handles CDT (summer) correctly', () => {
    const {
      firstFollowUpDueAt,
      zonedWallTimeToUtc,
    } = require('../src/services/outbound-follow-up');
    // 2026-07-15 is CDT (UTC-5)
    const inbound = zonedWallTimeToUtc(2026, 7, 15, 11, 0);
    const now = zonedWallTimeToUtc(2026, 7, 15, 12, 0);
    const due = firstFollowUpDueAt(inbound, now);
    const p = chicagoParts(due);
    assert.equal(p.m, '07');
    assert.equal(p.d, '15');
    assert.equal(p.h, 15);
    assert.equal(p.min, 30);
    // 3:30pm CDT = 20:30 UTC
    assert.equal(due.toISOString(), '2026-07-15T20:30:00.000Z');
  });

  it('buildCadenceSteps puts clock first then 24/48/168 from send', () => {
    const {
      buildCadenceSteps,
      zonedWallTimeToUtc,
    } = require('../src/services/outbound-follow-up');
    const inbound = zonedWallTimeToUtc(2026, 1, 15, 10, 0);
    const sent = zonedWallTimeToUtc(2026, 1, 15, 11, 0);
    const steps = buildCadenceSteps(sent, inbound);
    assert.equal(steps.length, 4);
    const first = chicagoParts(steps[0].due);
    assert.equal(first.h, 15);
    assert.equal(first.min, 30);
    assert.equal(steps[1].sequenceHours, 24);
    assert.equal(steps[2].sequenceHours, 48);
    assert.equal(steps[3].sequenceHours, 168);
    assert.equal(steps[1].due.getTime(), sent.getTime() + 24 * 3600 * 1000);
  });
});
