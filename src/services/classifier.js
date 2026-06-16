const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OOO', 'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const DRAFT_CLASSIFICATIONS = CLASSIFICATIONS.filter((c) => c !== 'OUT_OF_OFFICE' && c !== 'OOO');

const DEFAULT_DRAFT_TZ = 'America/Chicago';

function firstNameFromLead(leadName) {
  const s = String(leadName || '').trim();
  if (!s || s.toLowerCase() === 'unknown') return 'there';
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

function sanitizeDraft(text, { leadName, inboundMessage, bookingLink, classification } = {}) {
  let s = String(text || '').trim();
  // Strip markdown fences / leading role labels the model sometimes adds.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/^(draft|reply|response)\s*:\s*/i, '').trim();

  // Only use the template when Gemini returns nothing (API/empty). Never replace a real draft.
  if (!s) {
    s = fallbackDraftText({ leadName, inboundMessage, bookingLink, classification });
  }

  // For MEETING_PROPOSED, guarantee the booking link is present.
  if (
    classification === 'MEETING_PROPOSED' &&
    bookingLink &&
    typeof bookingLink === 'string' &&
    bookingLink.trim().startsWith('http') &&
    !s.includes(bookingLink.trim())
  ) {
    s = `${s.trim()}\n\n${bookingLink.trim()}`;
  }

  return s;
}

function looksLikeClearInterest(msg) {
  const m = String(msg || '').trim().toLowerCase();
  if (!m || /\?/.test(m)) return false;
  return /\b(tell me more|i'?m interested|sounds good|let'?s (talk|chat|connect)|open to (a )?(chat|call)|would love to hear|happy to (chat|talk|connect))\b/.test(m);
}

function fallbackDraftText({ leadName, inboundMessage, bookingLink, classification } = {}) {
  const name = firstNameFromLead(leadName);
  const day = nextBusinessDayLabel();
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  const msg = String(inboundMessage || '').trim();
  const clearInterest = classification === 'INTERESTED' && looksLikeClearInterest(msg);
  const ack = clearInterest
    ? 'We\'d love to make sure it\'s a good fit on both sides.'
    : 'Totally fair question — I\'m sure we can work something out on the call. We want this to make sense and be worth your time.';
  const close = link
    ? `Here's our CEO's booking link — would ${day} work? ${link}`
    : `Would ${day} work for a quick call with our CEO?`;
  return `Hey ${name}, thanks for getting back to me. ${ack} ${close}`;
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
      maxOutputTokens: 1024,
      temperature: 0.25,
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
    const res = await model.generateContent(
      `Thread:\n${summarizeThread(threadContext)}\n\n` +
      `Latest prospect reply:\n${inboundMessage}\n\n` +
      `Category:`
    );
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
  schedulingPromptBlock,
  digestTimezone,
}) {
  const booking = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '[no booking link configured]';
  const scheduleCtx = schedulingPromptBlock || 'No verified availability was loaded.';
  const name = firstNameFromLead(leadName);
  const nextDay = nextBusinessDayLabel(digestTimezone || DEFAULT_DRAFT_TZ);

  const systemInstruction = `You ghostwrite a short, warm B2B sales reply in the client's voice.
Output: PLAIN TEXT reply only. No JSON, no markdown, no "Draft:" prefix. No quotes around the message.

TONE:
- Friendly, warm, human — not a rigid sales template.
- Concise: 2-4 short sentences. Acknowledge what they said.
- Write dynamically in your own words. Do NOT copy a fixed script verbatim.

DO NOT HALLUCINATE — if you do not know the answer from the thread alone, do not guess:
- Only state facts explicitly present in the thread.
- Do NOT confirm/deny offer details (pricing, deliverables, ticket types, scope, terms).
- Do NOT invent or assume what the offer includes.
- When unsure: acknowledge briefly and book a call with our CEO. Never bluff.

CLIENT VOICE:
${voicePrompt || 'Professional, direct, practitioner-level. No fluff.'}

PROSPECT FIRST NAME: ${name}

STRUCTURE (follow this flow, adapt wording naturally):
1. Open: greet by first name, thank them for getting back to you.
2. Acknowledge their message in one short sentence — reflect tone (neutral, skeptical, question, or interest). Defer specifics to our CEO on the call; say you want it to make sense and be worth their time.
3. Close: mention our CEO's booking link, propose ${nextDay}, include the full URL once: ${booking}

CURRENT CLASSIFICATION: ${classification}
- INTERESTED / QUESTION / OBJECTION / OTHER: acknowledge + book the CEO call.
- MEETING_PROPOSED: confirm warmly; you may mention verified times below instead of only ${nextDay}, but include the CEO booking link once.
- NOT_INTERESTED / COMPETITOR / WRONG_PERSON / REMOVE_ME: brief respectful acknowledgment only (no booking push).

VERIFIED AVAILABILITY:
${scheduleCtx}
`;

  try {
    const model = buildDraftModel(systemInstruction);
    const res = await model.generateContent(
      `Thread:\n${summarizeThread(threadContext)}\n\n` +
      `Latest prospect reply:\n${inboundMessage}\n\n` +
      `Write the reply. If the answer is not clearly in the thread above, do NOT guess or hallucinate — defer to our CEO on the call and ask for the meeting:`
    );
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
      schedulingPromptBlock,
      digestTimezone,
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
