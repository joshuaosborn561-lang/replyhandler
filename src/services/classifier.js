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

function sanitizeDraft(text, { bookingLink, classification } = {}) {
  let s = String(text || '').trim();
  // Strip markdown fences / leading role labels the model sometimes adds.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/^(draft|reply|response)\s*:\s*/i, '').trim();

  // If the model returned nothing, return empty — never substitute the old
  // "Totally fair question" canonical template (that was the repetition bug).
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

/** Legacy helper kept for scripts/tests — NOT used by sanitizeDraft anymore. */
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
      thinkingConfig: { thinkingBudget: 0 },
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
      thinkingConfig: { thinkingBudget: 0 },
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
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
}

function buildDraftModel(systemInstruction) {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction,
    generationConfig: {
      // gemini-2.5-flash thinking tokens count against maxOutputTokens.
      // 1024 was frequently exhausted by thinking and cut drafts mid-sentence.
      maxOutputTokens: 8192,
      temperature: 0.7,
      responseMimeType: 'text/plain',
      // Disable thinking for short plain-text drafts (thinkingBudget: 0).
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
}

/** True when a draft looks cut off mid-sentence (no closing punctuation). */
function looksTruncatedDraft(text) {
  const s = String(text || '').trim();
  if (!s || s.length < 40) return false;
  if (/https?:\/\/\S+\s*$/i.test(s)) return false; // ends with booking URL — ok
  // Ends on sentence/punctuation (or closing quote/paren after punctuation)
  if (/[.!?…]["'`”’)\]]*\s*$/.test(s)) return false;
  // Signature / name / title closing lines are complete even without a period
  // e.g. "Joshua Osborn\nSalesGlider Growth" or "Best regards, Randy"
  const lastLine = s.split(/\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  if (
    lastLine.length <= 60 &&
    /^(best|thanks|thank you|regards|cheers|sincerely)\b/i.test(lastLine)
  ) return false;
  if (
    lastLine.length <= 48 &&
    /^[A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,5}$/.test(lastLine) &&
    !/\b(a|an|the|to|for|with|on|in|at|our|your|and|or|of|is|are|be|can|will|would|should|could|if|that|this|about)\b/i.test(lastLine)
  ) return false;
  // Mid-phrase cutoff (e.g. "…details on a quick")
  return true;
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

function buildSdrVoicePrompt({ name, booking, classification, channel }) {
  const link = booking || '{BOOKING_LINK}';
  const channelNote = channel === 'linkedin'
    ? 'This is a LinkedIn message. Keep it shorter - 1-2 sentences when possible. No sign-off or signature.'
    : 'This is an email reply. 2-4 sentences is fine. Optional first-name sign-off.';

  return `You ghostwrite replies for a B2B SDR. Output PLAIN TEXT only. No markdown. No quotes around the message.

Study these real examples from our actual SmartLead campaigns and match the voice exactly:

EXAMPLE 1:
Prospect: "Karl, We have interest in understanding your services. We use recruiters from time to time. When is a good time to talk about it? And we are Rangers fans. :)"
Reply: "Hey Thomas, Thanks for getting back to me. That sounds great- our CEO would love to chat to see how he can be most helpful. Here is his booking link, and he will send the tickets over after :) Thanks! ${link}"

EXAMPLE 2:
Prospect: "To a CU game?"
Reply: "Hey Karen, thanks for getting back to me. Yes Buffs or Rockies, take your pick. If you're open to it, our CEO can meet with you and see if we are a fit? Here's his calendar: ${link}"

EXAMPLE 3:
Prospect: "where are they located? Sent from my iPhone"
Reply: "Hey Ken, thanks for getting back to me. We have them in a few places...were you hoping for someone local? If easier you can grab a time with our CEO here and we can send you the tickets: ${link}"

EXAMPLE 4:
Prospect: "Normally I would, but we switched to a new provider a few months ago."
Reply: "Ah man, a few months too late! No worries. If you would still want the tickets, we do have quite a few clients that already have a partner....we just fill in any gaps. Not sure if that would be helpful?"

EXAMPLE 5:
Prospect: "It's possible we may be interested in MS help in the future. As of right now, I don't have any open projects."
Reply: "That's fair...would love to chat and hand you some tickets if you are open, can tee up a future convo when ready. Your call? Here is booking link with our CEO in case: ${link}"

EXAMPLE 6:
Prospect: "Thanks, I will pass at this time."
Reply: "Thanks for getting back to me, Marina. Understood, no problem at all. Can I check back in a few months or should I take you off the list? Ticket offer stands."

EXAMPLE 7:
Prospect: "Worth a reply. Tell me more."
Reply: "Awesome, thanks! Easiest will be to chat with our CEO, he is the one who built the whole thing out. Can you do tomorrow or Friday? ${link}"

EXAMPLE 8:
Prospect: "When is the game?"
Reply: "Hey Ron, Tickets are flexible. We can also do other teams. We can set something up with our CEO. What makes you think of considering a new partner?"

EXAMPLE 9:
Prospect: "I'm a Michigan fan"
Reply: "Oh man, I think that is the unforgivable sin then... Ha..if I made the switch to a Wolverines game would that help a conversation happen?"

EXAMPLE 10:
Prospect: "Lol I'm used to it. But to be candid I don't want to waste your time. We handle everything in house and have 0% interest in partnering at this time."
Reply: "Ha fair enough and I appreciate that...let me know if there is ever an opp to help, ticket offer stands."

EXAMPLE 11:
Prospect: "I'd be curious to learn more about your services and if you are a fit for our company."
Reply: "Hey Tony thanks for getting back. Yes would love to see if this is a fit. Let me set something up with our CEO. Does Tuesday work? You can book something here. ${link}"

EXAMPLE 12:
Prospect: "Sure, send them on over."
Reply: "Hey Brian, thanks for getting back to me. I'd be happy to after we hop on a call! We are obviously giving these away in good faith for a strategic call with IT decision makers. What does your day look like tomorrow?"

EXAMPLE 13:
Prospect: "Please send me your service offerings or direct me to the location on your website."
Reply: "Hey Kelvin, we tailor our service offerings to each client- would it be easier to chat for 10 minutes about what you need so I can send something over after? ${link}"

EXAMPLE 14:
Prospect: "We are currently under contract with another MSP but I am open to speaking with you about your capabilities."
Reply: "Thanks Jeff. Fyi, most of our clients were in the same spot so I understand. You can pick a time that works best here: ${link}"

EXAMPLE 15:
Prospect: "Unfortunately, I'm not looking for any outside advisory services at this time."
Reply: "Dustin, thanks for letting me know! I hear you- any chance this is relevant in the next 6 months? If so, my CEO would love to do lunch on him, just to talk shop. Worst case, you DQ us and you get out of the office. Fair enough?"

---

RULES (extracted from the examples above):
- Greet with "Hey {first name}," — always first name only, never full name
- Warm, direct, a little playful when the moment fits — match the prospect's energy
- If they're warm/interested: short acknowledgment + booking link + day suggestion ("Can you do tomorrow or Friday?")
- If they already have a provider: acknowledge it's fine, mention you fill gaps or can tee up a future conversation
- If they decline: graceful, offer to check back, keep the ticket offer alive — never push
- If they ask a logistical question (where, when, what): answer it and redirect to the CEO call
- Booking link placement: casual, at the end, as part of a question — never a formal line
- Prospect first name to address: ${name}
- Booking link: ${link}
- Classification: ${classification}

${channelNote}

Do NOT hallucinate offer details, pricing, or specifics not in the thread.
Do NOT use em dashes. Do NOT add a sign-off beyond a casual first name.
Always finish every sentence. Never cut off mid-thought.`;
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
  const name = firstNameFromLead(leadName);
  const channel = String(platform || 'smartlead').toLowerCase() === 'heyreach' ? 'linkedin' : 'email';
  const systemInstruction = buildSdrVoicePrompt({ name, booking, classification, channel });

  // voicePrompt / schedulingPromptBlock kept in signature for callers; few-shot voice is primary.
  void voicePrompt;
  void schedulingPromptBlock;
  void digestTimezone;

  const prompt =
    `Thread:\n${summarizeThread(threadContext)}\n\n` +
    `Latest prospect reply:\n${inboundMessage}\n\n` +
    `Write the reply now. Match the voice from the examples exactly. Finish every sentence.`;

  try {
    const model = buildDraftModel(systemInstruction);
    let res = await withGeminiRetry(() => model.generateContent(prompt));
    let draft = sanitizeDraft(res.response.text(), { bookingLink, classification });

    if (looksTruncatedDraft(draft)) {
      console.warn('[Classifier] Draft looked truncated — regenerating once', {
        leadName,
        preview: draft.slice(-80),
        finishReason: res.response?.candidates?.[0]?.finishReason,
      });
      res = await withGeminiRetry(() => model.generateContent(
        `${prompt}\n\nIMPORTANT: Your previous attempt was cut off mid-sentence. Write the COMPLETE reply ending with a full stop and the booking link if required.`
      ));
      draft = sanitizeDraft(res.response.text(), { bookingLink, classification });
      if (looksTruncatedDraft(draft)) {
        console.warn('[Classifier] Draft still truncated after retry — keeping model output (no template fallback)', {
          leadName,
          preview: draft.slice(-80),
        });
      }
    }

    return draft;
  } catch (err) {
    console.error('[Classifier] draft call failed', { err: err.message });
    return '';
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
  { leadName, digestTimezone, platform } = {},
) {
  // Deterministic pre-classification gates — kill drafts that should not exist.
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
  looksTruncatedDraft,
  CLASSIFICATIONS,
  DRAFT_CLASSIFICATIONS,
  NO_REPLY_NEEDED,
};
