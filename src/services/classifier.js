const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  looksLikeOutOfOffice,
  looksLikeNotInterested,
  looksLikeWrongPerson,
} = require('../utils/smartlead-webhook-helpers');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OOO', 'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const NO_REPLY_NEEDED = new Set(['OOO', 'OUT_OF_OFFICE', 'NOT_INTERESTED', 'WRONG_PERSON', 'REMOVE_ME', 'COMPETITOR']);
const DRAFT_CLASSIFICATIONS = CLASSIFICATIONS.filter((c) => !NO_REPLY_NEEDED.has(c));

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

function sanitizeDraft(text, { leadName, inboundMessage, bookingLink, classification } = {}) {
  let s = String(text || '').trim();
  // Strip markdown fences / leading role labels the model sometimes adds.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/^(draft|reply|response)\s*:\s*/i, '').trim();

  // If the model returned nothing, return empty — let the caller decide what to do.
  // (Old behavior: substitute a canonical fallback template. That template was the source of
  //  the "We have a few options on X" repetition complaint, so we no longer use it here.)
  if (!s) return '';

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
      temperature: 0.7,
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
  schedulingPromptBlock,
  digestTimezone,
  platform,
}) {
  const booking = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  const scheduleCtx = schedulingPromptBlock || 'No verified availability was loaded.';
  const name = firstNameFromLead(leadName);
  const nextDay = nextBusinessDayLabel(digestTimezone || DEFAULT_DRAFT_TZ);
  const clientCtx = String(voicePrompt || '').trim() || '(none provided)';

  const channel = String(platform || 'smartlead').toLowerCase() === 'heyreach' ? 'linkedin' : 'email';

  const systemInstruction = channel === 'linkedin'
    ? buildLinkedinSystemPrompt({ name, booking, clientCtx, scheduleCtx, classification })
    : buildEmailSystemPrompt({ name, booking, clientCtx, scheduleCtx, classification, nextDay });

  try {
    const model = buildDraftModel(systemInstruction);
    const res = await withGeminiRetry(() => model.generateContent(
      `Thread:\n${summarizeThread(threadContext)}\n\n` +
      `Latest prospect reply:\n${inboundMessage}\n\n` +
      `Write the reply. Match their length and energy. No filler. No template phrases.`
    ));
    return sanitizeDraft(res.response.text(), { leadName, inboundMessage, bookingLink, classification });
  } catch (err) {
    console.error('[Classifier] draft call failed', { err: err.message });
    return sanitizeDraft('', { leadName, inboundMessage, bookingLink, classification });
  }
}

function buildLinkedinSystemPrompt({ name, booking, clientCtx, classification }) {
  return `You ghostwrite a LinkedIn reply for a B2B SDR. Output PLAIN TEXT only. No markdown. No "Draft:" prefix. No quotes around the message.

WRITE LIKE THIS:
- 1-3 short sentences. Median is ONE sentence (~80 characters). Never more than 3.
- Match the prospect's energy and length. Short prospect = short reply.
- Often skip the greeting entirely. When you do greet, just first name + comma.
  Examples: "Sure.", "No worries.", "Thanks!", "Hey ${name},", "${name}, apologies for the delay."
- NEVER use full name. NEVER end with "Looking forward to..." or a signature line.
- Casual register. Contractions. All-lowercase is sometimes fine if it matches their vibe.
- Concrete numbers and proof when they help (only if explicitly in the thread or client context).

WHAT TO ACTUALLY SAY:
- Mirror their tone: skeptical -> explain and qualify back. Warm -> warm. Short -> short.
- Often ask ONE qualifying question back instead of pitching:
  "What caught your interest?", "What's your core offering?", "How are you handling X today?"
- CTA is a question, not a statement: "Time tomorrow to meet?", "Free to chat Thursday?"
- Only paste the booking link if you're proposing a time. Drop it casually with the question:
  "Time tomorrow to meet? ${booking || '{LINK}'}"

DO NOT:
- Do NOT say "we have a few options", "make sure this is a good fit", "our CEO can walk through",
  "thanks for getting back to me", "appreciate you sharing that", "happy to find something that works"
- Do NOT write more than 3 sentences
- Do NOT add a sign-off line, signature, or full name
- Do NOT hallucinate offer details (pricing, scope, deliverables). If unsure, defer to a call.
- Do NOT use em dashes (—) or en dashes (–). Use commas or a single hyphen (-) if needed.

CURRENT CLASSIFICATION: ${classification}
- INTERESTED / QUESTION / MEETING_PROPOSED: short reply, often ends with a question or booking link.
- OBJECTION: address it briefly and qualify back with one question.
- NOT_INTERESTED / COMPETITOR / WRONG_PERSON / REMOVE_ME: brief respectful one-liner. No booking push.

CLIENT CONTEXT:
${clientCtx}

BOOKING LINK (only paste if proposing a time):
${booking || '(none configured)'}`;
}

