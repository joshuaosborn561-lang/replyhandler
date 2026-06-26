const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OOO', 'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const DRAFT_CLASSIFICATIONS = CLASSIFICATIONS.filter((c) => c !== 'OUT_OF_OFFICE' && c !== 'OOO');

const NO_BOOKING_CLASSIFICATIONS = new Set(['NOT_INTERESTED', 'COMPETITOR', 'WRONG_PERSON', 'REMOVE_ME']);

/** Phrases that mean Gemini ignored the prospect's message and used our old script. */
const GENERIC_DRAFT_PATTERNS = [
  /thanks for getting back/i,
  /thank you for getting back/i,
  /make sure it'?s a good fit/i,
  /totally fair question/i,
  /work something out on the call/i,
  /worth your time/i,
  /worth both our time/i,
  /happy to help with that\. grab a time/i,
  /we want this to make sense/i,
  /defer to our ceo on the call/i,
  /would \w+day work/i,
  /here'?s our ceo'?s booking link — would/i,
];

async function withGeminiRetry(fn, { attempts = 3, baseDelayMs = 800 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const retryable = /503|502|504|429|timeout|unavailable|overloaded/i.test(msg);
      if (!retryable || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}

function firstNameFromLead(leadName) {
  const s = String(leadName || '').trim();
  if (!s || s.toLowerCase() === 'unknown') return 'there';
  if (/^linkedin(\s+prospect)?$/i.test(s) || /^prospect$/i.test(s)) return 'there';
  return s.split(/\s+/)[0];
}

function normalizeInbound(inboundMessage) {
  return String(inboundMessage || '').replace(/\s+/g, ' ').trim();
}

function inboundSnippet(inboundMessage, maxLen = 100) {
  const t = normalizeInbound(inboundMessage);
  if (!t) return '';
  const first = t.split(/(?<=[.!?])\s+/)[0] || t;
  if (first.length <= maxLen) return first;
  return `${first.slice(0, maxLen - 3).trim()}...`;
}

function significantWords(text) {
  const stop = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'to', 'for', 'of', 'in', 'on', 'at', 'is', 'it',
    'i', 'we', 'you', 'me', 'my', 'your', 'our', 'that', 'this', 'with', 'are', 'was', 'be', 'do',
    'can', 'could', 'would', 'will', 'just', 'so', 'hi', 'hey', 'thanks', 'thank', 'yes', 'no',
  ]);
  return normalizeInbound(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

function draftReferencesInbound(draft, inboundMessage) {
  const draftWords = new Set(significantWords(draft));
  const inbound = significantWords(inboundMessage);
  if (!inbound.length) return true;
  const overlap = inbound.filter((w) => draftWords.has(w)).length;
  return overlap >= 1 || draft.includes('?');
}

function isGenericDraft(draft, inboundMessage) {
  const s = String(draft || '').trim();
  if (!s) return true;
  if (GENERIC_DRAFT_PATTERNS.some((re) => re.test(s))) return true;
  return !draftReferencesInbound(s, inboundMessage);
}

function topicFromInbound(inboundMessage) {
  const t = normalizeInbound(inboundMessage).toLowerCase();
  const topics = [
    [/\bpric(e|ing)\b|\bcost\b|\bbudget\b|\brate\b/, 'pricing'],
    [/\bdemo\b|\bwalkthrough\b|\bshow me\b/, 'a demo'],
    [/\bhow (does|do) it work\b|\bhow this works\b/, 'how it works'],
    [/\bintegrat(e|ion|es)\b/, 'integration'],
    [/\btimeline\b|\bwhen can\b|\bhow long\b/, 'timeline'],
    [/\bcall\b|\bchat\b|\bmeet\b|\bschedule\b|\btimes?\b|\bcalendar\b/, 'scheduling a call'],
    [/\bmore (info|information|details)\b|\btell me more\b/, 'more details'],
    [/\binterested\b|\bsounds good\b|\blet'?s talk\b/, 'connecting'],
  ];
  for (const [re, label] of topics) {
    if (re.test(t)) return label;
  }
  return '';
}

/**
 * Deterministic yes-style draft — always references what they wrote.
 */
function composeInboundYesDraft({ leadName, inboundMessage, bookingLink, classification } = {}) {
  const name = firstNameFromLead(leadName);
  const inbound = normalizeInbound(inboundMessage);
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';

  if (classification && NO_BOOKING_CLASSIFICATIONS.has(classification)) {
    return `Hey ${name}, totally understand — thanks for letting me know.`;
  }

  const snippet = inboundSnippet(inbound, 90);
  const topic = topicFromInbound(inbound);
  const hasQuestion = /\?/.test(inbound);

  let yesLine;
  if (hasQuestion && snippet) {
    if (topic === 'scheduling a call') {
      yesLine = 'yes — grab a time with our CEO that works for you';
    } else if (topic) {
      yesLine = `yes — happy to cover ${topic} with our CEO`;
    } else {
      yesLine = `yes — happy to answer that on a call with our CEO`;
    }
  } else if (topic) {
    yesLine = `yes, absolutely — happy to chat about ${topic}`;
  } else if (snippet) {
    yesLine = `yes — got your note ("${snippet}")`;
  } else {
    yesLine = 'yes, happy to connect';
  }

  if (link) {
    return `Hey ${name}, ${yesLine}. Here's his calendar: ${link}`;
  }
  return `Hey ${name}, ${yesLine}. Would a quick call with our CEO work?`;
}

function sanitizeDraft(text, { leadName, inboundMessage, bookingLink, classification } = {}) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/^(draft|reply|response)\s*:\s*/i, '').trim();

  if (!s || isGenericDraft(s, inboundMessage)) {
    s = composeInboundYesDraft({ leadName, inboundMessage, bookingLink, classification });
  }

  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  if (
    link &&
    classification &&
    !NO_BOOKING_CLASSIFICATIONS.has(classification) &&
    !s.includes(link)
  ) {
    s = `${s.trim()} ${link}`;
  }

  return s.trim();
}

function buildClassifyModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction:
      `You classify a B2B sales reply into exactly one category.\n` +
      `Respond with ONLY the category word, nothing else.\n` +
      `Categories: ${CLASSIFICATIONS.join(', ')}.\n\n` +
      `Important:\n` +
      `- Use OOO when the message is an out-of-office / vacation / automatic reply.\n` +
      `- If it is clearly OOO, output OOO (not OTHER).\n` +
      `- OUT_OF_OFFICE is legacy; prefer OOO.`,
    generationConfig: {
      maxOutputTokens: 16,
      temperature: 0,
      responseMimeType: 'text/plain',
    },
  });
}

function buildOooCheckModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction:
      'You decide if a message is an out-of-office, vacation, or automatic reply.\n' +
      'Respond with exactly YES or NO, nothing else.',
    generationConfig: {
      maxOutputTokens: 8,
      temperature: 0,
      responseMimeType: 'text/plain',
    },
  });
}

function buildNotInterestedCheckModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction:
      'You decide if a B2B prospect is clearly declining the offer or saying no.\n' +
      'Respond with exactly YES or NO, nothing else.',
    generationConfig: {
      maxOutputTokens: 8,
      temperature: 0,
      responseMimeType: 'text/plain',
    },
  });
}

function buildDraftModel(systemInstruction) {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction,
    generationConfig: {
      maxOutputTokens: 200,
      temperature: 0.55,
      responseMimeType: 'text/plain',
    },
  });
}

function summarizeThread(threadContext) {
  if (!threadContext) return '(no prior thread)';
  if (typeof threadContext === 'string') return threadContext.slice(0, 2000);
  try {
    return JSON.stringify(threadContext, null, 2).slice(0, 2000);
  } catch {
    return '(unserializable thread)';
  }
}

async function classifyOnly(threadContext, inboundMessage) {
  try {
    const model = buildClassifyModel();
    const res = await withGeminiRetry(() => model.generateContent(
      `Thread:\n${summarizeThread(threadContext)}\n\n` +
      `Latest prospect reply:\n${inboundMessage}\n\n` +
      `Category:`
    ));
    const text = res.response.text().trim();
    return normalizeClassification(text);
  } catch (err) {
    console.error('[Classifier] classify call failed', { err: err.message });
    return 'OTHER';
  }
}

function normalizeClassification(raw) {
  if (!raw) return 'OTHER';
  const upper = String(raw).toUpperCase();
  if (/\bOUT_OF_OFFICE\b/.test(upper)) return 'OOO';
  for (const c of CLASSIFICATIONS) {
    const re = new RegExp(`\\b${c}\\b`);
    if (re.test(upper)) return c;
  }
  return 'OTHER';
}

