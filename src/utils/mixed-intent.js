/**
 * Mixed / conditional inbound replies.
 *
 * SmartLead often labels the whole message "Not Interested" when the opening
 * is a deferral ("let's hold off for now") even if the rest of the body is a
 * question or interest. Those are conversations, not drops.
 */

function normWs(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

const HOLD_OFF_RE = [
  /\blet'?s hold off\b/i,
  /\bhold off for now\b/i,
  /\bhold off\b/i,
  /\bnot right now\b/i,
  /\bmaybe later\b/i,
  /\bnot at this time\b/i,
  /\bnot (a priority|the (right )?time)\b/i,
  /\b(pause|park|table|shelve) (this|it|for now)\b/i,
  /\brevisit later\b/i,
  /\bcheck back (later|in)\b/i,
  /\bcircle back later\b/i,
  /\bdown the road\b/i,
  /\bnot this (quarter|month|week|year)\b/i,
  /\bput a pin in\b/i,
  /\blet'?s wait\b/i,
  /\bfor now\b/i,
];

const CONTINUE_RE = [
  /\?/,
  /\b(can|could|would|will) you\b/i,
  /\b(tell|send) me\b/i,
  /\b(i'?m |i am )?curious\b/i,
  /\b(pricing|price list|how does (this|it) work|tell me more)\b/i,
  /\bi'?d like to (know|understand|hear|learn)\b/i,
  /\bcan we (still|talk|chat|discuss)\b/i,
  /\bwhat(?:'s| is) (your|the)\b/i,
  /\b(how|when|why|where) (do|does|would|could|can|is|are)\b/i,
];

function looksLikeHoldOff(text) {
  const s = normWs(text);
  if (!s) return false;
  return HOLD_OFF_RE.some((re) => re.test(s));
}

function looksLikeConversationContinue(text) {
  const s = normWs(text);
  if (!s) return false;
  if (/\binterested in\b/i.test(s) && !/\bnot interested\b/i.test(s)) return true;
  return CONTINUE_RE.some((re) => re.test(s));
}

/**
 * Opening (or embedded) deferral plus a later question / interest.
 * A bare "let's hold off for now. Thanks." is not mixed.
 */
function looksLikeMixedIntent(text) {
  const s = normWs(text);
  if (!s) return false;
  const deferred = looksLikeHoldOff(s) || /\bnot interested\b/i.test(s);
  if (!deferred) return false;
  return looksLikeConversationContinue(s);
}

const SLACK_POSITIVES = new Set(['INTERESTED', 'MEETING_PROPOSED', 'QUESTION']);

/**
 * Mixed bodies are a conversation. Keep a body-positive label; otherwise
 * surface as QUESTION so the interested-only Slack gate still posts a card.
 */
function promoteMixedIntent(classification, inboundMessage) {
  if (!looksLikeMixedIntent(inboundMessage)) {
    return String(classification || '').toUpperCase() || classification;
  }
  const c = String(classification || '').toUpperCase();
  if (SLACK_POSITIVES.has(c)) return c;
  return 'QUESTION';
}

module.exports = {
  looksLikeHoldOff,
  looksLikeConversationContinue,
  looksLikeMixedIntent,
  promoteMixedIntent,
  SLACK_POSITIVES,
};
