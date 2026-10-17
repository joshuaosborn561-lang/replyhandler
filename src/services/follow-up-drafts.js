const { firstNameFromLead } = require('./classifier');

/**
 * FOLLOW_UP drafts.
 *
 * Primary path: Claude Sonnet + RAG continues the thread (even from cron).
 * Gemini if Claude errors or the per-run cap is hit. The templates below
 * (`bumpForOffer` / `timesTakenBump`) are last-resort only.
 *
 * Last-resort step 1 is still a short offer-first nudge. Last-resort step 2+
 * says those times were taken, offers two new times, and includes the
 * booking link (except in-person / callback). Step 3+ never uses dashes —
 * use "..." instead. Never open with "thanks for getting back to me".
 */

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** What offer did our last send lean on? */
function detectOffer(lastOutboundMessage) {
  const s = norm(lastOutboundMessage).toLowerCase();
  if (!s) return { kind: 'generic' };

  if (/\b(ticket|tix)\b/.test(s) || /\b(marlins|rangers|astros|yankees|mets|cubs|dodgers|padres|twins|guardians|orioles|rays|royals|tigers|angels|mariners|nationals|phillies|braves|cardinals|brewers|pirates|reds|rockies|diamondbacks|giants|blue jays|white sox|red sox)\b/.test(s)) {
    const team = (s.match(/\b(marlins|rangers|astros|yankees|mets|cubs|dodgers|padres|twins|guardians|orioles|rays|royals|tigers|angels|mariners|nationals|phillies|braves|cardinals|brewers|pirates|reds|rockies|diamondbacks|giants)\b/) || [])[1];
    return { kind: 'tickets', team: team ? team.charAt(0).toUpperCase() + team.slice(1) : null };
  }
  if (/\bfree campaign\b/.test(s) || /\b10k\s*leads?\b/.test(s) || (/\bon me\b/.test(s) && /\bcampaign\b/.test(s))) {
    return { kind: 'free_campaign' };
  }
  if (/\b(video|loom)\b/.test(s)) {
    return { kind: 'video' };
  }
  if (/\bcase study\b/.test(s)) {
    return { kind: 'case_study' };
  }
  return { kind: 'generic' };
}

/**
 * Short "meeting for X" phrase pulled from the outbound value prop.
 * Used in every bump so we reframe what was originally offered.
 */
function valuePropPhrase(offer, lastOutboundMessage) {
  const kind = offer?.kind || 'generic';
  if (kind === 'tickets') {
    return offer.team ? `${offer.team} tickets` : 'the tickets';
  }
  if (kind === 'free_campaign') {
    return 'a free campaign to get you more business clients';
  }
  if (kind === 'video') {
    return 'the video I sent over';
  }
  if (kind === 'case_study') {
    return 'the case study';
  }

  const s = norm(lastOutboundMessage);
  if (!s) return 'this';

  if (/\bmore business clients\b/i.test(s)) return 'getting you more business clients';
  if (/\bwarranty\b/i.test(s)) return 'the warranty program';
  if (/\broof/i.test(s)) return 'roofing work';
  if (/\bstaff(ing)?\b/i.test(s)) return 'staffing help';
  if (/\bleads?\b/i.test(s) && /\b(campaign|outbound|email)\b/i.test(s)) {
    return 'getting you more leads';
  }
  if (/\b(cyber|msp|it support|managed (it|services))\b/i.test(s)) {
    return 'the IT / cyber conversation';
  }
  return 'this';
}

function ticketPhrase(offer) {
  if (offer.team) return `some ${offer.team} tix`;
  return 'some tickets';
}

