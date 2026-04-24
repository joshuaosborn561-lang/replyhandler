const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OOO', 'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const DRAFT_CLASSIFICATIONS = CLASSIFICATIONS.filter((c) => c !== 'OUT_OF_OFFICE' && c !== 'OOO');

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

function sanitizeDraft(text, { inboundMessage, bookingLink, classification } = {}) {
  let s = String(text || '').trim();
  // Strip markdown fences / leading role labels the model sometimes adds.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/^(draft|reply|response)\s*:\s*/i, '').trim();

  if (!s) {
    s = fallbackDraftText({ inboundMessage, bookingLink });
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

function fallbackDraftText({ inboundMessage, bookingLink }) {
  const msg = String(inboundMessage || '').trim();
  const snippet = msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  return [
    'Thanks for getting back to me — appreciate it.',
    snippet ? `On your note: "${snippet}"` : null,
    'Happy to share details and answer anything specific.',
    link ? `If easier, grab a time that works here: ${link}` : null,
  ].filter(Boolean).join(' ');
}

function buildClassifyModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction:
      `You classify a B2B sales reply into exactly one category.\n` +
      `Respond with ONLY the category word, nothing else.\n` +
      `Categories: ${CLASSIFICATIONS.join(', ')}.\n\n` +
      `Important:\n` +
      `- NOT_INTERESTED: use when they decline, pass, or say they do not want the offer — including "not interested in this," "we are not interested at this time," "no interest," "going to pass," "not a fit for us" (brief polite no).\n` +
      `- Do NOT use OTHER for a clear soft no; use NOT_INTERESTED instead.\n` +
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
      'Is the prospect clearly declining the offer, passing, or saying they do not want to proceed?\n' +
      'Respond with exactly YES or NO, nothing else.\n' +
      'YES for: "not interested," "we are not interested at this time," "no interest," "going to pass," "not a fit for us" (brief polite no).\n' +
      'NO if: they are asking a question, scheduling, expressing interest, requesting info, or the message is ambiguous/needs more context.',
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
      // Generous budget for a short reply. Plain text — truncation just = shorter reply.
      maxOutputTokens: 800,
      temperature: 0.4,
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

/** Second pass: when label is still OTHER, detect clear "no thanks" style declines. */
async function classifyNotInterestedSecondPass(threadContext, inboundMessage) {
  try {
    const model = buildNotInterestedCheckModel();
    const res = await model.generateContent(
      `Thread:\n${summarizeThread(threadContext)}\n\n` +
      `Latest prospect message:\n${inboundMessage}\n\n` +
      `Is the prospect clearly declining the offer?`
    );
    const t = (res.response.text() || '').trim().toUpperCase();
    if (t.startsWith('Y')) return 'NOT_INTERESTED';
  } catch (err) {
    console.error('[Classifier] not-interested second pass failed', { err: err.message });
  }
  return null;
}

async function draftOnly({ classification, threadContext, inboundMessage, voicePrompt, bookingLink, schedulingPromptBlock }) {
  const booking = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '[no booking link configured]';
  const scheduleCtx = schedulingPromptBlock || 'No verified availability was loaded.';

  const systemInstruction = `You ghostwrite a short, warm B2B sales reply in the client's voice.
Output: PLAIN TEXT reply only. No JSON, no markdown, no "Draft:" prefix. No quotes around the message.
Length: 2-4 short sentences, fewer is better.
Tone: friendly, warm, concise, practitioner-level, human.
Never begin with "Great question" or similar filler. Avoid excessive exclamation marks.

CLIENT VOICE:
${voicePrompt || 'Professional, direct, practitioner-level. No fluff.'}

CURRENT CLASSIFICATION: ${classification}
RULES BY CLASSIFICATION:
- INTERESTED / QUESTION: answer briefly, end with a soft ask for a call.
- OBJECTION: acknowledge the concern, then pivot.
- MEETING_PROPOSED: confirm warmly. If the verified availability block below lists two open times, offer exactly those two. If one, mention it. If none, invite them to pick via the booking link. Always include the booking URL once (full URL): ${booking}
- NOT_INTERESTED / COMPETITOR / WRONG_PERSON / REMOVE_ME / OTHER: brief, respectful acknowledgment. For REMOVE_ME confirm removal. For WRONG_PERSON ask for the right contact.

VERIFIED AVAILABILITY:
${scheduleCtx}
`;

  try {
    const model = buildDraftModel(systemInstruction);
    const res = await model.generateContent(
      `Thread:\n${summarizeThread(threadContext)}\n\n` +
      `Latest prospect reply:\n${inboundMessage}\n\n` +
      `Write the reply:`
    );
    return sanitizeDraft(res.response.text(), { inboundMessage, bookingLink, classification });
  } catch (err) {
    console.error('[Classifier] draft call failed', { err: err.message });
    return sanitizeDraft('', { inboundMessage, bookingLink, classification });
  }
}

/**
 * Two-call flow: classify, then draft (when needed).
 * Never throws. Always returns { classification, draft, proposed_time, reasoning }.
 */
async function classifyAndDraft(threadContext, inboundMessage, voicePrompt, bookingLink, schedulingPromptBlock) {
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
      voicePrompt,
      bookingLink,
      schedulingPromptBlock,
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
  CLASSIFICATIONS,
  DRAFT_CLASSIFICATIONS,
};
