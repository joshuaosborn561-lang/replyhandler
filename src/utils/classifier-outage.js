/**
 * Label a reply when Jev and Gemini are both unreachable.
 *
 * A 401/402 used to fall through to OTHER, which posts the unclassified
 * Slack line and never drafts. This runs for every client, email and
 * LinkedIn. Campaign replies and short answers to our outreach are still
 * conversations. Cold pitches and clear declines stay out of the draft set.
 */

const { lastOutboundFromThread } = require('../services/jev-classifier');
const {
  looksLikeOutOfOffice,
  looksLikeAutomatedNotice,
  looksLikeNotInterested,
  looksLikeWrongPerson,
  looksLikeUnsubscribe,
} = require('./smartlead-webhook-helpers');

const SHORT_REPLY_MAX = 280;

function norm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function looksLikeColdPitch(text) {
  const s = norm(text);
  if (!s) return false;
  if (/\b(talent acquisition|i hope you'?re doing well|we built|our platform|mutually beneficial|additional capital|book a (time|call) with me)\b/i.test(s)) {
    return true;
  }
  return s.length > 500 && /\b(schedule a call|my agenda|calendly)\b/i.test(s);
}

function looksLikeInfoQuestion(text, hasOutbound) {
  const s = norm(text);
  if (!s) return false;
  const explicit = /\b(can|could|would) you (please )?(send|share|tell|forward)\b/i.test(s)
    || /\b(send|share) (me )?(some |more )?(info|information|details)\b/i.test(s)
    || /\bwhat (exactly )?do you do\b/i.test(s)
    || /\bhow (does|do) (this|it|that) work\b/i.test(s)
    || /\b(more|some) info on what you do\b/i.test(s);
  const asked = /\?/.test(s);
  if (!explicit && !asked) return false;
  if (hasOutbound) return true;
  if (explicit && s.length <= 400) return true;
  return asked && s.length <= SHORT_REPLY_MAX;
}

/**
 * @returns {string|null} a classification, or null to keep OTHER
 */
function classifyDuringOutage(threadContext, inboundMessage) {
  const text = norm(inboundMessage);
  if (!text) return null;
  if (looksLikeAutomatedNotice(text)) return 'AUTOMATED_NOTICE';
  if (looksLikeOutOfOffice(text)) return 'OOO';
  if (/^(no|nope|stop|pass)[.!]?$/i.test(text)) return 'NOT_INTERESTED';
  if (looksLikeUnsubscribe(text)) return 'REMOVE_ME';
  if (looksLikeWrongPerson(text)) return 'WRONG_PERSON';
  if (looksLikeNotInterested(text)) return 'NOT_INTERESTED';
  if (looksLikeColdPitch(text)) return null;

  const hasOutbound = Boolean(lastOutboundFromThread(threadContext));
  if (looksLikeInfoQuestion(text, hasOutbound)) return 'QUESTION';
  if (hasOutbound) return 'INTERESTED';
  if (text.length <= SHORT_REPLY_MAX) return 'INTERESTED';
  return null;
}

module.exports = {
  classifyDuringOutage,
  looksLikeColdPitch,
  looksLikeInfoQuestion,
  SHORT_REPLY_MAX,
};
