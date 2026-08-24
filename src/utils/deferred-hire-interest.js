/**
 * Ticket-yes + "wait until the new hire is onboard" is still INTERESTED.
 *
 * Sports-offer replies like Chris Catignani's (send the tickets here; meeting
 * after a CIO is hired) were landing as OTHER / OBJECTION / WRONG_PERSON and
 * getting silenced by the interested-only Slack gate.
 */

function normWs(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looksLikeOfferAccept(s) {
  if (/\b(don'?t|do not|no need to) send\b/.test(s)) return false;
  if (/\b(tickets|tix)\b/.test(s) && /\bvia this email\b/.test(s)) return true;
  if (/\byou can send\b/.test(s) && /\b(tickets|tix|them)\b/.test(s)) return true;
  if (/\b(send|sending) (the |those |me )?(tickets|tix)\b/.test(s)) return true;
  if (/\b(i('ll| will)? take|want) (the |those )?(tickets|tix)\b/.test(s)) return true;
  return false;
}

function looksLikeHireDeferral(s) {
  if (/\b(process of )?hiring a (cio|cto|ciso|cfo|coo|vp|vice president|director|chief)\b/.test(s)) {
    return true;
  }
  if (
    /\bwait until\b/.test(s)
    && /\b(on ?board|hired|starts?|in (the )?role|in (the )?seat)\b/.test(s)
  ) {
    return true;
  }
  if (/\buntil (they|he|she|the new \w+) (is|are) (on ?board|hired)\b/.test(s)) {
    return true;
  }
  return false;
}

/**
 * Prospect accepted the gift/offer but wants to delay the meeting until a
 * new exec is hired / onboard.
 */
function looksLikeDeferredHireInterest(text) {
  const s = normWs(text);
  if (!s) return false;
  return looksLikeOfferAccept(s) && looksLikeHireDeferral(s);
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
 * Force INTERESTED when the deferred-hire pattern matches, unless the label is
 * already a positive or a hard silence (OOO / unsubscribe).
 */
function applyDeferredHireInterest(classification, inboundMessage) {
  if (!looksLikeDeferredHireInterest(inboundMessage)) return classification;
  const c = String(classification || '').toUpperCase();
  if (KEEP.has(c)) return classification;
  return 'INTERESTED';
}

module.exports = {
  looksLikeDeferredHireInterest,
  applyDeferredHireInterest,
};
