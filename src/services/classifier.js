const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OOO', 'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const DRAFT_CLASSIFICATIONS = CLASSIFICATIONS.filter((c) => c !== 'OUT_OF_OFFICE' && c !== 'OOO');

const NO_BOOKING_CLASSIFICATIONS = new Set(['NOT_INTERESTED', 'COMPETITOR', 'WRONG_PERSON', 'REMOVE_ME']);

/** Drafts that skip validation / the "few options" bridge. */
const BAD_DRAFT_PATTERNS = [
  /^hey \w+, yes\b/i,
  /\byes — happy to\b/i,
  /\byes, absolutely\b/i,
  /\bgrab a time with our ceo that works\b/i,
  /\bhere'?s his calendar:\s*https?:\/\//i,
  /\bwould \w+day work\b/i,
  /\bmake sure it'?s a good fit\b/i,
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

function topicFromInbound(inboundMessage) {
  const t = normalizeInbound(inboundMessage).toLowerCase();
  const topics = [
    [/\bpric(e|ing)\b|\bcost\b|\bbudget\b|\brate\b/, 'pricing'],
    [/\bdemo\b|\bwalkthrough\b/, 'a demo'],
    [/\bhow (does|do) it work\b|\bhow this works\b/, 'how it works'],
    [/\bintegrat(e|ion|es)\b/, 'integration'],
    [/\btimeline\b|\bwhen can\b|\bhow long\b/, 'timeline'],
    [/\bmore (info|information|details)\b|\btell me more\b/, 'more detail'],
    [/\bnot (the )?right (person|contact)\b|\bwrong person\b/, 'the right contact'],
    [/\btoo busy\b|\bbad timing\b|\bnot (a )?good time\b|\bswamped\b|\blater\b/, 'timing'],
    [/\binterested\b|\bsounds good\b|\bsounds interesting\b|\blet'?s talk\b|\bhappy to chat\b/, 'your interest'],
    [/\bcall\b|\bmeet\b|\bschedule\b|\btimes?\b|\bcalendar\b/, 'scheduling'],
  ];
  for (const [re, label] of topics) {
    if (re.test(t)) return label;
  }
  return '';
}

function validateLineFromInbound(inboundMessage, classification) {
  const inbound = normalizeInbound(inboundMessage);
  const topic = topicFromInbound(inbound);
  const lower = inbound.toLowerCase();

  if (classification === 'OBJECTION') {
    if (topic === 'timing') return 'I totally get the timing piece.';
    if (/\bnot sure\b|\bskeptic|\bconcern|\bworr/.test(lower)) return 'I hear the concern — that makes sense.';
    return 'Totally fair pushback.';
  }

  if (topic === 'pricing') return 'Totally fair question on pricing.';
  if (topic === 'a demo') return 'Happy to walk through what a demo would look like.';
  if (topic === 'how it works') return 'Good question on how this works in practice.';
  if (topic === 'integration') return 'Makes sense you\'d want to understand the integration side.';
  if (topic === 'timeline') return 'Good question on timeline.';
  if (topic === 'your interest') return 'Great to hear you\'re open to this.';
  if (topic === 'scheduling') return 'Happy to find a time that works.';
  if (topic === 'more detail') return 'Happy to share more detail on that.';
  if (topic === 'the right contact') return 'Appreciate you flagging that.';
  if (topic === 'your interest') return 'Great to hear you\'re open to this.';
  if (/\?/.test(inbound)) return 'Good question.';
  if (inbound.length > 10) return 'Appreciate you sharing that.';
  return 'Appreciate the note.';
}

/**
 * Friendly formula: thanks → validate their message → few options → CEO booking.
 */
function composeInboundDraft({ leadName, inboundMessage, bookingLink, classification } = {}) {
  const name = firstNameFromLead(leadName);
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';

  if (classification && NO_BOOKING_CLASSIFICATIONS.has(classification)) {
    return `Hey ${name}, thanks for getting back to me — totally understand, and I appreciate you letting me know.`;
  }

  const validate = validateLineFromInbound(inboundMessage, classification);
  const topic = topicFromInbound(inboundMessage);
  const optionsLine = topic
    ? `We have a few options for ${topic === 'your interest' ? 'that' : topic} — easiest is a quick call with our CEO.`
    : 'We have a few options for that — easiest is a quick call with our CEO.';

  if (link) {
    return `Hey ${name}, thanks for getting back to me. ${validate} ${optionsLine} Here's his calendar: ${link}`;
  }
  return `Hey ${name}, thanks for getting back to me. ${validate} ${optionsLine} Would that work for you?`;
}

function draftFollowsFormula(draft) {
  const s = String(draft || '').trim();
  if (!s) return false;
  if (BAD_DRAFT_PATTERNS.some((re) => re.test(s))) return false;
  if (!/thanks for getting back/i.test(s)) return false;
  if (!/few options/i.test(s)) return false;
  if (!/\bceo\b/i.test(s)) return false;
  return true;
}

function sanitizeDraft(text, { leadName, inboundMessage, bookingLink, classification } = {}) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/^(draft|reply|response)\s*:\s*/i, '').trim();

  if (!s || !draftFollowsFormula(s)) {
    s = composeInboundDraft({ leadName, inboundMessage, bookingLink, classification });
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
      `Use OOO for out-of-office / auto-replies.`,
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
      'Is this an out-of-office or automatic reply? Respond YES or NO only.',
    generationConfig: { maxOutputTokens: 8, temperature: 0, responseMimeType: 'text/plain' },
  });
}

function buildNotInterestedCheckModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction:
      'Is this a clear not-interested / no thanks decline? Respond YES or NO only.',
    generationConfig: { maxOutputTokens: 8, temperature: 0, responseMimeType: 'text/plain' },
  });
}

function buildDraftModel(systemInstruction) {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction,
    generationConfig: {
      maxOutputTokens: 280,
      temperature: 0.45,
      responseMimeType: 'text/plain',
    },
  });
}

function summarizeThread(threadContext) {
  if (!threadContext) return '(no prior thread)';
  if (typeof threadContext === 'string') return threadContext.slice(0, 1500);
  try {
    return JSON.stringify(threadContext, null, 2).slice(0, 1500);
  } catch {
    return '(unserializable thread)';
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

async function classifyOnly(threadContext, inboundMessage) {
  try {
    const model = buildClassifyModel();
    const res = await withGeminiRetry(() => model.generateContent(
      `Thread:\n${summarizeThread(threadContext)}\n\n` +
      `Latest prospect reply:\n${inboundMessage}\n\nCategory:`
    ));
    return normalizeClassification(res.response.text().trim());
  } catch (err) {
    console.error('[Classifier] classify call failed', { err: err.message });
    return 'OTHER';
  }
}

async function classifyOooSecondPass(threadContext, inboundMessage) {
  try {
    const model = buildOooCheckModel();
    const res = await model.generateContent(`Message:\n${inboundMessage}\n\nOOO?`);
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
    const res = await model.generateContent(`Message:\n${inboundMessage}\n\nDecline?`);
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
    return composeInboundDraft({ leadName, inboundMessage, bookingLink, classification });
  }

  const systemInstruction = `Write a short, friendly B2B email reply. PLAIN TEXT only.

Follow this EXACT structure (3-4 sentences, warm tone):
1. "Hey {first name}, thanks for getting back to me."
2. One sentence that validates or acknowledges their specific question/concern/interest — reference what THEY said (pricing, integration, timing, demo, etc.). Do not be generic.
3. "We have a few options for that" (or "for {topic}") — then propose a quick call with our CEO.
4. Include the CEO booking URL once: ${booking || '[no link]'}

Rules:
- Friendly and human, not salesy or abrupt.
- Do NOT start with "yes" or "yes — happy to".
- Do NOT invent pricing, features, or deliverables.
- Do NOT propose specific weekdays ("Tuesday works") — use the booking link.
- Vary the validation sentence based on their message.

Prospect first name: ${name}
${voicePrompt ? `Voice notes: ${voicePrompt}` : ''}`;

  try {
    const model = buildDraftModel(systemInstruction);
    const res = await withGeminiRetry(() => model.generateContent(
      `Their message:\n"""${inbound}"""\n\n` +
      `Write the reply using the 4-part structure. Sentence 2 must reflect their specific message:`
    ));
    return sanitizeDraft(res.response.text(), {
      leadName, inboundMessage, bookingLink, classification,
    });
  } catch (err) {
    console.error('[Classifier] draft call failed', { err: err.message });
    return composeInboundDraft({ leadName, inboundMessage, bookingLink, classification });
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
  composeInboundDraft,
  composeInboundYesDraft: composeInboundDraft,
  sanitizeDraft,
  CLASSIFICATIONS,
  DRAFT_CLASSIFICATIONS,
};