function buildEmailSystemPrompt({ name, booking, clientCtx, classification, nextDay }) {
  return `You ghostwrite a B2B sales email reply. Output PLAIN TEXT only. No markdown. No "Draft:" prefix. No quotes around the message.

WRITE LIKE THIS:
- 2-4 short sentences. Conversational, not corporate.
- Start with first-name greeting: "Hey ${name},"
- One acknowledgment sentence that reflects what they actually said (not a generic line).
  Match their tone: skeptical -> explain; warm -> warm; question -> answer briefly or defer to a call.
- If proposing a time, paste the booking link ONCE, inline with a question.
  Example: "Open to a quick 15 with our CEO ${nextDay}? ${booking || '{LINK}'}"
- Optional one-line sign-off with first name only. No "Best regards" / "Looking forward".

CONCRETE DETAILS:
- Use real numbers when they're in the thread or client context. Never invent them.
- Reference what they said specifically (not "thanks for sharing that").
- One thought per sentence. No clauses stacked together.

DO NOT:
- Do NOT say "we have a few options", "want to make sure this is a good fit",
  "our CEO can walk through what might make sense", "thanks for getting back to me",
  "appreciate you sharing that", "happy to find something that works"
- Do NOT pad with filler ("Just wanted to follow up and...", "Hope you're well")
- Do NOT promise specifics you can't verify in the thread
- Do NOT use em dashes (—) or en dashes (–). Use commas or a single hyphen (-) if needed.

CURRENT CLASSIFICATION: ${classification}
- INTERESTED / QUESTION / OBJECTION / OTHER: acknowledge specifically + propose a call, paste link once.
- MEETING_PROPOSED: confirm warmly; use verified times if listed, otherwise propose ${nextDay}.
- NOT_INTERESTED / COMPETITOR / WRONG_PERSON / REMOVE_ME: brief respectful acknowledgment only.

CLIENT CONTEXT:
${clientCtx}

BOOKING LINK (paste once if proposing a time):
${booking || '(none configured)'}`;
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
  { leadName, digestTimezone, platform } = {},
) {
  // Deterministic pre-classification gates — kill drafts that should not exist.
  // These are cheap regex checks; they short-circuit Gemini for obvious cases.
  let classification = null;
  let preGate = null;
  if (looksLikeOutOfOffice(inboundMessage)) { classification = 'OOO'; preGate = 'ooo'; }
  else if (looksLikeWrongPerson(inboundMessage)) { classification = 'WRONG_PERSON'; preGate = 'wrong_person'; }
  else if (looksLikeNotInterested(inboundMessage)) { classification = 'NOT_INTERESTED'; preGate = 'not_interested'; }

  if (!classification) {
    classification = await classifyOnly(threadContext, inboundMessage);
    if (classification === 'OTHER') {
      const ooo = await classifyOooSecondPass(threadContext, inboundMessage);
      if (ooo === 'OOO') classification = 'OOO';
    }
    if (classification === 'OTHER') {
      const no = await classifyNotInterestedSecondPass(threadContext, inboundMessage);
      if (no === 'NOT_INTERESTED') classification = 'NOT_INTERESTED';
    }
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
      platform,
    })
    : null;

  const note = preGate ? ` (pre-gate: ${preGate})` : '';
  return {
    classification,
    draft,
    proposed_time: null,
    reasoning: needsDraft
      ? `Classified as ${classification}; draft generated${note}.`
      : `Classified as ${classification}; no draft${note}.`,
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
