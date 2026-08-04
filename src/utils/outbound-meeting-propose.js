/**
 * Did *we* propose a meeting in the outbound we just sent?
 *
 * Follow-ups only schedule after a meeting ask (times, Calendly, "book for you"),
 * not after every approved send.
 */

const { looksLikeProposedTime } = require('./booking-signals');

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function outboundProposesMeeting(text) {
  const s = norm(text);
  if (!s) return false;

  // Explicit scheduler / booking-link language
  if (/calendly\.com|cal\.com\/|savvycal\.com|hubspot\.com\/meetings/.test(s)) return true;
  if (/\b(calendly|booking link|scheduler link)\b/.test(s)) return true;
  if (/\b(book|schedule)\s+(a\s+)?(quick\s+)?(call|meeting|time|slot|demo)\b/.test(s)) return true;
  if (/\b(book for you|book you|book it for you|i can book)\b/.test(s)) return true;
  if (/\b(send|shoot)\s+(you\s+)?(a\s+)?(calendly|booking|scheduler)?\s*link\b/.test(s)) return true;
  if (/\bgrab (a|some) time\b/.test(s)) return true;

  // Times-first ask: day/time + call framing
  const day = /\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b|\btomorrow\b/;
  const daypart = /\b(morning|afternoon|evening|noon|mid-morning|mid-afternoon)\b/;
  const call = /\b(call|meeting|chat|sync|demo|hop on|jump on|15\s*min|30\s*min)\b/;
  if ((day.test(s) || daypart.test(s)) && call.test(s)) return true;

  // Reuse prospect-side time detector — same shapes ("does Thursday work")
  if (looksLikeProposedTime(s)) return true;

  return false;
}

module.exports = { outboundProposesMeeting };
