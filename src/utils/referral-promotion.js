/**
 * Referral promotion. A name with no email stays on the old path: OTHER can
 * become INTERESTED, and a Not Interested / wrong-person label stays silent.
 * An email the prospect actually typed for that person is a card, including
 * when SmartLead stamped Not Interested or Wrong Person.
 */

const { looksLikeReferral } = require('./reply-all');
const {
  looksLikeAutomatedNotice,
  slackSuppressionReason,
  humanTextForClassification,
} = require('./smartlead-webhook-helpers');
const { extractReferredContacts } = require('./referred-contact');

const DRAFT_ALWAYS = new Set(['INTERESTED', 'MEETING_PROPOSED', 'QUESTION']);

function promoteReferral(classification, inboundMessage, opts) {
  // Webhook call stays promoteReferral(classification, inboundEffective) so
  // the automated-notice order guard can find it. Opts for that call are
  // set on the function for the duration of the synchronous call.
  const use = opts == null ? (promoteReferral.opts || {}) : opts;
  const c = String(classification || '').toUpperCase();
  const hardStop = (
    c === 'REMOVE_ME'
    || c === 'OOO'
    || c === 'OUT_OF_OFFICE'
    || c === 'AUTOMATED_NOTICE'
    || looksLikeAutomatedNotice(inboundMessage)
  );
  const human = humanTextForClassification(inboundMessage);
  const humanReason = slackSuppressionReason(human || inboundMessage);
  const textHardStop = humanReason === 'ooo'
    || humanReason === 'automated_notice'
    || humanReason === 'unsubscribe';

  const referredContacts = (hardStop || textHardStop)
    ? []
    : extractReferredContacts(inboundMessage, use);

  if (referredContacts.length) {
    const already = DRAFT_ALWAYS.has(c);
    return {
      promoted: !already,
      classification: already ? c : 'INTERESTED',
      referredContacts,
    };
  }

  if (
    DRAFT_ALWAYS.has(c)
    || c === 'REMOVE_ME'
    || c === 'OOO'
    || c === 'OUT_OF_OFFICE'
    || c === 'WRONG_PERSON'
    || c === 'NOT_INTERESTED'
    || c === 'AUTOMATED_NOTICE'
  ) {
    return { promoted: false, classification, referredContacts: [] };
  }
  if (looksLikeAutomatedNotice(inboundMessage)) {
    return { promoted: false, classification, referredContacts: [] };
  }
  const textReason = slackSuppressionReason(inboundMessage);
  if (textReason === 'wrong_person' || textReason === 'ooo' || textReason === 'automated_notice') {
    return { promoted: false, classification, referredContacts: [] };
  }
  if (!looksLikeReferral(inboundMessage)) {
    return { promoted: false, classification, referredContacts: [] };
  }
  return { promoted: true, classification: 'INTERESTED', referredContacts: [] };
}

module.exports = { promoteReferral, DRAFT_ALWAYS };
