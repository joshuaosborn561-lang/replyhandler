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
const {
  prospectBookingLink,
  rewriteRawCtapperCalendly,
} = require('../utils/public-booking-link');
const claudeReplyDraft = require('./claude-reply-draft');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OOO', 'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

// Interested-only Slack channels: draft + post only bookable positives.
const NO_REPLY_NEEDED = new Set([
  'OOO', 'OUT_OF_OFFICE', 'WRONG_PERSON', 'REMOVE_ME', 'COMPETITOR',
  'NOT_INTERESTED', 'OTHER', 'OBJECTION',
]);
/** Kept for fallback copy / tests — declines are no longer drafted for Slack. */
const DECLINE_CLASSIFICATIONS = new Set(['NOT_INTERESTED']);
/** Only these get an AI draft. Never expand without Josh. */
const DRAFT_CLASSIFICATIONS = Object.freeze(['INTERESTED', 'MEETING_PROPOSED', 'QUESTION']);

const DEFAULT_DRAFT_TZ = 'America/Chicago';
let loggedAnthropicBulkSkip = false;

/**
 * Claude+RAG is realtime webhooks only.
 * Pollers / backfill scripts MUST pass draftMode: 'bulk' — Claude is never used there.
 * There is intentionally no env opt-in to re-enable Claude on bulk (Aug 2026 burn).
 */
function isBulkDraftMode(draftMode) {
  return String(draftMode || 'realtime').toLowerCase() === 'bulk';
}

function shouldUseAnthropicDrafts({ draftMode } = {}) {
  if (!claudeReplyDraft.isConfigured()) return false;
  if (isBulkDraftMode(draftMode)) return false;
  return true;
}

function assertDraftableClassification(classification) {
  return DRAFT_CLASSIFICATIONS.includes(String(classification || '').toUpperCase());
}

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

function sanitizeDraft(text, { bookingLink, includeBookingLink, clientName } = {}) {
  let s = String(text || '').trim();
  // Strip markdown fences / leading role labels the model sometimes adds.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  s = s.replace(/^(draft|reply|response)\s*:\s*/i, '').trim();

  // If the model returned nothing, return empty — never substitute the old
  // "Totally fair question" canonical template (that was the repetition bug).
  if (!s) return '';

  s = stripSignOff(s);
  if (!s) return '';

  const link = prospectBookingLink({ clientName, bookingLink });

  // Corey Tapper's raw Calendly must never go out — public wrap only.
  s = rewriteRawCtapperCalendly(s, { includeBookingLink });

  if (includeBookingLink) {
    // Times + link drafts (and explicit asks) must include the URL.
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
  clientName,
  slotLabels,
} = {}) {
  void threadContext;
  const name = firstNameFromLead(leadName);
  const [d1, d2] = nextTwoBusinessDayLabels(digestTimezone || DEFAULT_DRAFT_TZ);
  const link = prospectBookingLink({ clientName, bookingLink });
  const msg = String(inboundMessage || '').trim();
  const labels = Array.isArray(slotLabels) ? slotLabels.filter(Boolean) : [];
  const time1 = labels[0] || `${d1} mid-morning`;
  const time2 = labels[1] || `${d2} early afternoon`;

  const { prefersInPersonMeeting, shouldIncludeBookingLink, meetingCta } = require('../utils/meeting-modality');
  const inPerson = prefersInPersonMeeting(voicePrompt);
  const wantLink = typeof includeBookingLink === 'boolean'
    ? includeBookingLink
    : shouldIncludeBookingLink(voicePrompt);

  if (DECLINE_CLASSIFICATIONS.has(classification)) {
    return (
      `Hey ${name}, thanks for getting back to me. Understood, no problem at all. ` +
      `Can I check back in a few months, or would you rather I take you off the list?`
    );
  }

  if (inPerson) {
    const clearInterest = classification === 'INTERESTED' && looksLikeClearInterest(msg);
    const ack = clearInterest
      ? 'Would love to see if this is a fit.'
      : 'Happy to stop by and walk through it in person.';
    const cta = meetingCta({ voicePrompt, day1: d1, day2: d2 });
    if (labels.length >= 2) {
      return (
        `Hey ${name}, thanks for getting back to me. ${ack} ` +
        `Does ${time1} or ${time2} work for me to stop by in person? ` +
        `${cta.neitherLine}`
      );
    }
    return (
      `Hey ${name}, thanks for getting back to me. ${ack} ` +
      `${cta.suggestLine} ${cta.neitherLine}`
    );
  }

  const { callWithWhom } = require('../utils/principal-voice');
  const whom = callWithWhom(voicePrompt);
  const linkBit = wantLink && link ? ` Here's the booking link if easier: ${link}` : '';

  // They already threw times — confirm those instead of inventing mid-morning defaults.
  if (classification === 'MEETING_PROPOSED' || looksLikeTheyProposedTimes(msg)) {
    const theirTimes = summarizeProposedTimes(msg);
    if (theirTimes) {
      return (
        `Hey ${name}, appreciate you throwing times over — ${theirTimes} works on my end. ` +
        `I'll send something over shortly. If that window shifted, just say the word.` +
        `${linkBit}`
      );
    }
    return (
      `Hey ${name}, appreciate you throwing times over. ` +
      `That window works on my end — I'll send something over shortly. ` +
      `If you need to shift it, just say the word.` +
      `${linkBit}`
    );
  }

  const clearInterest = classification === 'INTERESTED' && looksLikeClearInterest(msg);
  const ack = clearInterest
    ? 'Would love to see if this is a fit.'
    : 'Happy to jump on a quick call and walk through it.';
  return (
    `Hey ${name}, thanks for getting back to me. ${ack} ` +
    `Does ${time1} or ${time2} work for a quick call with ${whom}?` +
    `${linkBit}`
  );
}

