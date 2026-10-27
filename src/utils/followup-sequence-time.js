'use strict';

/**
 * Timing for the follow-up card sequence. Pure functions, no I/O.
 *
 * Days are BUSINESS days: Mon-Fri, skipping major US holidays (New Year's Day,
 * Memorial Day, July 4, Labor Day, Thanksgiving and the day after, Christmas;
 * a fixed holiday on a weekend is observed on the nearest weekday). Call cards only come
 * due inside the lead's local business hours (default 9:00-17:00, Mon-Fri).
 * Email cards are snapped into the existing send window by the caller.
 */

const DEFAULT_TZ = 'America/Chicago';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function callHours(env = process.env) {
  const start = parseInt(env.FOLLOWUP_CALL_START_HOUR || '9', 10);
  const end = parseInt(env.FOLLOWUP_CALL_END_HOUR || '17', 10);
  if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 24 && start < end) {
    return { start, end };
  }
  return { start: 9, end: 17 };
}

function validTimeZone(tz) {
  const s = String(tz || '').trim();
  if (!s) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return s;
  } catch {
    return null;
  }
}

/** Lead tz, else the client's tz, else Central. */
function resolveTimeZone(...candidates) {
  for (const c of candidates) {
    const tz = validTimeZone(c);
    if (tz) return tz;
  }
  return DEFAULT_TZ;
}

function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
    weekday: get('weekday'),
  };
}

function isWeekend(parts) {
  return parts.weekday === 'Sat' || parts.weekday === 'Sun';
}

// ─── Major US holidays ───────────────────────────────────────────────────────

function dowOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 Sun
}

/** n-th (1-based) given weekday of a month, or the last one when n = -1. */
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = dowOf(year, month, 1);
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return lastDay - ((dowOf(year, month, lastDay) - weekday + 7) % 7);
}

/** Fixed-date holiday, observed Friday when it falls on Saturday, Monday when on Sunday. */
function observed(year, month, day) {
  const d = dowOf(year, month, day);
  const shift = d === 6 ? -1 : d === 0 ? 1 : 0;
  const o = new Date(Date.UTC(year, month - 1, day + shift));
  return { year: o.getUTCFullYear(), month: o.getUTCMonth() + 1, day: o.getUTCDate() };
}

function holidayKeys(year) {
  const k = (o) => `${o.year}-${o.month}-${o.day}`;
  const thanks = nthWeekday(year, 11, 4, 4);
  return new Set([
    k(observed(year, 1, 1)),
    k({ year, month: 5, day: nthWeekday(year, 5, 1, -1) }), // Memorial Day
    k(observed(year, 7, 4)),
    k({ year, month: 9, day: nthWeekday(year, 9, 1, 1) }), // Labor Day
    k({ year, month: 11, day: thanks }),
    k({ year, month: 11, day: thanks + 1 }),
    k(observed(year, 12, 25)),
  ]);
}

/** True for a major US holiday (observed date). `ymd` is { year, month, day }. */
function isHoliday(ymd) {
  const key = `${ymd.year}-${ymd.month}-${ymd.day}`;
  // New Year's Day on a Saturday is observed on Dec 31 of the year before.
  return holidayKeys(ymd.year).has(key) || holidayKeys(ymd.year + 1).has(key);
}

function offsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  return asUtc - Math.floor(date.getTime() / MIN) * MIN;
}

/** Wall-clock time in `tz` -> UTC Date. */
function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

function addCalendarDays(year, month, day, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function weekdayOfYmd({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 Sun
}

/** Not a business day: weekend or major US holiday. */
function isWeekendYmd(ymd) {
  const w = weekdayOfYmd(ymd);
  return w === 0 || w === 6 || isHoliday(ymd);
}

/** First business day on or after the given date. */
function rollToBusinessDay(ymd) {
  let cur = { ...ymd };
  while (isWeekendYmd(cur)) cur = addCalendarDays(cur.year, cur.month, cur.day, 1);
  return cur;
}

/** Add n business days (n >= 0). The start must already be a business day. */
function addBusinessDays(ymd, n) {
  let cur = { ...ymd };
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    cur = addCalendarDays(cur.year, cur.month, cur.day, 1);
    if (!isWeekendYmd(cur)) left -= 1;
  }
  return cur;
}

function inCallWindow(date, tz, env = process.env) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return false;
  const p = zonedParts(d, tz);
  if (isWeekend(p) || isHoliday(p)) return false;
  const { start, end } = callHours(env);
  const mins = p.hour * 60 + p.minute;
  return mins >= start * 60 && mins < end * 60;
}

