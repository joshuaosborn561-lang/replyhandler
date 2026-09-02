/**
 * Post-draft guard for Josh-as-CEO clients: never ship Cayden/SDR handoff voice.
 */

const HANDOFF_RE =
  /\b(our\s+ceo|our\s+founder|with\s+our\s+ceo|with\s+our\s+founder|chat\s+with\s+our\s+ceo|call\s+with\s+our\s+ceo|hand\s+you\s+off|founder\s+josh)\b/i;

function hasPrincipalHandoffLeak(text) {
  return HANDOFF_RE.test(String(text || ''));
}

/** Best-effort rewrite — swap handoff phrases for first-person. */
function scrubPrincipalHandoff(text) {
  let s = String(text || '');
  if (!s) return s;
  s = s.replace(/\b(?:a\s+)?quick\s+call\s+with\s+our\s+ceo\b/gi, 'a quick call with me');
  s = s.replace(/\b(?:a\s+)?quick\s+call\s+with\s+our\s+founder\b/gi, 'a quick call with me');
  s = s.replace(/\bcall\s+with\s+our\s+ceo\b/gi, 'call with me');
  s = s.replace(/\bcall\s+with\s+our\s+founder\b/gi, 'call with me');
  s = s.replace(/\bchat\s+with\s+our\s+ceo\b/gi, 'chat with me');
  s = s.replace(/\bchat\s+with\s+our\s+founder\b/gi, 'chat with me');
  s = s.replace(/\bour\s+founder\s+has\b/gi, 'I have');
  s = s.replace(/\bour\s+ceo\s+has\b/gi, 'I have');
  s = s.replace(/\bwith\s+our\s+founder\s+Josh\b/gi, 'with me');
  s = s.replace(/\bwith\s+our\s+founder\b/gi, 'with me');
  s = s.replace(/\bwith\s+our\s+ceo\b/gi, 'with me');
  s = s.replace(/\bour\s+founder\b/gi, 'I');
  s = s.replace(/\bour\s+ceo\b/gi, 'I');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function enforcePrincipalVoice(text, { asPrincipal } = {}) {
  if (!asPrincipal) return { text: String(text || ''), scrubbed: false };
  const original = String(text || '');
  if (!hasPrincipalHandoffLeak(original)) return { text: original, scrubbed: false };
  const scrubbed = scrubPrincipalHandoff(original);
  return { text: scrubbed, scrubbed: scrubbed !== original };
}

module.exports = {
  hasPrincipalHandoffLeak,
  scrubPrincipalHandoff,
  enforcePrincipalVoice,
};