/** Loose detect: prospect named a day/time window in their reply. */
function looksLikeTheyProposedTimes(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (/\b(monday|tuesday|wednesday|thursday|friday|tomorrow|today|next week)\b/i.test(s)
      && /\b(\d{1,2}\s*(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|\d{1,2}\s*-\s*\d{1,2}|noon|morning|afternoon|evening)\b/i.test(s)) {
    return true;
  }
  if (/\b\d{1,2}\s*(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\s*(est|edt|cst|cdt|mst|mdt|pst|pdt)?\b/i.test(s)) {
    return true;
  }
  return false;
}

/** Short plain fragment of the times they offered (best-effort). */
function summarizeProposedTimes(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';

  const day = (s.match(
    /\b((?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today))\b/i
  ) || [])[1];

  const window = (s.match(
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?\s*-\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?(?:\s*(?:est|edt|cst|cdt|mst|mdt|pst|pdt))?)/i
  ) || [])[1];

  const single = (s.match(
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)(?:\s*(?:est|edt|cst|cdt|mst|mdt|pst|pdt))?)/i
  ) || [])[1];

  const time = (window || single || '').replace(/\s+/g, ' ').trim();
  if (day && time) return `${day} ${time}`;
  if (day) return day;
  return time;
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

function buildTimeSuggestionBlock({
  digestTimezone, schedulingPromptBlock, includeBookingLink, voicePrompt,
}) {
  const { prefersInPersonMeeting, meetingCta } = require('../utils/meeting-modality');
  if (prefersInPersonMeeting(voicePrompt)) {
    const [d1, d2] = nextTwoBusinessDayLabels(digestTimezone || DEFAULT_DRAFT_TZ);
    return meetingCta({ voicePrompt, day1: d1, day2: d2 }).timeRule;
  }
  if (schedulingPromptBlock && /VERIFIED OPEN START TIMES/i.test(schedulingPromptBlock)) {
    return (
      `${schedulingPromptBlock}\n\n` +
      (includeBookingLink
        ? 'TIMES + BOOKING LINK: Suggest those two verified times in plain language, then include the booking URL once.'
        : 'TIMES-FIRST RULE: Suggest those two verified times in plain language. Do NOT paste any booking/Calendly URL in this reply.')
    );
  }
  const [d1, d2] = nextTwoBusinessDayLabels(digestTimezone || DEFAULT_DRAFT_TZ);
  if (includeBookingLink) {
    return (
      `TIMES + BOOKING LINK: Suggest two concrete options in the next few business days ` +
      `(e.g. ${d1} mid-morning or ${d2} early afternoon), then include the booking URL once.`
    );
  }
  return (
    `TIMES-FIRST RULE: Suggest two concrete options in the next few business days ` +
    `(e.g. ${d1} mid-morning or ${d2} early afternoon). ` +
    `Do NOT include any booking/Calendly URL or http link in this reply.`
  );
}