/** Step 3+ copy: never em/en dashes or spaced hyphen dashes — use "...". */
function scrubDashes(text) {
  return String(text || '')
    .replace(/[—–]/g, '...')
    .replace(/\s+-\s+/g, '...')
    .replace(/\s*\.\.\.\s*/g, '...')
    .replace(/\.{4,}/g, '...')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Short bump copy keyed by offer + cadence step.
 * Step 1 ≈ same-day 3:30pm CT (or next day if inbound after 2pm CT);
 * later steps rotate phrasing so we don't spam the same line.
 * Every step reframes the original value prop.
 */
function bumpForOffer({
  name, offer, step, inPerson = false, callback = false, lastOutboundMessage = '',
} = {}) {
  const n = Number(step) || 1;
  const kind = offer.kind || 'generic';
  const x = valuePropPhrase(offer, lastOutboundMessage);
  const { DEEP_ROOTS_CALLER, DEEP_ROOTS_FROM_NUMBER } = require('../utils/meeting-modality');

  let text;

  if (callback) {
    if (n <= 1) {
      text = `Hey ${name}, still interested in ${x}? What time works best? ${DEEP_ROOTS_CALLER} will give you a call from ${DEEP_ROOTS_FROM_NUMBER}.`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...still happy to have ${DEEP_ROOTS_CALLER} call about ${x}. What time works best? He'll call from ${DEEP_ROOTS_FROM_NUMBER}.`;
    } else {
      text = `Hey ${name}, last nudge from me...${DEEP_ROOTS_CALLER} can still call about ${x} whenever works. What time is best? He'll be at ${DEEP_ROOTS_FROM_NUMBER}.`;
    }
  } else if (inPerson) {
    if (n <= 1) {
      text = `Hey ${name}, still interested in me stopping by in person for ${x}?`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...still happy to stop by in person about ${x}. Any time next week free?`;
    } else {
      text = `Hey ${name}, last nudge from me...still glad to meet in person for ${x} if useful. Want me to swing by?`;
    }
  } else if (kind === 'tickets') {
    const tix = ticketPhrase(offer);
    if (n <= 1) {
      text = `Hey ${name}, still interested in meeting for ${x}? Happy to send you ${tix} just for the convo.`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...${tix} still on me if you want to chat about ${x}. Any time next week work?`;
    } else {
      text = `Hey ${name}, last nudge from me...still interested in meeting for ${x} (${tix} just for the convo). Want me to grab a time?`;
    }
  } else if (kind === 'free_campaign') {
    if (n <= 1) {
      text = `Hey ${name}, still interested in meeting for ${x}? I was offering a free campaign to 10k leads on me....time in the afternoon next week?`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...still interested in meeting for ${x}. Free campaign to 10k leads still on me. Afternoon next week?`;
    } else {
      text = `Hey ${name}, last nudge...still interested in meeting for ${x}. Free campaign to 10k leads still on me. Should I send times?`;
    }
  } else if (kind === 'video') {
    if (n <= 1) {
      text = `Hey ${name}, did that video come through? Still interested in meeting for ${x} if it looks relevant...`;
    } else if (n === 2) {
      text = `Hey ${name}, just checking the video landed...still interested in meeting for ${x}?`;
    } else {
      text = `Hey ${name}, last bump on the video...still interested in meeting for ${x} if useful.`;
    }
  } else if (kind === 'case_study') {
    if (n <= 1) {
      text = `Hey ${name}, still interested in meeting for ${x}? Happy to send the case study either way.`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...case study still handy, or we can meet on ${x}.`;
    } else {
      text = `Hey ${name}, last nudge...still interested in meeting for ${x}. Case study is yours either way.`;
    }
  } else if (n <= 1) {
    text = `Hey ${name}, still interested in meeting for ${x}?`;
  } else if (n === 2) {
    text = `Hey ${name}, bumping this...still interested in meeting for ${x}?`;
  } else {
    text = `Hey ${name}, last nudge from me...still interested in meeting for ${x} if useful.`;
  }

  return n >= 3 ? scrubDashes(text) : text;
}

function slotLabelsFrom(slots, digestTimezone) {
  const labels = (slots || [])
    .map((s) => (s && typeof s === 'object' ? s.label : s))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (labels.length >= 2) return labels.slice(0, 2);
  const { nextTwoBusinessDayLabels } = require('./classifier');
  const [d1, d2] = nextTwoBusinessDayLabels(digestTimezone);
  return [labels[0] || `${d1} mid-morning`, labels[1] || `${d2} early afternoon`];
}

/**
 * Next-day (step 2+) refresh: those times were taken, here are two more,
 * plus the booking link (except in-person).
 */
function timesTakenBump({
  name,
  offer,
  step,
  inPerson = false,
  callback = false,
  lastOutboundMessage = '',
  slots,
  bookingLink,
  digestTimezone,
} = {}) {
  const n = Number(step) || 2;
  const x = valuePropPhrase(offer, lastOutboundMessage);
  if (callback) {
    return bumpForOffer({ name, offer, step: n, callback: true, lastOutboundMessage });
  }
  const [a, b] = slotLabelsFrom(slots, digestTimezone);
  const link = String(bookingLink || '').trim();

  let text;
  if (inPerson) {
    if (n === 2) {
      text = `Hey ${name}, those times got taken...does ${a} or ${b} work for me to stop by in person about ${x}?`;
    } else {
      text = `Hey ${name}, last nudge...those times got taken too. Does ${a} or ${b} work to stop by for ${x}?`;
    }
  } else {
    const linkBit = link ? ` Or grab a time here: ${link}` : '';
    if (n === 2) {
      text = `Hey ${name}, those times got taken...does ${a} or ${b} work instead to chat about ${x}?${linkBit}`;
    } else {
      text = `Hey ${name}, last nudge...those times got taken too. Does ${a} or ${b} work for ${x}?${linkBit}`;
    }
  }
  return n >= 3 ? scrubDashes(text) : text;
}

function fallbackReattempt({
  leadName,
  platform,
  bookingLink,
  digestTimezone,
  voicePrompt,
  lastOutboundMessage,
  step,
  slots,
  clientName,
} = {}) {
  void platform;
  const { prefersInPersonMeeting, prefersCallbackCall } = require('../utils/meeting-modality');
  const name = firstNameFromLead(leadName);
  const offer = detectOffer(lastOutboundMessage);
  const inPerson = prefersInPersonMeeting(voicePrompt);
  const callback = prefersCallbackCall(voicePrompt, clientName);
  const n = Number(step) || 1;
  if (callback) {
    return bumpForOffer({
      name,
      offer,
      step: n,
      callback: true,
      lastOutboundMessage,
    });
  }
  if (n >= 2) {
    return timesTakenBump({
      name,
      offer,
      step: n,
      inPerson,
      lastOutboundMessage,
      slots,
      bookingLink: inPerson ? '' : bookingLink,
      digestTimezone,
    });
  }
  return bumpForOffer({
    name,
    offer,
    step,
    inPerson,
    lastOutboundMessage,
  });
}

const DEFAULT_CLAUDE_CAP = 25;

let claudeCallsThisRun = 0;
let claudeCostUsdThisRun = 0;

function resetFollowUpClaudeBudget() {
  claudeCallsThisRun = 0;
  claudeCostUsdThisRun = 0;
}

function followUpClaudeCap() {
  const n = parseInt(process.env.FOLLOW_UP_CLAUDE_CAP || '', 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return DEFAULT_CLAUDE_CAP;
}

function followUpClaudeBudgetSnapshot() {
  return {
    calls: claudeCallsThisRun,
    cap: followUpClaudeCap(),
    estimatedUsd: Math.round(claudeCostUsdThisRun * 10000) / 10000,
  };
}

function estimateClaudeUsd(usage) {
  const inTok = Number(usage?.input_tokens || 0);
  const outTok = Number(usage?.output_tokens || 0);
  const inRate = Number(process.env.FOLLOW_UP_CLAUDE_INPUT_USD_PER_MTOK || 3);
  const outRate = Number(process.env.FOLLOW_UP_CLAUDE_OUTPUT_USD_PER_MTOK || 15);
  return (inTok * inRate + outTok * outRate) / 1e6;
}

function sanitizeFollowUpText(text, {
  bookingLink, voicePrompt, leadName, clientName, loopContactPhrase,
} = {}) {
  const { stripSignOff } = require('./classifier');
  const { stripBookingUrls } = require('../utils/booking-link-intent');
  const { rewriteRawCtapperCalendly, prospectBookingLink } = require('../utils/public-booking-link');
  const { prefersInPersonMeeting, prefersCallbackCall } = require('../utils/meeting-modality');
  const { enforcePrincipalVoice } = require('../utils/principal-draft-guard');
  const { speaksAsPrincipal } = require('../utils/principal-voice');

  let draft = stripSignOff(String(text || '').trim());
  if (!draft) return '';
  const inPerson = prefersInPersonMeeting(voicePrompt);
  const callback = prefersCallbackCall(voicePrompt, clientName);
  const link = prospectBookingLink({ clientName, bookingLink });
  draft = rewriteRawCtapperCalendly(draft, { includeBookingLink: !(inPerson || callback) });
  if (inPerson || callback) {
    draft = stripBookingUrls(draft, link);
  }
  const asPrincipal = speaksAsPrincipal(voicePrompt);
  const guarded = enforcePrincipalVoice(draft, { asPrincipal });
  if (guarded.scrubbed) {
    console.warn('[FollowUp] Scrubbed principal handoff leak', { leadName });
    draft = guarded.text;
  }
  if (!asPrincipal) {
    const { rewriteLoopInCopy, clientLoopContactPhrase } = require('../utils/client-loop-contact');
    const phrase = loopContactPhrase
      || clientLoopContactPhrase({ voicePrompt, clientName });
    if (phrase) draft = rewriteLoopInCopy(draft, phrase);
  }
  return scrubDashes(draft);
}

function lastResortTemplate(opts) {
  return fallbackReattempt({
    leadName: opts.leadName,
    platform: opts.platform,
    bookingLink: opts.bookingLink,
    digestTimezone: opts.digestTimezone,
    voicePrompt: opts.voicePrompt,
    lastOutboundMessage: opts.lastOutboundMessage,
    step: opts.step,
    slots: opts.slots,
    clientName: opts.clientName,
  });
}

async function generateFollowUpGeminiDraft(opts) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini is not configured');
  }
  const { buildFollowUpPrompt } = require('./claude-reply-draft');
  const { speaksAsPrincipal } = require('../utils/principal-voice');
  const asPrincipal = speaksAsPrincipal(opts.voicePrompt);
  const { system, user } = buildFollowUpPrompt({
    ...opts,
    lastInboundMessage: opts.lastInboundMessage || opts.inboundMessage,
    asPrincipal,
    examples: opts.examples || [],
  });
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_FOLLOW_UP_MODEL || 'gemini-2.5-flash',
    systemInstruction: system,
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.7,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const res = await model.generateContent(user);
  const raw = (res.response && typeof res.response.text === 'function')
    ? res.response.text()
    : '';
  if (!String(raw || '').trim()) throw new Error('Gemini returned an empty follow-up draft');
  const { parseFollowUpModelJson } = require('./claude-reply-draft');
  const parsed = parseFollowUpModelJson(raw);
  if (!parsed.draft) throw new Error('Gemini follow-up JSON had an empty draft');
  if (asPrincipal) {
    parsed.needsClient = false;
    parsed.whatToSend = null;
  }
  return {
    text: parsed.draft,
    needsClient: parsed.needsClient === true,
    whatToSend: parsed.needsClient ? parsed.whatToSend : null,
    model: 'gemini-2.5-flash',
    usage: null,
  };
}

