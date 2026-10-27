/**
 * CALL_NOW_TEST: 1-week test (Josh, 2026-10-21). When enrichment finds a
 * Veriphone-confirmed MOBILE number for a positive reply that already has a
 * draft, replace the draft with "Hey {FirstName}, calling you now." so the
 * caller can ring them. Approval stays a button click; nothing auto-sends.
 *
 * Env:
 *   CALL_NOW_TEST=true             enable
 *   CALL_NOW_TEST_START=<ISO>      only replies created at/after this time
 *   CALL_NOW_TEST_END=<ISO>        optional hard stop (default start + 7 days)
 */
const CALL_NOW_VARIANT = 'call_now_v1';
const POSITIVE = new Set(['INTERESTED', 'MEETING_PROPOSED']);

function firstNameOf(name) {
  const s = String(name || '').trim().split(/\s+/)[0] || '';
  const clean = s.replace(/[^\p{L}'-]/gu, '');
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** The follow-up card sequence makes "calling you now" the standing Day 0 reply. */
function sequenceOn(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.FOLLOWUP_SEQUENCE_ENABLED || '').trim());
}

function callNowWindow(env = process.env) {
  if (sequenceOn(env)) {
    const start = env.FOLLOWUP_SEQUENCE_START ? new Date(env.FOLLOWUP_SEQUENCE_START) : new Date(0);
    return { start: Number.isNaN(start.getTime()) ? new Date(0) : start, end: new Date(8.64e15) };
  }
  if (String(env.CALL_NOW_TEST || '').toLowerCase() !== 'true') return null;
  const start = env.CALL_NOW_TEST_START ? new Date(env.CALL_NOW_TEST_START) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const end = env.CALL_NOW_TEST_END
    ? new Date(env.CALL_NOW_TEST_END)
    : new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  return { start, end };
}

/** Returns the call-now draft text, or null when the variant does not apply. */
function callNowDraft({ mobilePhone, classification, draft, status, leadName, createdAt, leadTimezone, now }, env = process.env) {
  const win = callNowWindow(env);
  if (!win || !mobilePhone || !draft) return null;
  if (!POSITIVE.has(String(classification || '').toUpperCase())) return null;
  if (status && status !== 'pending') return null;
  const at = createdAt ? new Date(createdAt) : new Date();
  if (at < win.start || at >= win.end) return null;
  if (sequenceOn(env)) {
    // Only say "calling you now" when a call can actually go out: lead's local call hours.
    const time = require('./followup-sequence-time');
    const tz = time.resolveTimeZone(leadTimezone);
    if (!time.inCallWindow(now || new Date(), tz, env)) return null;
  }
  const first = firstNameOf(leadName);
  if (!first) return null;
  return `Hey ${first}, calling you now.`;
}

module.exports = { sequenceOn, callNowDraft, callNowWindow, firstNameOf, CALL_NOW_VARIANT };