function buildSdrVoicePrompt({
  name, booking, classification, channel, includeBookingLink, voicePrompt,
  replyMode = 'FIRST_TOUCH',
  learnedVoiceBlock = '',
}) {
  const { speaksAsPrincipal } = require('../utils/principal-voice');
  const { prefersInPersonMeeting } = require('../utils/meeting-modality');
  const asPrincipal = speaksAsPrincipal(voicePrompt);
  const inPerson = prefersInPersonMeeting(voicePrompt);
  const isDecline = DECLINE_CLASSIFICATIONS.has(classification);
  const mode = String(replyMode || 'FIRST_TOUCH').toUpperCase() === 'CONTINUATION'
    ? 'CONTINUATION'
    : 'FIRST_TOUCH';
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
    : inPerson
    ? `- IN-PERSON MODE: Offer to stop by / meet in person. Never Zoom, phone, "quick call", "our CEO", Calendly, or any booking URL.\n` +
      `- Suggest 2 concrete times in the next few business days (only after acknowledging their point).\n` +
      `- Close by offering to work around their schedule if neither time works.`
    : includeBookingLink
    ? `- TIMES + BOOKING LINK: After acknowledging their point, suggest 2 concrete times in the next few business days.\n` +
      `- Then include this exact URL once near the end: ${link}\n` +
      `- Casual close is fine ("or grab a time here if easier").`
    : `- AFTER ACK: Do NOT include any booking URL, Calendly link, or http link.\n` +
      `- Suggest 2 concrete times in the next few business days (only after acknowledging their point).`;

  const roleLine = asPrincipal
    ? 'You ghostwrite replies as Joshua Osborn, founder/CEO (first person). You ARE the CEO — never say "our CEO" or "our founder", never hand off. Suggest a quick call with you ("with me").'
    : inPerson
    ? 'You ghostwrite replies for a B2B seller who meets prospects in person. Output PLAIN TEXT only. No markdown. No quotes around the message.'
    : 'You ghostwrite replies for a B2B SDR. Output PLAIN TEXT only. No markdown. No quotes around the message.';
  const modeRules = mode === 'CONTINUATION'
    ? `- CONTINUATION MODE: This is NOT their first reply. Do not use a first-touch "thanks for getting back to me" opener.\n` +
      `- Continue the thread — answer their latest point first ("Ok great…", "Fair enough…", "Sorry for the mixup…").`
    : `- FIRST_TOUCH MODE: Soft yes can use "thanks for getting back to me". Questions/objections must be answered before any CTA.`;

  const exampleA = asPrincipal
    ? `Prospect: "What's the catch?"
Reply: "Hey Scott, just gave you a ring. No catch...trying to provide some value on the front end for you. I know your inbox is full of this kind of stuff...time Monday morning or Tuesday to connect?"`
    : inPerson
    ? `Prospect: "What's the catch?"
Reply: "Hey Scott, no catch — happy to show you in person. Are you free mid-morning Tuesday or early afternoon Wednesday for me to stop by?"`
    : `Prospect: "What's the catch?"
Reply: "Hey Scott, just gave you a ring. No catch...trying to provide some value on the front end for you. Time Monday morning or Tuesday to connect?"`;

  const exampleB = asPrincipal
    ? `Prospect: "Sure."
Reply: "Hey Dean, thanks for getting back to me, sounds good! I have some time to connect before 11 CST to see if this makes sense? Or grab a time here if easier: ${link}"`
    : inPerson
    ? `Prospect: "Sure."
Reply: "Hey Dean, thanks for getting back to me, sounds good! Are you free Thursday mid-morning or Friday early afternoon for me to stop by in person? Happy to work around your schedule if neither works."`
    : `Prospect: "Sure."
Reply: "Hey Dean, thanks for getting back to me, sounds good! Happy to jump on a quick call — Thursday mid-morning or Friday early afternoon? Or grab a time here if easier: ${link}"`;

  const exampleC = inPerson
    ? `Prospect: "Can we do next week?"
Reply: "Absolutely — want me to stop by Monday or Tuesday afternoon? Whatever is easiest on your end."`
    : `Prospect: "Sure, send the link."
Reply: "Sounds good — here's the booking link: ${link}"`;

  const logisticalRule = asPrincipal
    ? '- If they ask a logistical question: answer briefly FIRST, then suggest a quick call with you'
    : inPerson
    ? '- If they ask a logistical question: answer briefly FIRST, then offer to stop by in person'
    : '- If they ask a logistical question: answer briefly FIRST, then suggest times';

  const clientVoice = String(voicePrompt || '').trim()
    ? `\nCLIENT VOICE (must follow):\n${String(voicePrompt).trim()}\n`
    : '';
  // Weekly-synthesized profile (voice-profile.js). Style guidance only — the
  // RULES block below still wins on booking link, sign-off, and modality.
  const learnedVoice = String(learnedVoiceBlock || '').trim()
    ? `\n${String(learnedVoiceBlock).trim()}\n`
    : '';

  return `${roleLine}
Output PLAIN TEXT only. No markdown. No quotes around the message.
${clientVoice}${learnedVoice}
Voice reference (match warmth/directness; ACK what they said before any CTA):

EXAMPLE A (answer the question first):
${exampleA}

EXAMPLE B (soft yes — first touch):
${exampleB}

EXAMPLE C (${inPerson ? 'they floated timing' : 'they asked for the link'}):
${exampleC}

EXAMPLE D (continuation / second inbound on cost):
Prospect: "What's the cost per lead?"
Reply: "Ok great! Most of my clients actually prefer a straight monthly cost, but I could do a per lead if you prefer. Would be around $300. If you're up for it I have 15 minutes right now actually...or we can chat later."

EXAMPLE E (provider already):
Prospect: "Normally I would, but we switched to a new provider a few months ago."
Reply: "Ah man, a few months too late! No worries. If you would still want the tickets, we do have quite a few clients that already have a partner....we just fill in any gaps. Not sure if that would be helpful?"

---

RULES:
- Greet with "Hey {first name}," — first name only
- ACK FIRST: react to their specific point before pitching times
- Warm, direct, a little playful when it fits — match their energy
${modeRules}
${logisticalRule}
${bookingRules}
- Prospect first name: ${name}
- Classification: ${classification}
- Draft mode: ${mode}

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

function finalizeDraft(text, {
  booking, includeBookingLink, voicePrompt, leadName, clientName,
}) {
  const { speaksAsPrincipal } = require('../utils/principal-voice');
  const { enforcePrincipalVoice } = require('../utils/principal-draft-guard');
  let draft = sanitizeDraft(text, { bookingLink: booking, includeBookingLink, clientName });
  const guarded = enforcePrincipalVoice(draft, {
    asPrincipal: speaksAsPrincipal(voicePrompt),
  });
  if (guarded.scrubbed) {
    console.warn('[Classifier] Scrubbed principal handoff leak', { leadName });
    draft = sanitizeDraft(guarded.text, { bookingLink: booking, includeBookingLink, clientName });
  }
  return draft;
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
  replyMode = 'FIRST_TOUCH',
  replyOrdinal = 1,
  clientName = null,
  clientId = null,
  draftMode = 'realtime',
}) {
  if (!assertDraftableClassification(classification)) {
    console.warn('[Classifier] Refusing draft for non-positive classification', {
      classification, leadName, draftMode,
    });
    return null;
  }

  const booking = prospectBookingLink({ clientName, bookingLink });
  const name = firstNameFromLead(leadName);
  const channel = String(platform || 'smartlead').toLowerCase() === 'heyreach' ? 'linkedin' : 'email';
  const mode = String(replyMode || 'FIRST_TOUCH').toUpperCase() === 'CONTINUATION'
    ? 'CONTINUATION'
    : 'FIRST_TOUCH';

  // Two times + booking link on every positive reply, except in-person clients.
  const { prefersInPersonMeeting, shouldIncludeBookingLink } = require('../utils/meeting-modality');
  const inPerson = prefersInPersonMeeting(voicePrompt);
  const includeBookingLink = typeof includeBookingLinkOverride === 'boolean'
    ? includeBookingLinkOverride
    : shouldIncludeBookingLink(voicePrompt);

  // Weekly-learned voice (global + this client). Best-effort; empty when the
  // Friday job has not run yet or the table is not migrated.
  const { loadLearnedVoiceBlock } = require('./voice-profile');
  const learnedVoiceBlock = await loadLearnedVoiceBlock({ clientId, clientName });

  const systemInstruction = buildSdrVoicePrompt({
    name,
    booking,
    classification,
    channel,
    includeBookingLink,
    voicePrompt,
    replyMode: mode,
    learnedVoiceBlock,
  });

  const timeBlock = buildTimeSuggestionBlock({
    digestTimezone,
    schedulingPromptBlock,
    includeBookingLink,
    voicePrompt,
  });

  const proposedTimesNote = (
    classification === 'MEETING_PROPOSED' || looksLikeTheyProposedTimes(inboundMessage)
  )
    ? 'They already proposed times — confirm or lightly counter those times. Do NOT invent unrelated mid-morning / early afternoon slots.'
    : null;

  const modeNote = inPerson
    ? `${mode} MODE: Acknowledge their latest point first, then offer to stop by in person. No Zoom/phone/CEO call/booking URL.`
    : includeBookingLink
    ? `${mode} MODE: Acknowledge their latest point first, then suggest two times AND include the booking URL once.`
    : `${mode} MODE: Acknowledge their latest point first, then suggest next step/times. Do NOT include any booking URL.`;

  const prompt =
    `Thread:\n${summarizeThread(threadContext)}\n\n` +
    `Latest prospect reply:\n${inboundMessage}\n\n` +
    `${proposedTimesNote ? `${proposedTimesNote}\n\n` : ''}` +
    `${timeBlock}\n\n` +
    `${modeNote}\n\n` +
    `Write the reply now. Acknowledge what they said before any CTA. Finish every sentence.`;

  const deterministicFallback = () => finalizeDraft(fallbackDraftText({
    leadName,
    inboundMessage,
    bookingLink: booking,
    classification,
    threadContext,
    digestTimezone,
    includeBookingLink,
    voicePrompt,
    clientName,
  }), { booking, includeBookingLink, voicePrompt, leadName, clientName });

  async function draftWithGemini() {
    const model = buildDraftModel(systemInstruction);
    let res = await withGeminiRetry(() => model.generateContent(prompt));
    let draft = finalizeDraft(res.response.text(), {
      booking, includeBookingLink, voicePrompt, leadName, clientName,
    });

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
      draft = finalizeDraft(res.response.text(), {
        booking, includeBookingLink, voicePrompt, leadName, clientName,
      });
      if (looksTruncatedDraft(draft)) {
        console.warn('[Classifier] Draft still truncated after retry — keeping model output (no template fallback)', {
          leadName,
          preview: draft.slice(-80),
        });
      }
    }

    if (!draft) {
      console.warn('[Classifier] Empty Gemini draft — using times-first fallback', { leadName, classification });
      return deterministicFallback();
    }
    return draft;
  }

  // Claude+RAG: realtime webhooks only. Bulk/poller/backfill never touch Anthropic.
  if (shouldUseAnthropicDrafts({ draftMode })) {
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
        replyMode: mode,
        replyOrdinal,
        clientName,
        draftMode,
        learnedVoiceBlock,
      });
      const draft = finalizeDraft(result.text, {
        booking, includeBookingLink, voicePrompt, leadName, clientName,
      });
      if (!draft) throw new Error('Claude draft was empty after sanitization');
      console.log('[Classifier] Claude retrieval draft generated', {
        model: result.model,
        examples: result.examples.length,
        leadName,
        replyMode: mode,
        replyOrdinal,
        draftMode,
      });
      return draft;
    } catch (err) {
      console.error('[Classifier] Claude retrieval draft failed — falling through to Gemini', {
        err: err.message,
        leadName,
      });
    }
  } else if (isBulkDraftMode(draftMode) && claudeReplyDraft.isConfigured() && !loggedAnthropicBulkSkip) {
    console.log('[Classifier] Claude drafts hard-disabled for bulk/poller/backfill (Gemini only).');
    loggedAnthropicBulkSkip = true;
  }

  try {
    return await draftWithGemini();
  } catch (err) {
    console.error('[Classifier] draft call failed — using times-first fallback', { err: err.message });
    return deterministicFallback();
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
  {
    leadName, digestTimezone, platform,
    clientId = null, leadId = null, leadEmail = null, clientName = null,
    draftMode = 'realtime',
  } = {},
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

  const { resolveReplyOrdinal } = require('../utils/reply-ordinal');
  const ordinal = await resolveReplyOrdinal({
    clientId, platform, leadId, leadEmail,
  });

  const needsDraft = assertDraftableClassification(classification);
  const { shouldIncludeBookingLink } = require('../utils/meeting-modality');
  const includeBookingLink = needsDraft && shouldIncludeBookingLink(voicePrompt);

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
      replyMode: ordinal.mode,
      replyOrdinal: ordinal.replyOrdinal,
      clientName,
      clientId,
      draftMode,
    })
    : null;

  const note = preGate ? ` (pre-gate: ${preGate})` : '';
  const linkNote = needsDraft
    ? (includeBookingLink ? ' (booking-link follow-up)' : ` (${ordinal.mode.toLowerCase()})`)
    : '';
  return {
    classification,
    draft,
    proposed_time: null,
    includeBookingLink,
    replyMode: ordinal.mode,
    replyOrdinal: ordinal.replyOrdinal,
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
  nextTwoBusinessDayLabels,
  fallbackDraftText,
  looksLikeClearInterest,
  looksTruncatedDraft,
  looksLikeBookingLinkRequest,
  buildTimeSuggestionBlock,
  sanitizeDraft,
  stripSignOff,
  shouldUseAnthropicDrafts,
  isBulkDraftMode,
  assertDraftableClassification,
  CLASSIFICATIONS,
  DRAFT_CLASSIFICATIONS,
  DECLINE_CLASSIFICATIONS,
  NO_REPLY_NEEDED,
};
