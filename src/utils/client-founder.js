/**
 * Best-effort first name of the client's founder/CEO for "loop in client"
 * follow-up copy. Driven by voice_prompt / known callback identity — there
 * is no dedicated column. Returns null when we should say "our founder"
 * rather than guess.
 *
 * Josh / Joshua are never returned: follow-ups must not wait on him.
 */

const PRINCIPAL_FIRST = /^(josh|joshua)$/i;

function firstName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const first = s.split(' ')[0];
  if (!first || first.length < 2 || first.length > 24) return null;
  if (PRINCIPAL_FIRST.test(first)) return null;
  if (!/^[A-Z][\p{L}'’-]*$/u.test(first)) return null;
  return first;
}

function clientFounderName({ voicePrompt, clientName } = {}) {
  const { prefersCallbackCall, DEEP_ROOTS_CALLER } = require('./meeting-modality');
  if (prefersCallbackCall(voicePrompt, clientName)) {
    return firstName(DEEP_ROOTS_CALLER) || DEEP_ROOTS_CALLER;
  }

  const s = String(voicePrompt || '');
  if (!s.trim()) return null;

  const patterns = [
    /\b(?:founder|ceo|owner|president)\s+(?:is\s+)?([A-Z][\p{L}'’-]*)/u,
    /\b([A-Z][\p{L}'’-]*)\s+is\s+(?:the\s+)?(?:founder|ceo|owner|president)/iu,
    /\b([A-Z][\p{L}'’-]*)\s+will\s+(?:call|stop by|meet|come by|swing by)/u,
    /\bYou are ([A-Z][\p{L}'’-]*)\b/u,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const name = firstName(m[1]);
    if (name) return name;
  }
  return null;
}

function clientFounderLabel(opts) {
  return clientFounderName(opts) || 'our founder';
}

module.exports = {
  clientFounderName,
  clientFounderLabel,
};
