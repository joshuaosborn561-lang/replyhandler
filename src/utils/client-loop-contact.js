/**
 * Person we loop in for collateral (deck / one-pager / "send info").
 *
 * First name comes from `clients.voice_prompt`. Never defaults to "founder".
 * Never returns Josh. The spoken line is "{Name} from our side" — no title.
 *
 * Example: "looping in Miles from our side"
 */

const PRINCIPAL_FIRST = /^(josh|joshua)$/i;

function firstName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim()
    .replace(/\s+from our side\s*$/i, '');
  if (!s) return null;
  const first = s.split(/[\s,]/)[0];
  if (!first || first.length < 2 || first.length > 24) return null;
  if (PRINCIPAL_FIRST.test(first)) return null;
  if (!/^[A-Z][\p{L}'’-]*$/u.test(first)) return null;
  return first;
}

function parseFromVoicePrompt(voicePrompt) {
  const s = String(voicePrompt || '');
  if (!s.trim()) return null;

  const patterns = [
    /\bloop(?:ing)?\s+in\s+([A-Z][\p{L}'’-]*)\b/iu,
    /\bloop(?:ing)?\s+([A-Z][\p{L}'’-]*)\s+in\b/iu,
    /\b([A-Z][\p{L}'’-]*)\s+from our side\b/iu,
    /\b([A-Z][\p{L}'’-]*)\s+is\s+(?:our|the)\s+/iu,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const name = firstName(m[1]);
    if (name) return name;
  }
  return null;
}

function clientLoopContact({ voicePrompt, clientName, loopContact } = {}) {
  if (loopContact) {
    const name = firstName(loopContact.firstName || loopContact.phrase || loopContact);
    if (name) return { firstName: name };
  }

  const fromPrompt = parseFromVoicePrompt(voicePrompt);
  if (fromPrompt) return { firstName: fromPrompt };

  const { prefersCallbackCall, DEEP_ROOTS_CALLER } = require('./meeting-modality');
  if (prefersCallbackCall(voicePrompt, clientName)) {
    const name = firstName(DEEP_ROOTS_CALLER);
    if (name) return { firstName: name };
  }

  return { firstName: null };
}

function clientLoopContactPhrase(opts) {
  const hit = clientLoopContact(opts);
  if (!hit.firstName) return null;
  return `${hit.firstName} from our side`;
}

function rewriteLoopInCopy(text, replacement) {
  const name = firstName(replacement);
  if (!name) return String(text || '');
  const phrase = `${name} from our side`;
  const nameRe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let s = String(text || '');
  s = s.replace(
    /\bloop(?:ing)?\s+in\s+(?:our\s+|the\s+)?(?:founder(?:\/ceo)?|ceo)\b/gi,
    `looping in ${phrase}`
  );
  s = s.replace(/\b(?:our\s+|the\s+)?founder(?:\/ceo)?\b/gi, phrase);
  s = s.replace(
    new RegExp(`\\bloop(?:ing)?\\s+in\\s+${nameRe}\\s*,\\s*(?:our|the)\\s+[^.,\\n]+,?`, 'gi'),
    `looping in ${phrase}`
  );
  s = s.replace(
    new RegExp(`\\bloop(?:ing)?\\s+in\\s+${nameRe}\\b(?!\\s+from our side)`, 'gi'),
    `looping in ${phrase}`
  );
  return s.replace(/\s{2,}/g, ' ').trim();
}

module.exports = {
  clientLoopContact,
  clientLoopContactPhrase,
  rewriteLoopInCopy,
  rewriteFounderLoopIn: rewriteLoopInCopy,
};
