const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OOO', 'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const DRAFT_CLASSIFICATIONS = CLASSIFICATIONS.filter((c) => c !== 'OUT_OF_OFFICE' && c !== 'OOO');

const DEFAULT_DRAFT_TZ = 'America/Chicago';

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

/** Next weekday after today in the given IANA timezone (skips Sat/Sun). */
function nextBusinessDayLabel(timeZone = DEFAULT_DRAFT_TZ) {
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  const longFmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' });
  let cursor = Date.now();
  for (let i = 0; i < 8; i += 1) {
    cursor += 24 * 60 * 60 * 1000;
    const day = weekdayFmt.format(new Date(cursor));
    if (day !== 'Sat' && day !== 'Sun') {
      return longFmt.format(new Date(cursor));
    }
  }
  return 'next week';
}

function normalizeClassification(raw) {
  if (!raw) return 'OTHER';
  const upper = String(raw).toUpperCase();
  if (/\bOUT_OF_OFFICE\b/.test(upper)) return 'OOO';
  // Find the first enum value mentioned in the model's response.
  for (const c of CLASSIFICATIONS) {
    const re = new RegExp(`\\b${c}\\b`);
    if (re.test(upper)) return c;
  }
  return 'OTHER';
}

const NO_BOOKING_CLASSIFICATIONS = new Set(['NOT_INTERESTED', 'COMPETITOR', 'WRONG_PERSON', 'REMOVE_ME']);

function sanitizeDraft(text, { leadName, inboundMessage, bookingLink, classification } = {}) {
  let s = String(text || '').trim();
  // Strip markdown fences / leading role labels the model sometimes adds.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/^(draft|reply|response)\s*:\s*/i, '').trim();

  // Only use the template when Gemini returns nothing (API/empty). Never replace a real draft.
  if (!s) {
    s = fallbackDraftText({ leadName, inboundMessage, bookingLink, classification });
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

function looksLikeClearInterest(msg) {
  const m = String(msg || '').trim().toLowerCase();
  if (!m || /\?/.test(m)) return false;
  return /\b(tell me more|i'?m interested|sounds good|let'?s (talk|chat|connect)|open to (a )?(chat|call)|would love to hear|happy to (chat|talk|connect))\b/.test(m);
}

function fallbackDraftText({ leadName, inboundMessage, bookingLink, classification } = {}) {
  const name = firstNameFromLead(leadName);
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  if (classification && NO_BOOKING_CLASSIFICATIONS.has(classification)) {
    return `Hey ${name}, totally understand — thanks for letting me know.`;
  }
  if (link) {
    return `Hey ${name}, yes — happy to help with that. Grab a time with our CEO here: ${link}`;
  }
  return `Hey ${name}, yes — happy to help with that. Would a quick call with our CEO work?`;
}

function buildClassifyModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction:
      `You classify a B2B sales reply into exactly one category.\n` +
      `Respond with ONLY the category word, nothing else.\n` +
      `Categories: ${CLASSIFICATIONS.join(', ')}.\n\n` +
      `Important:\n` +
      `- Use OOO when the message is an out-of-office / vacation / automatic reply (e.g. "out of the office", "on vacation", "limited access to email", "will return on", "automatic reply", "away from my desk").\n` +
      `- If it is clearly OOO, output OOO (not OTHER).\n` +
      `- OUT_OF_OFFICE is legacy; prefer OOO.`,
    generationConfig: {
      // ONE WORD. Cannot truncate meaningfully.
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
      'Respond with exactly YES or NO, nothing else.\n' +
      'YES if: out of office, OOO, vacation, away, limited email access, auto-reply, automatic reply, will return on [date], not monitoring email closely.\n' +
      'NO if: a human is engaging with substance about the offer (even if brief).',
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
      'Respond with exactly YES or NO, nothing else.\n' +
      'YES if: not interested, no thanks, no thank you, no interest, not a fit, we are all set, going to pass, pass on this, not at this time.\n' +
      'NO if: they ask a question, express interest, ask for more info, mention bad timing but still interested, or the message is ambiguous.',
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
      maxOutputTokens: 256,
      temperature: 0.5,
      responseMimeType: 'text/plain',
    },
  });
}