async function classifyOooSecondPass(threadContext, inboundMessage) {
  try {
    const model = buildOooCheckModel();
    const res = await model.generateContent(
      `Latest prospect message:\n${inboundMessage}\n\n` +
      `Is this an out-of-office / vacation / automatic reply?`
    );
    const t = (res.response.text() || '').trim().toUpperCase();
    if (t.startsWith('Y')) return 'OOO';
  } catch (err) {
    console.error('[Classifier] OOO second pass failed', { err: err.message });
  }
  return null;
}

async function classifyNotInterestedSecondPass(threadContext, inboundMessage) {
  try {
    const model = buildNotInterestedCheckModel();
    const res = await model.generateContent(
      `Latest prospect message:\n${inboundMessage}\n\n` +
      `Is this a clear decline / not-interested reply?`
    );
    const t = (res.response.text() || '').trim().toUpperCase();
    if (t.startsWith('Y')) return 'NOT_INTERESTED';
  } catch (err) {
    console.error('[Classifier] not-interested second pass failed', { err: err.message });
  }
  return null;
}

async function draftOnly({
  classification,
  threadContext,
  inboundMessage,
  leadName,
  voicePrompt,
  bookingLink,
}) {
  const booking = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  const name = firstNameFromLead(leadName);
  const inbound = normalizeInbound(inboundMessage) || '(no message)';

  if (classification && NO_BOOKING_CLASSIFICATIONS.has(classification)) {
    return composeInboundYesDraft({ leadName, inboundMessage, bookingLink, classification });
  }

  const systemInstruction = `Write a short B2B email reply. PLAIN TEXT only.

MUST DO:
- Say YES to what they asked — be affirmative, not hedging.
- Sentence 1 MUST reference something specific from their message (quote a phrase or name their topic).
- 1-2 sentences total, then the CEO booking URL on its own or at the end.
- Friendly, casual tone. No corporate filler.

NEVER USE these phrases: "thanks for getting back", "good fit on both sides", "totally fair question", "worth your time", "would Tuesday/Wednesday work".

Prospect first name: ${name}
CEO booking URL (include exactly once): ${booking || '[no link]'}
${voicePrompt ? `Voice notes: ${voicePrompt}` : ''}`;

  try {
    const model = buildDraftModel(systemInstruction);
    const res = await withGeminiRetry(() => model.generateContent(
      `Their message:\n"""${inbound}"""\n\n` +
      `Write the reply. You MUST echo or name a specific detail from their message in sentence 1:`
    ));
    const draft = sanitizeDraft(res.response.text(), {
      leadName, inboundMessage, bookingLink, classification,
    });
    if (isGenericDraft(draft, inboundMessage)) {
      return composeInboundYesDraft({ leadName, inboundMessage, bookingLink, classification });
    }
    return draft;
  } catch (err) {
    console.error('[Classifier] draft call failed', { err: err.message });
    return composeInboundYesDraft({ leadName, inboundMessage, bookingLink, classification });
  }
}

async function classifyAndDraft(
  threadContext,
  inboundMessage,
  voicePrompt,
  bookingLink,
  schedulingPromptBlock,
  { leadName, digestTimezone } = {},
) {
  let classification = await classifyOnly(threadContext, inboundMessage);
  if (classification === 'OTHER') {
    const ooo = await classifyOooSecondPass(threadContext, inboundMessage);
    if (ooo === 'OOO') classification = 'OOO';
  }
  if (classification === 'OTHER') {
    const no = await classifyNotInterestedSecondPass(threadContext, inboundMessage);
    if (no === 'NOT_INTERESTED') classification = 'NOT_INTERESTED';
  }
  const needsDraft = DRAFT_CLASSIFICATIONS.includes(classification);

  const draft = needsDraft
    ? await draftOnly({
      classification,
      threadContext,
      inboundMessage,
      leadName,
      voicePrompt,
      bookingLink,
    })
    : null;

  return {
    classification,
    draft,
    proposed_time: null,
    reasoning: needsDraft ? `Classified as ${classification}; draft generated.` : `Classified as ${classification}; no draft.`,
  };
}

module.exports = {
  classifyAndDraft,
  classifyOnly,
  draftOnly,
  firstNameFromLead,
  composeInboundYesDraft,
  isGenericDraft,
  sanitizeDraft,
  CLASSIFICATIONS,
  DRAFT_CLASSIFICATIONS,
};
