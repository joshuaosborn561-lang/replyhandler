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
    // Wednesday — next day is Thursday, still before Friday's noon cutoff.
    const inbound = zonedWallTimeToUtc(2026, 1, 14, 14, 0);
    const now = zonedWallTimeToUtc(2026, 1, 14, 14, 30);
    const due = firstFollowUpDueAt(inbound, now);
    const p = chicagoParts(due);
    assert.equal(p.y, '2026');
    assert.equal(p.m, '01');
    assert.equal(p.d, '15');
    assert.equal(p.h, 15);
    assert.equal(p.min, 30);
  });

  it('rolls forward when same-day 3:30 is already past at schedule time', () => {
    const {
      firstFollowUpDueAt,
      zonedWallTimeToUtc,
    } = require('../src/services/outbound-follow-up');
    const inbound = zonedWallTimeToUtc(2026, 1, 14, 9, 0);
    const now = zonedWallTimeToUtc(2026, 1, 14, 16, 0); // after 3:30 Wednesday
    const due = firstFollowUpDueAt(inbound, now);
    const p = chicagoParts(due);
    assert.equal(p.d, '15');
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

  it('never schedules first due sooner than 2h after send', () => {
    const {
      buildCadenceSteps,
      zonedWallTimeToUtc,
      MIN_FOLLOW_UP_HOURS,
    } = require('../src/services/outbound-follow-up');
    assert.equal(MIN_FOLLOW_UP_HOURS, 2);
    // Inbound 10am → clock 3:30pm, but we send at 2:45pm → only 45m to 3:30
    const inbound = zonedWallTimeToUtc(2026, 1, 15, 10, 0);
    const sent = zonedWallTimeToUtc(2026, 1, 15, 14, 45);
    const steps = buildCadenceSteps(sent, inbound);
    const minDue = sent.getTime() + 2 * 3600 * 1000;
    assert.ok(steps[0].due.getTime() >= minDue);
    assert.equal(steps[0].due.getTime(), minDue);
    assert.ok(steps[0].sequenceHours >= 2);
  });

  it('Friday morning inbound skips Friday 3:30 (noon cutoff) and lands Monday 3:30', () => {
    const {
      firstFollowUpDueAt,
      zonedWallTimeToUtc,
    } = require('../src/services/outbound-follow-up');
    // Friday 10am would have been Friday 3:30 — after noon, so Monday.
    const inbound = zonedWallTimeToUtc(2026, 1, 16, 10, 0);
    const now = zonedWallTimeToUtc(2026, 1, 16, 10, 30);
    const due = firstFollowUpDueAt(inbound, now);
    const p = chicagoParts(due);
    assert.equal(p.d, '19');
    assert.equal(p.h, 15);
    assert.equal(p.min, 30);
  });

  it('skips Saturday/Sunday for the 3:30pm first step', () => {
    const {
      firstFollowUpDueAt,
      zonedWallTimeToUtc,
    } = require('../src/services/outbound-follow-up');
    // 2026-01-16 is Friday. After 2pm → would have been Sat 3:30; must be Mon.
    const inbound = zonedWallTimeToUtc(2026, 1, 16, 15, 0);
    const now = zonedWallTimeToUtc(2026, 1, 16, 15, 30);
    const due = firstFollowUpDueAt(inbound, now);
    const p = chicagoParts(due);
    assert.equal(p.y, '2026');
    assert.equal(p.m, '01');
    assert.equal(p.d, '19'); // Monday
    assert.equal(p.h, 15);
    assert.equal(p.min, 30);

    // Saturday morning inbound would have been Sat 3:30.
    const satIn = zonedWallTimeToUtc(2026, 1, 17, 10, 0);
    const satNow = zonedWallTimeToUtc(2026, 1, 17, 11, 0);
    const satDue = firstFollowUpDueAt(satIn, satNow);
    const satP = chicagoParts(satDue);
    assert.equal(satP.d, '19');
    assert.equal(satP.h, 15);
    assert.equal(satP.min, 30);
  });

  it('snaps night and weekend dues into weekday 8am–5pm CT', () => {
    const {
      inSendWindow,
      snapDueToSendWindow,
      zonedWallTimeToUtc,
      SEND_WINDOW_START_HOUR,
      SEND_WINDOW_END_HOUR,
    } = require('../src/services/outbound-follow-up');
    assert.equal(SEND_WINDOW_START_HOUR, 8);
    assert.equal(SEND_WINDOW_END_HOUR, 17);

    const thu1030 = zonedWallTimeToUtc(2026, 1, 15, 10, 30);
    assert.equal(inSendWindow(thu1030), true);
    assert.equal(snapDueToSendWindow(thu1030).getTime(), thu1030.getTime());

    const thu5pm = zonedWallTimeToUtc(2026, 1, 15, 17, 0);
    assert.equal(inSendWindow(thu5pm), false);
    const after5 = chicagoParts(snapDueToSendWindow(thu5pm));
    assert.equal(after5.d, '16'); // Friday 8am (before Friday noon)
    assert.equal(after5.h, 8);
    assert.equal(after5.min, 0);

    const fri11 = zonedWallTimeToUtc(2026, 1, 16, 11, 0);
    assert.equal(inSendWindow(fri11), true);
    const friNoon = zonedWallTimeToUtc(2026, 1, 16, 12, 0);
    assert.equal(inSendWindow(friNoon), false);
    const friNoonSnap = chicagoParts(snapDueToSendWindow(friNoon));
    assert.equal(friNoonSnap.d, '19'); // Monday, not Friday afternoon
    assert.equal(friNoonSnap.h, 8);
    const fri2pm = zonedWallTimeToUtc(2026, 1, 16, 14, 0);
    assert.equal(inSendWindow(fri2pm), false);
    const fri2pmSnap = chicagoParts(snapDueToSendWindow(fri2pm));
    assert.equal(fri2pmSnap.d, '19');
    assert.equal(fri2pmSnap.h, 8);

    const fri9pm = zonedWallTimeToUtc(2026, 1, 16, 21, 0);
    const friNight = chicagoParts(snapDueToSendWindow(fri9pm));
    assert.equal(friNight.d, '19'); // Monday, not Saturday
    assert.equal(friNight.h, 8);

    const sat330 = zonedWallTimeToUtc(2026, 1, 17, 15, 30);
    assert.equal(inSendWindow(sat330), false);
    const satSnap = chicagoParts(snapDueToSendWindow(sat330));
    assert.equal(satSnap.d, '19');
    assert.equal(satSnap.h, 8);

    const tue2am = zonedWallTimeToUtc(2026, 1, 13, 2, 0); // Tuesday
    const early = chicagoParts(snapDueToSendWindow(tue2am));
    assert.equal(early.d, '13');
    assert.equal(early.h, 8);
  });

  it('Friday evening send does not land any step on the weekend or after 5pm CT', () => {
    const {
      buildCadenceSteps,
      inSendWindow,
      zonedWallTimeToUtc,
    } = require('../src/services/outbound-follow-up');
    // Friday 4:30pm send, inbound Friday 3pm (after 2pm cutoff)
    const inbound = zonedWallTimeToUtc(2026, 1, 16, 15, 0);
    const sent = zonedWallTimeToUtc(2026, 1, 16, 16, 30);
    const steps = buildCadenceSteps(sent, inbound);
    assert.equal(steps.length, 4);
    const seen = new Set();
    for (const step of steps) {
      assert.equal(inSendWindow(step.due), true, `due ${step.due.toISOString()} is outside the send window`);
      assert.ok(step.due.getTime() >= sent.getTime() + 2 * 3600 * 1000);
      const key = step.due.toISOString();
      assert.equal(seen.has(key), false, 'cadence steps must not collapse onto the same instant');
      seen.add(key);
    }
    const first = chicagoParts(steps[0].due);
    assert.equal(first.d, '19');
    assert.ok(first.h < 17);
  });
});
