/**
 * Ground drafts to provided context. Models invent cities (and other
 * specifics) from world knowledge even when the prompt says not to —
 * Oct 13 2026 a QUESTION draft said a Boulder-named cyber firm was in
 * Denver when Denver was in none of the inputs.
 *
 * Check extracts locations, numbers, and proper nouns from the draft and
 * requires each to appear in the source context (thread / inbound /
 * scheduling / voice / names). RAG examples are style-only and are not
 * source context.
 */

const FACT_GROUNDING_RULES = [
  '- Use only facts present in the provided context (current thread, latest reply, scheduling guidance, CLIENT VOICE / CLIENT NOTES, and the names given there).',
  '- Never state or guess a location, company size, client name, pricing, result, or any other specific unless that exact fact appears in the provided context.',
  '- If they ask where you are based (or any other specific) and the context does not say, do not invent a city, state, or region. Say you do not want to guess over email and offer a short call.',
].join('\n');

const GENERIC_CAPITALIZED_TERMS = new Set([
  'Hey', 'Hi', 'Thanks', 'Thank', 'Fair', 'Good', 'Great', 'Honestly',
  'That', 'This', 'The', 'There', 'Would', 'Could', 'Can', 'Happy',
  'Our', 'Your', 'If', 'It', 'Rather', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday', 'Sunday', 'Josh', 'Joshua', 'CEO',
  'MSP', 'IT', 'AI', 'B2B', 'SDR', 'CRM', 'PTO', 'AM', 'PM', 'CDT', 'CST',
  'EDT', 'EST', 'PDT', 'PST', 'MDT', 'MST',
  'Actually', 'Already', 'Appreciate', 'Basically', 'Before', 'Best',
  'Book', 'Chat', 'Check', 'Completely', 'Definitely', 'Details',
  'Easier', 'Easiest', 'Either', 'Email', 'Exactly', 'First', 'Free',
  'Get', 'Give', 'Glad', 'Interested', 'Just', 'Know', 'Let', 'Like',
  'Little', 'Looking', 'Maybe', 'Makes', 'More', 'Most', 'Much', 'Need',
  'Nice', 'No', 'Not', 'Nothing', 'One', 'Open', 'Otherwise', 'Perfect',
  'Please', 'PS', 'Quick', 'Really', 'Right', 'See', 'Send', 'Since',
  'Sorry', 'Sounds', 'Still', 'Sure', 'Talk', 'Totally', 'Want', 'What',
  'When', 'Where', 'Why', 'Work', 'Worth', 'Yes', 'You', 'Zero',
  'For', 'As', 'With', 'Does', 'Some', 'Here', 'Got', 'Be', 'Other',
  'All', 'At', 'To', 'In', 'Of', 'And', 'Or', 'Is', 'Are', 'We', 'By',
  'On', 'But', 'How', 'About', 'After', 'Also', 'Any', 'Back', 'Both',
  'Call', 'From', 'Have', 'Into', 'Over', 'Than', 'Them', 'Then', 'They',
  'Will', 'Ok', 'Okay', 'Ah', 'Man', 'Absolutely', 'Tomorrow', 'Today',
  'Morning', 'Afternoon', 'Evening', 'Week', 'Next', 'Later', 'Instead',
].map((term) => term.toLowerCase()));

const US_CITIES = new Set([
  'albuquerque', 'anaheim', 'anchorage', 'arlington', 'atlanta', 'aurora',
  'austin', 'bakersfield', 'baltimore', 'baton rouge', 'birmingham', 'boise',
  'boston', 'boulder', 'buffalo', 'chandler', 'charleston', 'charlotte',
  'chattanooga', 'chicago', 'cincinnati', 'cleveland', 'colorado springs',
  'columbus', 'corpus christi', 'dallas', 'denver', 'des moines', 'detroit',
  'durham', 'el paso', 'fort lauderdale', 'fort worth', 'fresno', 'greensboro',
  'henderson', 'honolulu', 'houston', 'indianapolis', 'irvine', 'jacksonville',
  'jersey city', 'kansas city', 'knoxville', 'las vegas', 'lexington',
  'lincoln', 'little rock', 'long beach', 'los angeles', 'louisville',
  'madison', 'memphis', 'mesa', 'miami', 'milwaukee', 'minneapolis',
  'nashville', 'new orleans', 'new york', 'newark', 'norfolk', 'oakland',
  'oklahoma city', 'omaha', 'orlando', 'philadelphia', 'phoenix',
  'pittsburgh', 'plano', 'portland', 'raleigh', 'reno', 'richmond',
  'riverside', 'sacramento', 'saint louis', 'st louis', 'salt lake city',
  'north salt lake', 'san antonio', 'san diego', 'san francisco', 'san jose',
  'santa ana', 'scottsdale', 'seattle', 'spokane', 'st paul', 'stockton',
  'tampa', 'tucson', 'tulsa', 'virginia beach', 'washington', 'wichita',
]);

const US_STATES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
]);

