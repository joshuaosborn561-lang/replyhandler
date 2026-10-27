'use strict';

/**
 * Words and timing for the ghosted-meeting follow-up. Pure, no I/O.
 *
 * Steps ride the follow-up card sequence (origin = 'ghosted_meeting'):
 *   ghost_email    Day 0  "looks like we missed each other" + two live times
 *   ghost_call     Day 0  call card, script + voicemail
 *   ghost_call_2   Day 2  call card at the other half of the day
 *   ghost_email_2  Day 2  "new times" email
 *   ghost_breakup  Day 4  breakup email
 * Every one is a card a human clicks. Nothing claims anything not passed in.
 */

const CALL_KINDS = {
  ghost_call: { label: 'Missed meeting call', voicemail: 'ghost' },
  ghost_call_2: { label: 'Missed meeting call, second try', voicemail: 'ghost' },
};

const EMAIL_KINDS = {
  ghost_email: 'Missed meeting email',
  ghost_email_2: 'Missed meeting: new times',
  ghost_breakup: 'Missed meeting: breakup email',
};

const GHOST_KINDS = new Set([...Object.keys(CALL_KINDS), ...Object.keys(EMAIL_KINDS)]);

function isGhostKind(kind) {
  return GHOST_KINDS.has(kind);
}

function ghostCallScript({ firstName, callerName, clientName }) {
  const first = firstName || 'there';
  return `Hey ${first}, this is ${callerName} with ${clientName}. We had a meeting on the calendar and it looks like we missed each other. Do you still want to find a time to talk this week?`;
}

function ghostVoicemail({ firstName, callerName, clientName }) {
  const first = firstName || 'there';
  return `Hey ${first}, it's ${callerName} with ${clientName}. We had a meeting scheduled and I think we missed each other. I'll send you an email with a couple of new times. Just reply and we'll get it back on the calendar.`;
}

function timesLine(slots, link) {
  const labels = (slots || []).map((s) => s.label).filter(Boolean);
  const linkLine = link ? ` If easier, grab a time here: ${link}` : '';
  if (labels.length >= 2) return `Does ${labels[0]} or ${labels[1]} work instead?${linkLine}`;
  if (labels.length === 1) return `Does ${labels[0]} work instead?${linkLine}`;
  if (link) return `Grab a new time here: ${link}`;
  return null;
}

/** Email card body, or null when it cannot be written yet (needs live times and has none). */
function emailBody(kind, { firstName, slots, link, askForTimes = false } = {}) {
  const first = firstName || 'there';
  const times = timesLine(slots, link);
  switch (kind) {
    case 'ghost_email': {
      const ask = times || (askForTimes ? 'What time works to reschedule?' : null);
      if (!ask) return null;
      return `Hey ${first}, looks like we missed each other. Still want to take a peek at this?\n\n${ask}`;
    }
    case 'ghost_email_2': {
      const ask = times || (askForTimes ? 'What time works to reschedule?' : null);
      if (!ask) return null;
      return `Hey ${first}, those times got taken. Here are some new ones.\n\n${ask}`;
    }
    case 'ghost_breakup':
      return `Hey ${first}, don't want to keep emailing you. Did you still want to meet about this, or have priorities changed?`;
    default:
      return null;
  }
}

/**
 * @param {{enrolledAt: Date, timeZone: string, time: object, env?: object}} args
 *   `time` is src/utils/followup-sequence-time.
 * @returns {Array<{kind, order, due: Date, type: 'call'|'email'}>}
 */
function planGhostSequence({ enrolledAt, timeZone, time, env = process.env }) {
  const MIN = 60 * 1000;
  const tz = time.resolveTimeZone(timeZone);
  const start = enrolledAt instanceof Date ? enrolledAt : new Date(enrolledAt);
  const steps = [];

  steps.push({ kind: 'ghost_email', order: 10, type: 'email', due: start });

  // Call as soon as the lead's call window is open, after the email card is up.
  const callAt = time.nextCallWindowStart(new Date(start.getTime() + 10 * MIN), tz, env);
  steps.push({ kind: 'ghost_call', order: 20, type: 'call', due: callAt });

  // Business day 2: the other half of the day from the first call.
  const p = time.zonedParts(callAt, tz);
  const firstWasMorning = p.hour < 12;
  const d2 = time.addBusinessDays(time.rollToBusinessDay({ year: p.year, month: p.month, day: p.day }), 2);
  const call2 = time.zonedToUtc(d2.year, d2.month, d2.day, firstWasMorning ? 14 : 10, 0, tz);
  steps.push({ kind: 'ghost_call_2', order: 30, type: 'call', due: call2 });
  steps.push({ kind: 'ghost_email_2', order: 40, type: 'email', due: new Date(call2.getTime() + 30 * MIN) });

  // Business day 4: breakup email.
  const d4 = time.addBusinessDays(time.rollToBusinessDay({ year: p.year, month: p.month, day: p.day }), 4);
  steps.push({ kind: 'ghost_breakup', order: 50, type: 'email', due: time.zonedToUtc(d4.year, d4.month, d4.day, 10, 0, tz) });
  return steps;
}

module.exports = {
  CALL_KINDS,
  EMAIL_KINDS,
  isGhostKind,
  ghostCallScript,
  ghostVoicemail,
  emailBody,
  planGhostSequence,
};
