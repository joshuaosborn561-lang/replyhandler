const { looksLikePositiveInterest } = require('../utils/smartlead-webhook-helpers');

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
  /\beasiest is a quick call with our ceo\b/i,
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

function topicLabelForOptions(topic) {
  if (!topic || topic === 'your interest') return 'that';
  if (topic === 'a demo') return 'a demo';
  if (topic === 'how it works') return 'how this works';
  if (topic === 'more detail') return 'that';
  if (topic === 'the right contact') return 'that';
  if (topic === 'scheduling') return 'scheduling';
  return topic;
}

function gentleOptionsLine(topic) {
  const label = topicLabelForOptions(topic);
  return `We have a few options on ${label} — we want to make sure something works for you and that it's a good fit.`;
}

function gentleCeoClose(link) {
  if (link) {
    return `If you're open to it, our CEO can walk through what might make sense on a quick call. Here's his calendar: ${link}`;
  }
  return 'If you\'re open to it, would a quick call with our CEO work to see what might make sense?';
}

function validateLineFromInbound(inboundMessage, classification) {
  const inbound = normalizeInbound(inboundMessage);
  const topic = topicFromInbound(inbound);
  const lower = inbound.toLowerCase();

  if (classification === 'OBJECTION') {
    if (topic === 'timing') return 'I totally understand — timing can be tricky.';
    if (/\bnot sure\b|\bskeptic|\bconcern|\bworr/.test(lower)) return 'I hear you, and that concern makes sense.';
    return 'I appreciate you sharing that — totally fair.';
  }

  if (topic === 'pricing') return 'That\'s a fair question on pricing.';
  if (topic === 'a demo') return 'Happy to talk through what a demo could look like.';
  if (topic === 'how it works') return 'Good question on how this works in practice.';
  if (topic === 'integration') return 'Makes sense you\'d want to understand the integration side.';
  if (topic === 'timeline') return 'Good question on timeline.';
  if (topic === 'your interest') return 'Really appreciate you getting back to me on this.';
  if (topic === 'scheduling') return 'Happy to find something that works on your end.';
  if (topic === 'more detail') return 'Happy to share more on that.';
  if (topic === 'the right contact') return 'Appreciate you flagging that.';
  if (/\?/.test(inbound)) return 'That\'s a good question.';
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
  const optionsLine = gentleOptionsLine(topic);
  const closeLine = gentleCeoClose(link);

  return `Hey ${name}, thanks for getting back to me. ${validate} ${optionsLine} ${closeLine}`;
}

function draftFollowsFormula(draft) {
  const s = String(draft || '').trim();
  if (!s) return false;
  if (BAD_DRAFT_PATTERNS.some((re) => re.test(s))) return false;
  if (!/thanks for getting back/i.test(s)) return false;
  if (!/few options/i.test(s)) return false;
  if (!/works for you|good fit/i.test(s)) return false;
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

  const systemInstruction = `Write a short, gentle B2B email reply. PLAIN TEXT only.

Follow this structure (warm, unhurried tone — not salesy or abrupt):
1. "Hey {first name}, thanks for getting back to me."
2. One sentence validating their specific question, concern, or interest (reference what THEY said).
3. "We have a few options on {topic} — we want to make sure something works for you and that it's a good fit."
4. Gently propose a quick call with our CEO and include this URL once: ${booking || '[no link]'}
   Example close: "If you're open to it, our CEO can walk through what might make sense on a quick call. Here's his calendar: {url}"

Rules:
- Gentle and human. No hard sell, no "easiest is", no jumping straight to booking.
- Do NOT start with "yes" or "yes — happy to".
- Do NOT invent pricing, features, or deliverables.
- Do NOT propose specific weekdays — use the booking link.
- MUST include "works for you" and "good fit" in the options sentence.

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
  if (classification === 'OTHER' && looksLikePositiveInterest(inboundMessage)) {
    const plain = String(inboundMessage || '');
    classification = /\b(where are (they|you) located|how much|what does .* cost|pricing)\b/i.test(plain)
      ? 'QUESTION'
      : 'INTERESTED';
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