const STATE_ABBREV = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id',
  'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms',
  'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok',
  'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv',
  'wi', 'wy', 'dc',
]);

const COUNTRY_PHRASES = [
  'united states', 'united states of america', 'u.s.a.', 'u.s.',
];

function containsWholeTerm(text, term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(String(text || ''));
}

function normalizeSource(text) {
  return String(text || '');
}

function addClaim(out, value, kind) {
  const raw = String(value || '').trim();
  if (!raw) return;
  const key = raw.toLowerCase();
  if (out.some((c) => c.key === key)) return;
  out.push({ key, value: raw, kind });
}

function extractLocationClaims(draft) {
  const text = String(draft || '');
  const claims = [];

  const multiWordCities = [...US_CITIES]
    .filter((city) => city.includes(' '))
    .sort((a, b) => b.length - a.length);
  for (const city of multiWordCities) {
    if (containsWholeTerm(text, city)) addClaim(claims, titleCase(city), 'city');
  }
  const tokens = text.match(/\b[A-Za-z][A-Za-z.'-]+\b/g) || [];
  for (const token of tokens) {
    const lower = token.toLowerCase().replace(/\.+$/, '');
    if (US_CITIES.has(lower) && !lower.includes(' ')) {
      addClaim(claims, token, 'city');
    }
    if (US_STATES.has(lower)) addClaim(claims, token, 'state');
  }

  const cityState = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2})\b/g) || [];
  for (const pair of cityState) {
    const m = pair.match(/,\s*([A-Z]{2})\b/);
    if (m && STATE_ABBREV.has(m[1].toLowerCase())) {
      addClaim(claims, m[1], 'state');
    }
  }
  const basedInAbbrev = text.match(
    /\b(?:based(?:\s+out)?\s+(?:of|in)|in|from)\s+([A-Z]{2})\b/g
  ) || [];
  for (const phrase of basedInAbbrev) {
    const m = phrase.match(/\b([A-Z]{2})$/);
    if (m && STATE_ABBREV.has(m[1].toLowerCase())) {
      addClaim(claims, m[1], 'state');
    }
  }

  for (const phrase of COUNTRY_PHRASES) {
    if (containsWholeTerm(text, phrase)) addClaim(claims, phrase, 'country');
  }
  if (/\b(?:all over|across|throughout|around|in)\s+the\s+US\b/i.test(text)
    || /\bUS-based\b/i.test(text)
    || /\bbased .{0,40}\bUS\b/i.test(text)) {
    addClaim(claims, 'US', 'country');
  }
  if (/\bUSA\b/.test(text)) addClaim(claims, 'USA', 'country');

  return claims;
}

function extractNumberClaims(draft) {
  const text = String(draft || '');
  const claims = [];
  const money = text.match(/\$[\d,.]+(?:\s*[kmb])?\b/gi) || [];
  for (const hit of money) addClaim(claims, hit.replace(/\s+/g, ''), 'number');

  const percents = text.match(/\b\d+(?:\.\d+)?%/g) || [];
  for (const hit of percents) addClaim(claims, hit, 'number');

  const quantities = text.match(
    /\b\d+(?:\.\d+)?\s*(?:k|employees?|people|years?|months?|weeks?)\b/gi
  ) || [];
  for (const hit of quantities) addClaim(claims, hit, 'number');

  return claims;
}

function distinctiveTokens(term) {
  return String(term || '')
    .split(/\s+/)
    .map((tok) => tok.replace(/[.,;:!?]+$/g, ''))
    .filter((tok) => tok && !GENERIC_CAPITALIZED_TERMS.has(tok.toLowerCase()));
}

function extractProperNouns(draft) {
  const text = String(draft || '');
  const claims = [];
  const candidates = text.match(/\b(?:[A-Z]{3,}|[A-Z][a-z]{2,})(?:\s+[A-Z][a-z]{2,}){0,3}\b/g) || [];
  for (const term of candidates) {
    const distinctive = distinctiveTokens(term);
    if (!distinctive.length) continue;
    const focus = distinctive.join(' ');
    if (US_CITIES.has(focus.toLowerCase()) || US_STATES.has(focus.toLowerCase())) continue;
    if (distinctive.length === 1 && (US_CITIES.has(distinctive[0].toLowerCase()) || US_STATES.has(distinctive[0].toLowerCase()))) {
      continue;
    }
    addClaim(claims, focus, 'proper_noun');
  }
  return claims;
}

