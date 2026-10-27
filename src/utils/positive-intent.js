/**
 * Phrase guard: replies that plainly ask for a call / more info must never be
 * hidden as OTHER or NOT_INTERESTED by a classifier miss.
 */

const { humanTextForClassification } = require('./smartlead-webhook-helpers');

const MEETING_RE = [
  /\b(let me know|send( me)?|share|suggest|propose|give me)\b[^.?!]{0,40}\b(a few|a couple( of)?|some)?\s*(days?|times?|slots?)\b/i,
  /\b(set up|schedule|book|hop on|jump on|have|get on)\b[^.?!]{0,20}\b(a |quick )?(call|meeting|chat|zoom|teams)\b/i,
  /\bwhat (times?|days?) (work|are you free|do you have)\b/i,
  /\bare you (free|available)\b/i,
];

const INTEREST_RE = [
  /\b(i'?d|i would|i am|i'?m|we'?d|we would|we are|we'?re)\b[^.?!]{0,15}\b(be )?(interested|happy|glad|open) (in|to)\b[^.?!]{0,25}\b(hear|learn|know|talk|chat|discuss|more)/i,
  /\binterested in (hearing|learning) more\b/i,
  /\b(sounds|seems|looks)\b[^.?!]{0,20}\b(worthwhile|interesting|good|great)\b/i,
  /\btell me more\b/i,
];

const NEGATION_RE = /\b(not interested|no thanks|no thank you|unsubscribe|remove me|stop emailing|not a fit|pass on this)\b/i;

/** @returns {'INTERESTED'|null} (asks for a call are drafted as INTERESTED) */
function positiveIntentFromText(text) {
  const t = String(text || '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  if (!t || NEGATION_RE.test(t)) return null;
  if (MEETING_RE.some((re) => re.test(t))) return 'INTERESTED';
  if (INTEREST_RE.some((re) => re.test(t))) return 'INTERESTED';
  return null;
}

/** Only upgrades soft/negative labels; never downgrades a positive one. */
const OVERRIDABLE = new Set(['OTHER', 'NOT_INTERESTED', 'OBJECTION', '']);

function applyPositiveIntentGuard(classification, text) {
  const c = String(classification || '').toUpperCase();
  if (!OVERRIDABLE.has(c)) return { classification, overridden: false };
  // A disclaimer footer is not the prospect. An empty human remainder
  // must not be upgraded off phrases that live only in that footer.
  const human = humanTextForClassification(text);
  if (!String(human || '').trim()) return { classification, overridden: false };
  const hit = positiveIntentFromText(human);
  if (!hit) return { classification, overridden: false };
  return { classification: hit, overridden: true, from: c || null };
}

module.exports = { positiveIntentFromText, applyPositiveIntentGuard };
