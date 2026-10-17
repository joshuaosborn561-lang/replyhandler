/**
 * Person we loop in for collateral (deck / one-pager / "send info").
 *
 * Name + title come from `clients.voice_prompt` — the per-client config.
 * Never defaults to "founder". Never returns Josh. Never invents a title.
 *
 * Example phrase: "Miles, our director of sales"
 */

const PRINCIPAL_FIRST = /^(josh|joshua)$/i;
const BANNED_TITLE = /^(founder|co-founder|ceo|co-ceo|owner|president|founder\/ceo)$/i;
const TITLE_HINT =
  /\b(director|vp|vice[-\s]?president|head|manager|partner|principal|executive|ae|sales|ops|operations|marketing|success|coordinator|lead|advisor|consultant)\b/i;

function firstName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const first = s.split(' ')[0];
  if (!first || first.length < 2 || first.length > 24) return null;
  if (PRINCIPAL_FIRST.test(first)) return null;
  if (!/^[A-Z][\p{L}'’-]*$/u.test(first)) return null;
  return first;
}

function cleanTitle(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:our|the)\s+/i, '');
  t = t.replace(/\s+(?:to send|for (?:decks?|one-pagers?|info|collateral))\b.*$/i, '').trim();
  t = t.replace(/[,;:.\s]+$/g, '').trim();
  if (!t || t.length < 3 || t.length > 48) return null;
  if (BANNED_TITLE.test(t)) return null;
  const words = t.split(/\s+/);
  if (words.length === 1 && !TITLE_HINT.test(t)) return null;
  if (!TITLE_HINT.test(t) && words.length > 6) return null;
  return t.toLowerCase();
}

function take(nameRaw, titleRaw) {
  const name = firstName(nameRaw);
  if (!name) return null;
  return { firstName: name, title: cleanTitle(titleRaw) };
}

function parseFromVoicePrompt(voicePrompt) {
  const s = String(voicePrompt || '');
  if (!s.trim()) return null;

  const patterns = [
    /\bloop(?:ing)?\s+in\s+([A-Z][\p{L}'’-]*)\s*,\s*(?:our|the)\s+([^.\n]+)/u,
    /\b([A-Z][\p{L}'’-]*)\s+is\s+(?:our|the)\s+([^.\n]+)/u,
    /\b([A-Z][\p{L}'’-]*)\s*,\s*(?:our|the)\s+([^.\n]+)/u,
    /\bloop(?:ing)?\s+in\s+([A-Z][\p{L}'’-]*)\b/u,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const hit = take(m[1], m[2]);
    if (hit) return hit;
  }
  return null;
}

function clientLoopContact({ voicePrompt, clientName, loopContact } = {}) {
  if (loopContact && (loopContact.firstName || loopContact.phrase)) {
    const name = firstName(loopContact.firstName || loopContact.phrase);
    const title = cleanTitle(loopContact.title);
    if (name) return { firstName: name, title };
  }

  const fromPrompt = parseFromVoicePrompt(voicePrompt);
  if (fromPrompt) return fromPrompt;

  const { prefersCallbackCall, DEEP_ROOTS_CALLER } = require('./meeting-modality');
  if (prefersCallbackCall(voicePrompt, clientName)) {
    const name = firstName(DEEP_ROOTS_CALLER) || null;
    if (name) return { firstName: name, title: null };
  }

  return { firstName: null, title: null };
}

function clientLoopContactPhrase(opts) {
  const hit = clientLoopContact(opts);
  if (!hit.firstName) return null;
  if (hit.title) return `${hit.firstName}, our ${hit.title}`;
  return hit.firstName;
}

function rewriteFounderLoopIn(text, replacement) {
  const phrase = String(replacement || '').trim();
  if (!phrase) return String(text || '');
  let s = String(text || '');
  s = s.replace(
    /\bloop(?:ing)?\s+in\s+(?:our\s+|the\s+)?(?:founder(?:\/ceo)?|ceo)\b/gi,
    `looping in ${phrase}`
  );
  s = s.replace(/\b(?:our\s+|the\s+)?founder(?:\/ceo)?\b/gi, phrase);
  return s.replace(/\s{2,}/g, ' ').trim();
}

module.exports = {
  clientLoopContact,
  clientLoopContactPhrase,
  rewriteFounderLoopIn,
};