function titleCase(s) {
  return String(s || '').replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function extractClaims(draft) {
  return [
    ...extractLocationClaims(draft),
    ...extractNumberClaims(draft),
    ...extractProperNouns(draft),
  ];
}

function claimSupported(claim, sourceText) {
  const source = normalizeSource(sourceText);
  if (containsWholeTerm(source, claim.value)) return true;
  if (containsWholeTerm(source, claim.key)) return true;
  if (claim.kind === 'proper_noun') {
    const tokens = distinctiveTokens(claim.value);
    if (tokens.length && tokens.every((tok) => containsWholeTerm(source, tok))) {
      return true;
    }
  }
  if (claim.kind === 'number') {
    const compact = claim.key.replace(/[\s,]/g, '');
    const sourceCompact = source.toLowerCase().replace(/[\s,]/g, '');
    if (sourceCompact.includes(compact)) return true;
  }
  return false;
}

function findUnsupportedClaims(draft, sourceText) {
  return extractClaims(draft).filter((claim) => !claimSupported(claim, sourceText));
}

function splitSentences(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  return raw.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function sentenceHasClaim(sentence, claim) {
  return containsWholeTerm(sentence, claim.value) || containsWholeTerm(sentence, claim.key);
}

function stripUnsupportedClaims(draft, claims) {
  const list = Array.isArray(claims) ? claims : [];
  if (!list.length) return { text: String(draft || ''), removed: [] };
  const removed = [];
  const kept = splitSentences(draft).filter((sentence) => {
    const hit = list.some((claim) => sentenceHasClaim(sentence, claim));
    if (hit) {
      removed.push(sentence);
      return false;
    }
    return true;
  });
  return { text: kept.join(' ').trim(), removed };
}

function threadToText(threadContext) {
  try {
    const { summarizeThread } = require('../services/claude-reply-draft');
    return summarizeThread(threadContext);
  } catch {
    return '';
  }
}

function factSourceText({
  inboundMessage,
  threadContext,
  threadSummary,
  leadName,
  clientName,
  schedulingPromptBlock,
  voicePrompt,
  learnedVoiceBlock,
} = {}) {
  return [
    leadName,
    clientName,
    inboundMessage,
    threadSummary || threadToText(threadContext),
    schedulingPromptBlock,
    voicePrompt,
    learnedVoiceBlock,
  ].filter(Boolean).join('\n');
}

function factCheckRetryHint(claims) {
  const terms = (claims || []).map((c) => c.value).join(', ');
  return [
    'FINAL CORRECTION: Your prior draft stated these facts that are not in the provided context:',
    terms || '(unsupported specifics)',
    'Write a fresh reply using only facts present in the provided context.',
    'Do not state or guess a location, size, client name, pricing, or any other specific unless it appears there.',
    'If they asked something the context does not answer, say you do not want to guess over email and offer a short call.',
  ].join(' ');
}

async function enforceDraftGrounding({
  draft,
  sourceText,
  regenerate,
} = {}) {
  const empty = {
    text: String(draft || ''),
    regenerated: false,
    stripped: false,
    needsReview: false,
    claims: [],
  };
  const original = String(draft || '').trim();
  if (!original) return empty;

  let text = original;
  let claims = findUnsupportedClaims(text, sourceText);
  if (!claims.length) return { ...empty, text };

  let regenerated = false;
  if (typeof regenerate === 'function') {
    try {
      const retry = await regenerate(claims);
      const next = String(retry || '').trim();
      if (next) {
        text = next;
        regenerated = true;
        claims = findUnsupportedClaims(text, sourceText);
        if (!claims.length) {
          return {
            text, regenerated, stripped: false, needsReview: false, claims: [],
          };
        }
      }
    } catch (err) {
      console.warn('[DraftFactCheck] Regen failed', { err: err.message });
    }
  }

  const stripped = stripUnsupportedClaims(text, claims);
  const leftover = stripped.text
    ? findUnsupportedClaims(stripped.text, sourceText)
    : claims;
  if (stripped.text && !leftover.length) {
    return {
      text: stripped.text,
      regenerated,
      stripped: stripped.removed.length > 0,
      needsReview: false,
      claims: [],
    };
  }

  return {
    text: stripped.text || text,
    regenerated,
    stripped: stripped.removed.length > 0,
    needsReview: true,
    claims: leftover.length ? leftover : claims,
  };
}

function applyFactCheckToPolicy(policy, factCheck) {
  const base = policy && typeof policy === 'object' ? policy : {};
  const draft = factCheck && factCheck.text != null && base.isDraft
    ? factCheck.text
    : base.draft;
  if (!factCheck || !base.isDraft || !factCheck.needsReview) {
    return { ...base, draft, needsReview: false };
  }
  const labels = (factCheck.claims || []).map((c) => c.value).filter(Boolean);
  const note = labels.length
    ? `needs review — unsupported claims: ${labels.join(', ')}`
    : 'needs review — draft stated facts not in the provided context';
  return {
    ...base,
    draft,
    status: 'flagged',
    reasoning: [base.reasoning, note].filter(Boolean).join(' '),
    needsReview: true,
  };
}

module.exports = {
  FACT_GROUNDING_RULES,
  GENERIC_CAPITALIZED_TERMS,
  US_CITIES,
  extractClaims,
  findUnsupportedClaims,
  stripUnsupportedClaims,
  factSourceText,
  factCheckRetryHint,
  enforceDraftGrounding,
  applyFactCheckToPolicy,
  containsWholeTerm,
};
