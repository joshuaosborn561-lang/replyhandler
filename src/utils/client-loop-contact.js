/**
 * Person we loop in for collateral (deck / one-pager / "send info").
 *
 * First name comes verbatim from `clients.voice_prompt` (or an explicit
 * loopContact). Never respell it. Never default to "founder". Never return
 * Josh. The spoken line is "looping in {Name} from our side" — no title.
 */

const PRINCIPAL_FIRST = /^(josh|joshua)$/i;
const NAME_TOKEN = String.raw`[\p{L}][\p{L}'’-]*`;

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * First name exactly as configured. Do not recapitalize or respell.
 */
function firstName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim()
    .replace(/\s+from our side\s*$/i, '');
  if (!s) return null;
  const first = s.split(/[\s,]/)[0];
  if (!first || first.length < 2 || first.length > 24) return null;
  if (PRINCIPAL_FIRST.test(first)) return null;
  if (!new RegExp(`^${NAME_TOKEN}$`, 'u').test(first)) return null;
  return first;
}

function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

function isLookalikeFirstName(token, exact) {
  if (!token || !exact || token === exact) return false;
  // Only rewrite capitalized tokens so common words ("males") stay put.
  if (!/^\p{Lu}/u.test(token)) return false;
  const a = token.toLowerCase();
  const b = exact.toLowerCase();
  if (a === b) return true;
  if (a[0] !== b[0]) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  return editDistance(a, b) <= 2;
}

function parseFromVoicePrompt(voicePrompt) {
  const s = String(voicePrompt || '');
  if (!s.trim()) return null;

  const patterns = [
    new RegExp(String.raw`\bloop(?:ing)?\s+in\s+(${NAME_TOKEN})\b`, 'iu'),
    new RegExp(String.raw`\bloop(?:ing)?\s+(${NAME_TOKEN})\s+in\b`, 'iu'),
    new RegExp(String.raw`\b(${NAME_TOKEN})\s+from our side\b`, 'iu'),
    new RegExp(String.raw`\b(${NAME_TOKEN})\s+is\s+(?:our|the)\s+`, 'iu'),
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

function loopInLine(first) {
  const name = firstName(first);
  if (!name) return null;
  return `looping in ${name} from our side`;
}

/**
 * True when the draft uses the loop-in spoken line.
 * When `firstName` is passed, the name must match character-for-character.
 */
function draftLoopsInContact(text, exactFirstName) {
  const draft = String(text || '');
  const exact = firstName(exactFirstName);
  if (exact) {
    return new RegExp(
      String.raw`\blooping in ${escapeRe(exact)} from our side\b`
    ).test(draft);
  }
  return new RegExp(
    String.raw`\blooping in ${NAME_TOKEN} from our side\b`,
    'u'
  ).test(draft);
}

function rewriteLoopInCopy(text, replacement) {
  const name = firstName(replacement);
  if (!name) return String(text || '');
  const phrase = `${name} from our side`;
  const line = `looping in ${phrase}`;
  let s = String(text || '');
  s = s.replace(
    /\bloop(?:ing)?\s+in\s+(?:our\s+|the\s+)?(?:founder(?:\/ceo)?|ceo)\b/gi,
    line
  );
  s = s.replace(/\b(?:our\s+|the\s+)?founder(?:\/ceo)?\b/gi, phrase);
  s = s.replace(
    new RegExp(String.raw`\bloop(?:ing)?\s+in\s+${NAME_TOKEN}\s*,\s*(?:our|the)\s+[^.,\n]+,?`, 'giu'),
    line
  );
  s = s.replace(
    new RegExp(String.raw`\bloop(?:ing)?\s+in\s+${NAME_TOKEN}\s+from our side\b`, 'giu'),
    line
  );
  s = s.replace(
    new RegExp(String.raw`\b(${NAME_TOKEN})\s+from our side\b`, 'gu'),
    (all, token) => {
      if (token === name) return all;
      if (isLookalikeFirstName(token, name) || /^\p{Lu}/u.test(token)) return phrase;
      return all;
    }
  );
  s = s.replace(
    new RegExp(String.raw`\bloop(?:ing)?\s+${NAME_TOKEN}\s+in\b`, 'giu'),
    line
  );
  s = s.replace(
    new RegExp(String.raw`\bloop(?:ing)?\s+in\s+${NAME_TOKEN}\b(?!\s+from our side)`, 'giu'),
    line
  );
  s = s.replace(
    new RegExp(String.raw`\b${NAME_TOKEN}\b`, 'gu'),
    (token) => (isLookalikeFirstName(token, name) ? name : token)
  );
  return s.replace(/\s{2,}/g, ' ').trim();
}

module.exports = {
  clientLoopContact,
  clientLoopContactPhrase,
  rewriteLoopInCopy,
  rewriteFounderLoopIn: rewriteLoopInCopy,
  draftLoopsInContact,
  loopInLine,
  firstName,
};
