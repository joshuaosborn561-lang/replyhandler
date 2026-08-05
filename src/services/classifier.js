const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  looksLikeOutOfOffice,
  looksLikeNotInterested,
  looksLikeWrongPerson,
} = require('../utils/smartlead-webhook-helpers');
const {
  looksLikeBookingLinkRequest,
  stripBookingUrls,
} = require('../utils/booking-link-intent');
const claudeReplyDraft = require('./claude-reply-draft');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OOO', 'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const NO_REPLY_NEEDED = new Set(['OOO', 'OUT_OF_OFFICE', 'WRONG_PERSON', 'REMOVE_ME', 'COMPETITOR']);
/** Declines still get a draft, but a graceful check-back one — never a times-first push. */
const DECLINE_CLASSIFICATIONS = new Set(['NOT_INTERESTED']);
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

/** Resolve a usable IANA TZ; null/invalid → America/Chicago. */
function resolveDraftTimeZone(timeZone) {
  let tz = String(timeZone || '').trim() || DEFAULT_DRAFT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return DEFAULT_DRAFT_TZ;
  }
}

/** Next weekday after today in the given IANA timezone (skips Sat/Sun). */
function nextBusinessDayLabel(timeZone = DEFAULT_DRAFT_TZ) {
  // Clients often have digest_timezone NULL — Intl throws on null/invalid TZ
  // and that was silently killing every follow-up card (hundreds of retries).
  const tz = resolveDraftTimeZone(timeZone);
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const longFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
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

const CLOSING_WORDS = /^(best|best regards|kind regards|warm regards|regards|thanks|thanks again|thank you|cheers|talk soon|speak soon|sincerely|all the best|appreciate it|looking forward)[,!.]?$/i;

/**
 * Drop a trailing sign-off from a draft. SmartLead sends with add_signature: true,
 * so anything the model adds here is a second signature stacked on the real one.
 * Conservative on purpose: only strips a closing word, an optional name line after
 * it, or a "- Name" dash line. Never touches a line that reads as a sentence.
 */
function stripSignOff(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');

  const isNameLine = (l) => (
    // One or two capitalized words, no sentence punctuation — e.g. "Josh" / "Josh O".
    /^[A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*)?$/u.test(l) && l.length <= 40
  );

  for (let guard = 0; guard < 4; guard += 1) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) break;
    const last = lines[lines.length - 1].trim();

    if (CLOSING_WORDS.test(last)) { lines.pop(); continue; }
    if (/^[-–—]\s*[A-Z][\p{L}'’.-]*$/u.test(last)) { lines.pop(); continue; }

    // A bare name line only counts as a sign-off when something precedes it.
    if (lines.length > 1 && isNameLine(last)) { lines.pop(); continue; }
    break;
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeDraft(text, { bookingLink, includeBookingLink } = {}) {
  let s = String(text || '').trim();
  // Strip markdown fences / leading role labels the model sometimes adds.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/^(draft|reply|response)\s*:\s*/i, '').trim();

  // If the model returned nothing, return empty — never substitute the old
  // "Totally fair question" canonical template (that was the repetition bug).
  if (!s) return '';

  s = stripSignOff(s);
  if (!s) return '';

  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';

  if (includeBookingLink) {
    // Prospect asked for / accepted the booking link — guarantee it is present.
    if (link && !s.includes(link)) {
      s = `${s.trim()}\n\n${link}`;
    }
  } else {
    // Times-first replies must not leak Calendly / booking URLs.
    s = stripBookingUrls(s, link);
  }

  return s;
}

function looksLikeClearInterest(msg) {
  const m = String(msg || '').trim().toLowerCase();
  if (!m || /\?/.test(m)) return false;
  return /\b(tell me more|i'?m interested|sounds good|let'?s (talk|chat|connect)|open to (a )?(chat|call)|would love to hear|happy to (chat|talk|connect))\b/.test(m);
}

/** Deterministic draft when Gemini is unavailable / returns empty. */
function fallbackDraftText({
  leadName,
  inboundMessage,
  bookingLink,
  classification,
  threadContext,
  digestTimezone,
  includeBookingLink,
  voicePrompt,
} = {}) {
  const name = firstNameFromLead(leadName);
  const [d1, d2] = nextTwoBusinessDayLabels(digestTimezone || DEFAULT_DRAFT_TZ);
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  const msg = String(inboundMessage || '').trim();
  const wantLink = typeof includeBookingLink === 'boolean'
    ? includeBookingLink
    : looksLikeBookingLinkRequest(msg, threadContext || '');

  if (wantLink) {
    return link
      ? `Hey ${name}, sounds good — here's the booking link: ${link}`
      : `Hey ${name}, sounds good — want me to send a couple of times instead?`;
  }

  if (DECLINE_CLASSIFICATIONS.has(classification)) {
    return (
      `Hey ${name}, thanks for getting back to me. Understood, no problem at all. ` +
      `Can I check back in a few months, or would you rather I take you off the list?`
    );
  }

  const clearInterest = classification === 'INTERESTED' && looksLikeClearInterest(msg);
  const ack = clearInterest
    ? 'Would love to see if this is a fit.'
    : 'Happy to jump on a quick call and walk through it.';
  const { callWithWhom } = require('../utils/principal-voice');
  const whom = callWithWhom(voicePrompt);
  return (
    `Hey ${name}, thanks for getting back to me. ${ack} ` +
    `Does ${d1} mid-morning or ${d2} early afternoon work for a quick call with ${whom}? ` +
    `If neither works I can send a booking link.`
  );
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

/** Next two weekday labels for time suggestions (skips weekends). */
function nextTwoBusinessDayLabels(timeZone = DEFAULT_DRAFT_TZ) {
  const tz = resolveDraftTimeZone(timeZone);
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const longFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
  const labels = [];
  let cursor = Date.now();
  for (let i = 0; i < 14 && labels.length < 2; i += 1) {
    cursor += 24 * 60 * 60 * 1000;
    const day = weekdayFmt.format(new Date(cursor));
    if (day === 'Sat' || day === 'Sun') continue;
    labels.push(longFmt.format(new Date(cursor)));
  }
  while (labels.length < 2) labels.push('next week');
  return labels;
}

function buildTimeSuggestionBlock({ digestTimezone, schedulingPromptBlock, includeBookingLink }) {
  if (includeBookingLink) {
    return 'The prospect wants the booking link — include it once. Keep the reply short.';
  }
  if (schedulingPromptBlock && /VERIFIED OPEN START TIMES/i.test(schedulingPromptBlock)) {
    return (
      `${schedulingPromptBlock}\n\n` +
      'TIMES-FIRST RULE: Suggest those two verified times in plain language. ' +
      'Say if neither works you can send a booking link. Do NOT paste any booking/Calendly URL in this reply.'
    );
  }
  const [d1, d2] = nextTwoBusinessDayLabels(digestTimezone || DEFAULT_DRAFT_TZ);
  return (
    `TIMES-FIRST RULE: Suggest two concrete options in the next few business days ` +
    `(e.g. ${d1} mid-morning or ${d2} early afternoon). ` +
    `Offer to send a booking link if neither works. Do NOT include any booking/Calendly URL or http link in this reply.`
  );
}

function buildSdrVoicePrompt({ name, booking, classification, channel, includeBookingLink, voicePrompt }) {
  const { speaksAsPrincipal } = require('../utils/principal-voice');
  const asPrincipal = speaksAsPrincipal(voicePrompt);
  const isDecline = DECLINE_CLASSIFICATIONS.has(classification);
  const link = booking || '{BOOKING_LINK}';
  const channelNote = channel === 'linkedin'
    ? 'This is a LinkedIn message. Keep it shorter - 1-2 sentences when possible. No sign-off or signature.'
    : 'This is an email reply. 2-4 sentences is fine. No sign-off and no signature — the sending mailbox appends its own.';

  const declineRules =
    `- DECLINE MODE: They said no or are not interested. Do NOT pitch, do NOT suggest times, do NOT include any link.\n` +
    `- Acknowledge gracefully in one line, no pushback and no guilt.\n` +
    `- Then ask ONE light question: whether you can check back in a few months, or should take them off the list.\n` +
    `- Keep it to 2 sentences. Never argue with their reason.`;

  const bookingRules = isDecline
    ? declineRules
    : includeBookingLink
    ? `- BOOKING LINK MODE: The prospect asked for the booking link or accepted our offer to send it.\n` +
      `- Include this exact URL once near the end: ${link}\n` +
      `- Keep it casual ("here's the link if easier"). Do not dump a long calendar pitch.`
    : `- TIMES-FIRST MODE (default): Do NOT include any booking URL, Calendly link, or http link.\n` +
      `- Suggest 2 concrete times in the next few business days.\n` +
      `- Close by offering to send a booking link if neither time works.\n` +
      `- Booking link exists for later follow-up only: ${link} — do not paste it now.`;

  const roleLine = asPrincipal
    ? 'You ghostwrite replies as Joshua Osborn, founder/CEO (first person). You ARE the CEO — never say "our CEO", never hand off to a CEO, never say "chat with our CEO". Suggest a quick call with you ("with me").'
    : 'You ghostwrite replies for a B2B SDR. Output PLAIN TEXT only. No markdown. No quotes around the message.';

  const exampleA = asPrincipal
    ? `Prospect: "Worth a reply. Tell me more."
Reply: "Awesome, thanks! Easiest is a quick chat — I built the whole thing out. Can you do Thursday mid-morning or Friday early afternoon? If neither works I can send a booking link."`
    : `Prospect: "Worth a reply. Tell me more."
Reply: "Awesome, thanks! Easiest will be a quick chat with our CEO — he built the whole thing out. Can you do Thursday mid-morning or Friday early afternoon? If neither works I can send a booking link."`;

  const exampleB = asPrincipal
    ? `Prospect: "I'd be curious to learn more about your services and if you are a fit for our company."
Reply: "Hey Tony thanks for getting back. Would love to see if this is a fit. Does Tuesday morning or Wednesday around 2 work for a quick call with me? If not, happy to send a booking link."`
    : `Prospect: "I'd be curious to learn more about your services and if you are a fit for our company."
Reply: "Hey Tony thanks for getting back. Would love to see if this is a fit. Does Tuesday morning or Wednesday around 2 work for a quick call with our CEO? If not, happy to send a booking link."`;

  const logisticalRule = asPrincipal
    ? '- If they ask a logistical question: answer briefly, then suggest a quick call with you and two times'
    : '- If they ask a logistical question: answer briefly, then suggest a quick CEO call with two times';

  const clientVoice = String(voicePrompt || '').trim()
    ? `\nCLIENT VOICE (must follow):\n${String(voicePrompt).trim()}\n`
    : '';

  return `${roleLine}
Output PLAIN TEXT only. No markdown. No quotes around the message.
${clientVoice}
Voice reference (match warmth/directness; do NOT copy booking-link habits from older examples):

EXAMPLE A (times-first — no link):
${exampleA}

EXAMPLE B (times-first — interest):
${exampleB}

EXAMPLE C (they asked for the link):
Prospect: "Sure, send the link."
Reply: "Sounds good — here's the booking link: ${link}"

EXAMPLE D (decline):
Prospect: "Thanks, I will pass at this time."
Reply: "Thanks for getting back to me, Marina. Understood, no problem at all. Can I check back in a few months or should I take you off the list? Ticket offer stands."

EXAMPLE E (provider already):
Prospect: "Normally I would, but we switched to a new provider a few months ago."
Reply: "Ah man, a few months too late! No worries. If you would still want the tickets, we do have quite a few clients that already have a partner....we just fill in any gaps. Not sure if that would be helpful?"

---

RULES:
- Greet with "Hey {first name}," — first name only
- Warm, direct, a little playful when it fits — match their energy
- If they decline: graceful, offer to check back — never push
${logisticalRule}
${bookingRules}
- Prospect first name: ${name}
- Classification: ${classification}

${channelNote}

Do NOT hallucinate offer details, pricing, or specifics not in the thread.
Do NOT use em dashes. Do NOT add any sign-off, closing line, or signature — no "Best," no "Thanks," and no name at the end. The mailbox appends the real signature on send. End on the last sentence of the message itself.
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
  includeBookingLink: includeBookingLinkOverride,
}) {
  const booking = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  const name = firstNameFromLead(leadName);
  const channel = String(platform || 'smartlead').toLowerCase() === 'heyreach' ? 'linkedin' : 'email';

  // Include Calendly only when the prospect asks for / accepts a booking link.
  // Otherwise suggest concrete times and offer to send a link later.
  const includeBookingLink = typeof includeBookingLinkOverride === 'boolean'
    ? includeBookingLinkOverride
    : looksLikeBookingLinkRequest(inboundMessage, threadContext);

  const systemInstruction = buildSdrVoicePrompt({
    name,
    booking,
    classification,
    channel,
    includeBookingLink,
    voicePrompt,
  });

  const timeBlock = buildTimeSuggestionBlock({
    digestTimezone,
    schedulingPromptBlock,
    includeBookingLink,
  });

  const modeNote = includeBookingLink
    ? 'BOOKING LINK MODE: Include the booking URL once. Keep it short.'
    : 'TIMES-FIRST MODE: Suggest two concrete times. Offer to send a booking link if neither works. Do NOT include any booking URL.';

  const prompt =
    `Thread:\n${summarizeThread(threadContext)}\n\n` +
    `Latest prospect reply:\n${inboundMessage}\n\n` +
    `${timeBlock}\n\n` +
    `${modeNote}\n\n` +
    `Write the reply now. Match the voice from the examples exactly. Finish every sentence.`;

  // When the Supabase + Anthropic pipeline is configured, Gemini is used only
  // for embedding/retrieval and Claude Sonnet 5 writes the actual draft.
  if (claudeReplyDraft.isConfigured()) {
    try {
      const result = await claudeReplyDraft.generateClaudeReply({
        inboundMessage,
        threadContext,
        classification,
        leadName,
        bookingLink: booking,
        schedulingPromptBlock: timeBlock,
        includeBookingLink,
        platform,
        voicePrompt,
      });
      const draft = sanitizeDraft(result.text, {
        bookingLink: booking,
        includeBookingLink,
      });
      if (!draft) throw new Error('Claude draft was empty after sanitization');
      console.log('[Classifier] Claude retrieval draft generated', {
        model: result.model,
        examples: result.examples.length,
        leadName,
      });
      return draft;
    } catch (err) {
      console.error('[Classifier] Claude retrieval draft failed — using deterministic fallback', {
        err: err.message,
        leadName,
      });
      return fallbackDraftText({
        leadName,
        inboundMessage,
        bookingLink: booking,
        classification,
        threadContext,
        digestTimezone,
        includeBookingLink,
        voicePrompt,
      });
    }
  }

  try {
    const model = buildDraftModel(systemInstruction);
    let res = await withGeminiRetry(() => model.generateContent(prompt));
    let draft = sanitizeDraft(res.response.text(), { bookingLink: booking, includeBookingLink });

    if (looksTruncatedDraft(draft)) {
      console.warn('[Classifier] Draft looked truncated — regenerating once', {
        leadName,
        includeBookingLink,
        preview: draft.slice(-80),
        finishReason: res.response?.candidates?.[0]?.finishReason,
      });
      const retryHint = includeBookingLink
        ? 'Write the COMPLETE reply ending with a full stop and the booking link.'
        : 'Write the COMPLETE reply ending with a full stop. Suggest times only — no booking URL.';
      res = await withGeminiRetry(() => model.generateContent(
        `${prompt}\n\nIMPORTANT: Your previous attempt was cut off mid-sentence. ${retryHint}`
      ));
      draft = sanitizeDraft(res.response.text(), { bookingLink: booking, includeBookingLink });
      if (looksTruncatedDraft(draft)) {
        console.warn('[Classifier] Draft still truncated after retry — keeping model output (no template fallback)', {
          leadName,
          preview: draft.slice(-80),
        });
      }
    }

    if (!draft) {
      console.warn('[Classifier] Empty Gemini draft — using times-first fallback', { leadName, classification });
      return fallbackDraftText({
        leadName,
        inboundMessage,
        bookingLink: booking,
        classification,
        threadContext,
        digestTimezone,
        includeBookingLink,
        voicePrompt,
      });
    }

    return draft;
  } catch (err) {
    console.error('[Classifier] draft call failed — using times-first fallback', { err: err.message });
    return fallbackDraftText({
      leadName,
      inboundMessage,
      bookingLink: booking,
      classification,
      threadContext,
      digestTimezone,
      includeBookingLink,
      voicePrompt,
    });
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
  const includeBookingLink = needsDraft
    ? looksLikeBookingLinkRequest(inboundMessage, threadContext)
    : false;

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
      includeBookingLink,
    })
    : null;

  const note = preGate ? ` (pre-gate: ${preGate})` : '';
  const linkNote = needsDraft
    ? (includeBookingLink ? ' (booking-link follow-up)' : ' (times-first)')
    : '';
  return {
    classification,
    draft,
    proposed_time: null,
    includeBookingLink,
    reasoning: needsDraft
      ? `Classified as ${classification}; draft generated${note}${linkNote}.`
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
  looksLikeBookingLinkRequest,
  buildTimeSuggestionBlock,
  sanitizeDraft,
  stripSignOff,
  CLASSIFICATIONS,
  DRAFT_CLASSIFICATIONS,
  DECLINE_CLASSIFICATIONS,
  NO_REPLY_NEEDED,
};
