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
      `Categories: ${CLASSIFICATIONS.join(', ')}.`,
    generationConfig: {
      // ONE WORD. Cannot truncate meaningfully.
      maxOutputTokens: 16,
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
  const classification = await classifyOnly(threadContext, inboundMessage);
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