function resultShape(text, extra = {}) {
  return {
    text: String(text || '').trim(),
    needsClient: extra.needsClient === true,
    whatToSend: extra.needsClient ? (extra.whatToSend || 'info') : null,
    source: extra.source || 'template',
    model: extra.model || null,
    usage: extra.usage || null,
  };
}

/**
 * Draft the next cadence bump via Claude (+ RAG) with Gemini fallback.
 * Templates are last-resort only when both LLMs fail. Never throws.
 * Returns { text, needsClient, whatToSend, source }.
 */
async function draftReattemptToBook({
  leadName,
  platform,
  voicePrompt,
  bookingLink,
  lastInboundMessage,
  lastOutboundMessage,
  digestTimezone,
  step,
  slots,
  clientName,
  clientId = null,
  loopContact = null,
  threadContext = null,
  threadMessages = null,
  learnedVoiceBlock = '',
  daysSinceLastMessage = null,
  claudeGenerate = null,
  geminiGenerate = null,
} = {}) {
  const { generateFollowUpClaudeDraft, anthropicKeyConfigured } = require('./claude-reply-draft');
  const { factSourceText, enforceDraftGrounding } = require('../utils/draft-fact-check');

  const pack = async (llmResult, source) => {
    const {
      clientLoopContact,
      clientLoopContactPhrase,
      draftLoopsInContact,
    } = require('../utils/client-loop-contact');
    const contact = clientLoopContact({ voicePrompt, clientName, loopContact });
    const loopContactPhrase = clientLoopContactPhrase({
      voicePrompt, clientName, loopContact,
    });
    let text = sanitizeFollowUpText(llmResult.text, {
      bookingLink, voicePrompt, leadName, clientName, loopContactPhrase,
    });
    if (!text) throw new Error(`${source} draft empty after sanitization`);
    const sourceText = factSourceText({
      inboundMessage: lastInboundMessage,
      threadContext,
      threadSummary: require('./claude-reply-draft').formatFollowUpThread(threadMessages, threadContext),
      leadName,
      clientName,
      schedulingPromptBlock: [
        bookingLink,
        (slots || []).map((s) => (s && s.label) || s).join(' '),
        contact.firstName,
        loopContactPhrase,
      ].filter(Boolean).join('\n'),
      voicePrompt,
      learnedVoiceBlock,
    });
    const factCheck = await enforceDraftGrounding({
      draft: text,
      sourceText,
    });
    text = sanitizeFollowUpText(factCheck.text, {
      bookingLink, voicePrompt, leadName, clientName, loopContactPhrase,
    }) || text;
    let needsClient = llmResult.needsClient === true;
    let whatToSend = needsClient ? (llmResult.whatToSend || 'info') : null;
    if (require('../utils/principal-voice').speaksAsPrincipal(voicePrompt)) {
      needsClient = false;
      whatToSend = null;
    }
    // Send + CC / LOOP IN CLIENT only when the draft actually loops them in
    // with the exact configured first name.
    if (needsClient && !draftLoopsInContact(text, contact.firstName)) {
      needsClient = false;
      whatToSend = null;
    }
    return resultShape(text, {
      needsClient,
      whatToSend,
      source,
      model: llmResult.model,
      usage: llmResult.usage,
    });
  };

  const claudeFn = claudeGenerate || generateFollowUpClaudeDraft;
  const geminiFn = geminiGenerate || generateFollowUpGeminiDraft;
  const cap = followUpClaudeCap();
  const claudeArgs = {
    inboundMessage: lastInboundMessage,
    lastInboundMessage,
    lastOutboundMessage,
    threadContext,
    threadMessages,
    leadName,
    bookingLink,
    slots,
    platform,
    voicePrompt,
    clientName,
    loopContact,
    step,
    daysSinceLastMessage,
    learnedVoiceBlock,
  };

  let claudeErr = null;
  const canClaude = anthropicKeyConfigured() && claudeCallsThisRun < cap;
  if (anthropicKeyConfigured() && claudeCallsThisRun >= cap) {
    console.warn('[FollowUp] Claude cap reached for this run — Gemini fallback', {
      cap, used: claudeCallsThisRun,
    });
  }
  if (canClaude) {
    try {
      claudeCallsThisRun += 1;
      const llm = await claudeFn(claudeArgs);
      const usd = estimateClaudeUsd(llm.usage);
      claudeCostUsdThisRun += usd;
      console.log('[FollowUp] Claude draft generated', {
        model: llm.model,
        step,
        needsClient: llm.needsClient === true,
        inputTokens: llm.usage?.input_tokens || null,
        outputTokens: llm.usage?.output_tokens || null,
        estimatedUsd: Math.round(usd * 10000) / 10000,
        runUsd: Math.round(claudeCostUsdThisRun * 10000) / 10000,
        runCalls: claudeCallsThisRun,
        cap,
      });
      return await pack(llm, 'claude');
    } catch (err) {
      claudeErr = err;
      console.error('[FollowUp] Claude follow-up draft failed — falling through to Gemini', {
        err: err.message, step,
      });
    }
  }

  let geminiErr = null;
  try {
    const llm = await geminiFn(claudeArgs);
    console.log('[FollowUp] Gemini follow-up draft generated', { step, needsClient: llm.needsClient === true });
    return await pack(llm, 'gemini');
  } catch (err) {
    geminiErr = err;
    console.error('[FollowUp] BOTH LLMs failed — using last-resort template', {
      claude: claudeErr ? claudeErr.message : (canClaude ? null : (anthropicKeyConfigured() ? 'cap' : 'not_configured')),
      gemini: err.message,
      step,
    });
  }

  const template = lastResortTemplate({
    leadName,
    platform,
    bookingLink,
    digestTimezone,
    voicePrompt,
    lastOutboundMessage,
    step,
    slots,
    clientName,
  });
  void geminiErr;
  return resultShape(template, { source: 'template' });
}

module.exports = {
  draftReattemptToBook,
  fallbackReattempt,
  detectOffer,
  bumpForOffer,
  timesTakenBump,
  valuePropPhrase,
  scrubDashes,
  resetFollowUpClaudeBudget,
  followUpClaudeCap,
  followUpClaudeBudgetSnapshot,
  generateFollowUpGeminiDraft,
  estimateClaudeUsd,
};
