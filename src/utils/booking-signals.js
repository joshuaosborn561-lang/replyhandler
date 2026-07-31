/**
 * Did the prospect already move the meeting forward on their own?
 *
 * Used to suppress an automated follow-up. Recall matters more than precision
 * here in one direction only: nudging someone who just booked is worse than
 * missing a nudge, so these patterns lean toward matching.
 */

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** They say they have booked / scheduled / accepted. */
function looksLikeAlreadyBooked(text) {
  const s = norm(text);
  if (!s) return false;
  if (/\b(just|i|we)\s+(booked|scheduled|grabbed|picked|reserved)\b/.test(s)) return true;
  if (/\b(booked|scheduled)\s+(a\s+)?(time|call|slot|meeting|something)\b/.test(s)) return true;
  if (/\bput (something|time|a hold|it) on (your|the|our) (calendar|cal)\b/.test(s)) return true;
  if (/\b(calendar invite|invite) (is )?(sent|accepted|on its way)\b/.test(s)) return true;
  if (/\baccepted (the|your) (invite|invitation|meeting)\b/.test(s)) return true;
  if (/\bsee you (on|at|then|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/.test(s)) return true;
  if (/\b(all set|we'?re set|set for)\b/.test(s) && /\b(call|meeting|time|monday|tuesday|wednesday|thursday|friday)\b/.test(s)) return true;
  if (/\bgot (it|something) on the books\b/.test(s)) return true;
  if (/\bon the books\b/.test(s)) return true;
  return false;
}

/** They propose or accept a specific time. */
function looksLikeProposedTime(text) {
  const s = norm(text);
  if (!s) return false;

  const day = /\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b/;
  const clock = /\b(1[0-2]|0?[1-9])(:[0-5][0-9])?\s*(am|pm)\b/;
  const vagueTime = /\b(morning|afternoon|evening|noon|midday|eod|cob)\b/;

  // "how about Tuesday", "does 2pm work", "Tuesday at 10 works"
  if ((day.test(s) || clock.test(s) || vagueTime.test(s)) && /\b(work|works|good|fine|free|available|open|ok|okay|suits?)\b/.test(s)) return true;
  if (/\b(how about|what about|does|can we do|let'?s do|how'?s)\b/.test(s) && (day.test(s) || clock.test(s) || vagueTime.test(s))) return true;
  if (/\b(i'?m|i am|we'?re|we are)\s+(free|available|open)\b/.test(s)) return true;
  if (/\b(send|shoot) (me|over) (an|a) invite\b/.test(s)) return true;
  if (/\bworks for me\b/.test(s)) return true;
  if (/\b(either|both) (of those|times|work)\b/.test(s)) return true;

  return false;
}

/**
 * Single gate for the follow-up runner. Returns a reason string when the
 * follow-up should be suppressed, or null when it should go ahead.
 */
function replySuppressesFollowUp(text) {
  if (looksLikeAlreadyBooked(text)) return 'prospect_says_booked';
  if (looksLikeProposedTime(text)) return 'prospect_proposed_time';
  return null;
}

module.exports = {
  looksLikeAlreadyBooked,
  looksLikeProposedTime,
  replySuppressesFollowUp,
};