function summarizeThread(threadContext) {
  if (!threadContext) return '(no prior thread)';
  if (typeof threadContext === 'string') return threadContext.slice(0, 4000);
  try {
    return JSON.stringify(threadContext, null, 2).slice(0, 4000);
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

/** Second pass: when primary label is OTHER, ask explicitly for OOO vs not. */
async function classifyOooSecondPass(threadContext, inboundMessage) {
  try {
    const model = buildOooCheckModel();
    const res = await model.generateContent(
      `Thread:\n${summarizeThread(threadContext)}\n\n` +
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

/** Second pass: when primary label is OTHER, ask explicitly for clear no/not-interested. */
async function classifyNotInterestedSecondPass(threadContext, inboundMessage) {
  try {
    const model = buildNotInterestedCheckModel();
    const res = await model.generateContent(
      `Thread:\n${summarizeThread(threadContext)}\n\n` +
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
    : '[no booking link configured]';
  const name = firstNameFromLead(leadName);
  const inbound = String(inboundMessage || '').trim() || '(no message)';

  if (classification && NO_BOOKING_CLASSIFICATIONS.has(classification)) {
    const systemInstruction = `Write one brief, friendly sentence acknowledging their message. PLAIN TEXT only. No booking link. Prospect first name: ${name}.`;
    try {
      const model = buildDraftModel(systemInstruction);
      const res = await withGeminiRetry(() => model.generateContent(
        `Their message:\n${inbound}\n\nWrite a short polite acknowledgment:`
      ));
      return sanitizeDraft(res.response.text(), { leadName, inboundMessage, bookingLink, classification });
    } catch (err) {
      console.error('[Classifier] draft call failed', { err: err.message });
      return fallbackDraftText({ leadName, inboundMessage, bookingLink, classification });
    }
  }

  const systemInstruction = `You ghostwrite short, friendly B2B sales reply emails.
Output: PLAIN TEXT only. No JSON, no markdown, no "Draft:" prefix.

RULES:
- 1-3 sentences max. Warm and human — not a rigid template.
- Read their latest message and say YES to what they asked (more info, a call, pricing, timing, interest, etc.). Mirror their ask in your own words — be specific to their message.
- Do NOT hedge, defer, or say "let's make sure it's a fit." Be affirmative.
- End with our CEO's booking link. Include this full URL exactly once: ${booking}
- Do NOT invent facts, pricing, or deliverables. If details are unclear, still say yes and point them to the CEO call.
- Do NOT reuse the same wording every time — vary your phrasing.

PROSPECT FIRST NAME: ${name}
${voicePrompt ? `CLIENT VOICE NOTES:\n${voicePrompt}` : ''}`;

  try {
    const model = buildDraftModel(systemInstruction);
    const res = await withGeminiRetry(() => model.generateContent(
      `Prior thread (context only):\n${summarizeThread(threadContext)}\n\n` +
      `Their latest message (reply directly to this):\n${inbound}\n\n` +
      `Write a short yes-style reply with the CEO booking link:`
    ));
    return sanitizeDraft(res.response.text(), { leadName, inboundMessage, bookingLink, classification });
  } catch (err) {
    console.error('[Classifier] draft call failed', { err: err.message });
    return sanitizeDraft('', { leadName, inboundMessage, bookingLink, classification });
  }
}

/**
 * Two-call flow: classify, then draft (when needed).
 * Never throws. Always returns { classification, draft, proposed_time, reasoning }.
 */
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
  nextBusinessDayLabel,
  fallbackDraftText,
  looksLikeClearInterest,
  CLASSIFICATIONS,
  DRAFT_CLASSIFICATIONS,
};