/** The next moment calls are allowed: now if inside the window, else the next window open. */
function nextCallWindowStart(date, tz, env = process.env) {
  const d = date instanceof Date ? date : new Date(date);
  if (inCallWindow(d, tz, env)) return d;
  const { start } = callHours(env);
  const p = zonedParts(d, tz);
  let ymd = { year: p.year, month: p.month, day: p.day };
  const mins = p.hour * 60 + p.minute;
  if (isWeekendYmd(ymd) || mins >= start * 60) {
    ymd = rollToBusinessDay(addCalendarDays(ymd.year, ymd.month, ymd.day, 1));
  }
  return zonedToUtc(ymd.year, ymd.month, ymd.day, start, 0, tz);
}

/** Local business-day date `n` business days after `from` (rolled to a business day first). */
function businessDayAfter(from, n, tz) {
  const p = zonedParts(from, tz);
  const base = rollToBusinessDay({ year: p.year, month: p.month, day: p.day });
  return addBusinessDays(base, n);
}

function atLocal(ymd, hour, minute, tz) {
  return zonedToUtc(ymd.year, ymd.month, ymd.day, hour, minute, tz);
}

function clampIntoCallWindow(date, tz, env = process.env) {
  const { start, end } = callHours(env);
  const p = zonedParts(date, tz);
  const mins = p.hour * 60 + p.minute;
  if (mins < start * 60) return atLocal(p, start, 0, tz);
  if (mins >= end * 60) return atLocal(p, end - 1, 0, tz);
  return date;
}

/**
 * Plan every scheduled step of the sequence. Steps that depend on a click
 * (the Day 0 voicemail email) are not planned here.
 *
 * @returns {Array<{kind, order, due: Date|null, type: 'call'|'email', skip?: string}>}
 */
function planSequence({ enrolledAt, timeZone, env = process.env }) {
  const tz = resolveTimeZone(timeZone);
  const enrolled = enrolledAt instanceof Date ? enrolledAt : new Date(enrolledAt);
  const steps = [];

  // Day 0: now if inside call hours, otherwise the next window open.
  const day0Call = nextCallWindowStart(enrolled, tz, env);
  steps.push({ kind: 'call_day0', order: 10, type: 'call', due: day0Call });

  // Day 0 + 3-4h, same local business day only.
  const lateTarget = new Date(day0Call.getTime() + 3.5 * HOUR);
  let late = null;
  if (inCallWindow(lateTarget, tz, env)) {
    late = lateTarget;
  } else {
    const early = new Date(day0Call.getTime() + 3 * HOUR);
    const clamped = clampIntoCallWindow(lateTarget, tz, env);
    const sameDay = zonedParts(clamped, tz).day === zonedParts(day0Call, tz).day;
    if (sameDay && clamped.getTime() >= early.getTime() && inCallWindow(clamped, tz, env)) late = clamped;
  }
  steps.push(late
    ? { kind: 'call_day0_late', order: 20, type: 'call', due: late }
    : { kind: 'call_day0_late', order: 20, type: 'call', due: null, skip: 'outside_call_hours' });

  const day0Parts = zonedParts(day0Call, tz);
  const day0 = { year: day0Parts.year, month: day0Parts.month, day: day0Parts.day };
  const firstWasMorning = day0Parts.hour < 12;

  // Day 1: a different time of day than the Day 0 call.
  const d1 = addBusinessDays(day0, 1);
  const d1Hour = firstWasMorning ? 14 : 10;
  const call1 = atLocal(d1, d1Hour, 0, tz);
  steps.push({ kind: 'call_day1', order: 30, type: 'call', due: call1 });
  steps.push({ kind: 'email_day1', order: 40, type: 'email', due: new Date(call1.getTime() + 30 * MIN) });

  // Day 3: opposite half of the day to Day 1.
  const d3 = addBusinessDays(day0, 3);
  const call3 = d1Hour === 14 ? atLocal(d3, 10, 30, tz) : atLocal(d3, 14, 30, tz);
  steps.push({ kind: 'call_day3', order: 50, type: 'call', due: call3 });
  steps.push({ kind: 'email_proof', order: 60, type: 'email', due: new Date(call3.getTime() + 30 * MIN) });
  steps.push({ kind: 'email_thoughts', order: 70, type: 'email', due: new Date(call3.getTime() + 4 * HOUR) });

  // Day 5: breakup email. Day 6: final call.
  const d5 = addBusinessDays(day0, 5);
  steps.push({ kind: 'email_breakup', order: 80, type: 'email', due: atLocal(d5, 10, 0, tz) });
  const d6 = addBusinessDays(day0, 6);
  steps.push({ kind: 'call_day6', order: 90, type: 'call', due: atLocal(d6, 11, 0, tz) });

  return steps;
}

module.exports = {
  DEFAULT_TZ,
  callHours,
  validTimeZone,
  resolveTimeZone,
  zonedParts,
  zonedToUtc,
  addBusinessDays,
  rollToBusinessDay,
  businessDayAfter,
  isHoliday,
  inCallWindow,
  nextCallWindowStart,
  planSequence,
};
