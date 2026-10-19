/**
 * Asking for our contact info is INTERESTED, not OTHER.
 *
 * Shawn Formont ("Send me your contact information") after a tickets offer
 * was Gemini/Jev OTHER, then the interested-only Slack gate suppressed it.
 * That is a live thread — they are asking how to reach us.
 */

function normWs(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looksLikeContactInfoAsk(text) {
  const s = normWs(text);
  if (!s) return false;
  if (/\b(don'?t|do not) (contact|email|call|text)\b/.test(s)) return false;
  if (/\bplease (reach|contact)\b/.test(s) && /\binstead\b/.test(s)) return false;
  if (/\bwrong person\b/.test(s)) return false;
  if (/\bno longer (employed|with|works?)\b/.test(s)) return false;

  if (/\bsend me your (contact information|contact info|contact details|contact|phone|cell|email|number)\b/.test(s)) {
    return true;
  }
  if (/\bsend (over )?your (contact information|contact info|contact details|phone|cell|email|number)\b/.test(s)) {
    return true;
  }
  if (/\b(what('?s| is)|whats) your (contact information|contact info|phone|cell|email|number)\b/.test(s)) {
    return true;
  }
  if (/\b(can|could) (i|you) (have|get|send) (me )?(your )?(contact information|contact info|phone|cell|email|number)\b/.test(s)) {
    return true;
  }
  if (/\bgive me your (contact information|contact info|phone|cell|email|number)\b/.test(s)) {
    return true;
  }
  if (/\bhow (can|do) i (reach|contact) you\b/.test(s)) return true;
  if (/\byour contact information\b/.test(s) && /\b(send|share|need|want|email|text)\b/.test(s)) {
    return true;
  }
  return false;
}

const KEEP = new Set([
  'INTERESTED',
  'MEETING_PROPOSED',
  'QUESTION',
  'OOO',
  'OUT_OF_OFFICE',
  'REMOVE_ME',
]);

/**
 * Force INTERESTED when they ask for our contact info, unless the label is
 * already a Slack positive or a hard silence (OOO / unsubscribe).
 */
function applyContactInfoInterest(classification, inboundMessage) {
  if (!looksLikeContactInfoAsk(inboundMessage)) return classification;
  const c = String(classification || '').toUpperCase();
  if (KEEP.has(c)) return classification;
  return 'INTERESTED';
}

module.exports = {
  looksLikeContactInfoAsk,
  applyContactInfoInterest,
};
