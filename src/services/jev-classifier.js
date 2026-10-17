/**
 * Jev (TypeSafe via OpenRouter Decisions) reply classifier.
 *
 * Endpoint and key come from env — never hardcoded. Same wire format as
 * booking-bridge call-tagger: POST { model, state, questions } → answers.
 */

const JEV_MODEL_DEFAULT = 'typesafe/jev-1.13';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 800;

const JEV_CATEGORIES = [
  'INTERESTED',
  'QUESTION',
  'OBJECTION',
  'NOT_INTERESTED',
  'OOO',
  'REMOVE_ME',
  'WRONG_PERSON',
  'COMPETITOR',
  'MEETING_PROPOSED',
  'OTHER',
];

const CATEGORY_CRITERIA = {
  INTERESTED:
    'They want to hear more about OUR offer, say yes, ask us to send something, or engage with a gift we offered (tickets, a game, seats, AirPods, a video, a loom). Short yeses like "sure", "tell me more", "send it" count. Ticket/event replies such as "happy to explore the tickets" are INTERESTED, not OTHER.',
  QUESTION:
    'They ask a clarifying question about OUR offer, niche, timing, pricing, or the gift we mentioned. "What game?", "what sport?", "where are the tickets?" after we offered tickets is QUESTION, not OTHER. Not for vendor/recruiter/capital questions aimed at selling to us — those are OTHER.',
  MEETING_PROPOSED:
    'They offer, confirm, or ask us to send a calendar invite for a specific time on a thread where we already wrote. "Tuesday 10am works, send an invite" counts. A stranger asking for a "quick 10-15 min chat" to pitch us is OTHER, not MEETING_PROPOSED.',
  OBJECTION:
    'They push back but stay in the conversation (already have a vendor, bad timing, price, "we use our own laptops") without a hard no or opt-out.',
  NOT_INTERESTED:
    'A clear decline of our offer: not interested, no thanks, going to pass, not a fit, all set. Not a question and not a gift-hook yes.',
  OOO:
    'Out-of-office, vacation, limited email access, automatic reply, will return on a date. Prefer OOO over OTHER.',
  REMOVE_ME:
    'Unsubscribe, take me off the list, stop emailing, remove me.',
  WRONG_PERSON:
    'Not the right person, left the company, mailbox no longer monitored, please contact someone else because they do not work here.',
  COMPETITOR:
    'They are a competing vendor selling the same thing we sell.',
  OTHER:
    'Vendor, recruiter, capital, or agency pitches to us — including engagement-bait questions about our process/stack, "resurfacing this thread", mutually-beneficial meeting asks, and counter-offers selling their own services. Also anything that fits none of the other labels. Do NOT use OTHER when they engage with tickets, a game, seats, or another gift we offered — that is INTERESTED or QUESTION. Do NOT use OTHER for a short yes to our ask.',
};

const CATEGORY_INSTRUCTIONS =
  `You classify the latest prospect message in a B2B outbound thread into exactly one category.\n` +
  `Read last_outbound_from_us. If it is "(none — they may have written first)", they are usually pitching us: prefer OTHER, not QUESTION or INTERESTED, even when the note is phrased as a question.\n` +
  `If we already wrote (often with a gift hook — event tickets, a ballgame, seats, AirPods, a short video), classify THEIR reply to our offer. Ticket/event engagement is INTERESTED or QUESTION, never OTHER.\n\n` +
  `Anonymized examples:\n` +
  `- After we offered team tickets: "Happy to explore the tickets." → INTERESTED\n` +
  `- After we offered tickets: "What sport? What game? Where are the tickets?" → QUESTION\n` +
  `- "Sure, tell me more." → INTERESTED (a short yes, even if last outbound is missing from the snippet)\n` +
  `- After our campaign: "You've got my attention, let's see what you've got?" → INTERESTED\n` +
  `- After our campaign: "Do you work in education afterschool enrichment services" → QUESTION\n` +
  `- After our campaign: "I'm curious what exactly you're providing/selling?" → QUESTION\n` +
  `- After we already replied: "Can you help me set-up a campaign to get in front of a prospect?" → QUESTION\n` +
  `- After our campaign: "Tuesday 10am ET works, feel free to send an invite." → MEETING_PROPOSED\n` +
  `- After our campaign: "Do you have 20-30 minutes later this week?" → MEETING_PROPOSED\n` +
  `- A restated or forwarded note where they named a clock time and asked for a meeting invite is MEETING_PROPOSED, even if a wrapper says the slot "did not hold".\n` +
  `- No outbound from us: "Does testing the offer before tweaking copy solve most outbound bottlenecks for your team?" → OTHER\n` +
  `- No outbound from us: "Is your team writing those briefs by hand?" → OTHER\n` +
  `- No outbound from us: "How do you scale personalized outbound without a huge manual effort?" → OTHER\n` +
  `- "Just wanted to resurface this thread... brief 15 minute chat next week?" → OTHER\n` +
  `- "We built a workspace for email, LinkedIn and calls. What tools do you use?" → OTHER\n` +
  `- "Curious if you need additional capital right now?" → OTHER\n` +
  `- "Thanks for reaching out, but I'm not interested." → NOT_INTERESTED\n` +
  `- "Remove me from your list." → REMOVE_ME\n` +
  `- "I will have limited communications until next week." → OOO\n` +
  `- "This person no longer works here. This mailbox is not monitored." → WRONG_PERSON\n`;

const PITCH_INSTRUCTIONS =
  `Probability that this inbound is THEM pitching US (vendor, recruiter, capital, agency, SaaS, "mutually beneficial" meeting) rather than responding to OUR outreach.\n` +
  `Read last_outbound_from_us. If it is none / they wrote first, treat compliment-plus-question openers as pitches. Engagement-bait about our stack, process, case study, or "how we work" is a pitch even when they never name a product.\n` +
  `"Just resurfacing this thread", recruiters, capital, "we built a product", board-seat matching, and "10 minute call will be mutually beneficial" are also pitches.\n` +
  `If we already wrote with a campaign offer or gift hook, they are usually answering us (false) even if the reply is a question about tickets or our offer.\n\n` +
  `Anonymized examples:\n` +
  `- No outbound from us: "Does testing the offer before tweaking copy solve most outbound bottlenecks?" → true (high)\n` +
  `- No outbound from us: "The brief you send clients after every reply is smart. Is your team writing those by hand?" → true (high)\n` +
  `- No outbound from us: "How do you scale personalized outbound without it turning into a huge manual effort?" → true (high)\n` +
  `- "Just wanted to resurface this thread... brief 15 minute chat next week?" → true (high)\n` +
  `- "Thanks for connecting. Curious if you need additional capital right now?" → true (high)\n` +
  `- "We built a workspace to put email, LinkedIn and calls in one place. What tools do you use?" → true (high)\n` +
  `- "Are you currently exploring website, AI automation, or SEO projects? Open to a 10-minute call?" → true (high)\n` +
  `- After we offered tickets: "Happy to explore the tickets." → false\n` +
  `- After we offered tickets: "What game?" → false\n` +
  `- After our campaign: "Sure, tell me more." → false\n` +
  `- "Thanks, not interested." → false\n`;

const QUESTIONS = {
  category: {
    type: 'choice',
    instructions: CATEGORY_INSTRUCTIONS,
    criteria: CATEGORY_CRITERIA,
  },
  pitch_to_us: {
    type: 'noul',
    instructions: PITCH_INSTRUCTIONS,
    criteria: {
      true: 'They are selling to us: vendor/recruiter/capital/agency pitch, engagement-bait, or "resurfacing this thread" meeting ask. We did not campaign them, or the message is a cold inbound offer.',
      false: 'They are answering our outreach (including ticket/event/gift questions), declining, OOO, wrong person, or otherwise not pitching us.',
    },
  },
};

function envFlag(name, defaultValue = true) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function isGeminiFallbackEnabled() {
  return envFlag('CLASSIFIER_FALLBACK_GEMINI', true);
}

function jevModel() {
  const m = String(process.env.JEV_MODEL || '').trim();
  return m || JEV_MODEL_DEFAULT;
}

function numberEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function missingJevEnv() {
  const missing = [];
  if (!String(process.env.JEV_API_URL || '').trim()) missing.push('JEV_API_URL');
  if (!String(process.env.JEV_API_KEY || '').trim()) missing.push('JEV_API_KEY');
  return missing;
}

function isJevConfigured() {
  return missingJevEnv().length === 0;
}

/** Fail-fast: never silently fall through to a hardcoded URL or key. */
function assertJevConfigured() {
  const missing = missingJevEnv();
  if (missing.length) {
    throw new Error(`missing required env ${missing.join(', ')}`);
  }
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

function lastOutboundFromThread(threadContext) {
  const list = Array.isArray(threadContext)
    ? threadContext
    : (Array.isArray(threadContext?.messages) ? threadContext.messages : []);
  let last = '';
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || m.sender || m.from || '').toLowerCase();
    const outbound = role === 'us' || role === 'me' || role === 'sender' || role === 'user'
      || m.is_reply === false || m.isReply === false;
    if (!outbound) continue;
    const txt = m.message || m.body || m.text || m.content || '';
    if (txt && String(txt).trim()) last = String(txt).trim();
  }
  return last;
}

function buildState(threadContext, inboundMessage) {
  const lastOut = lastOutboundFromThread(threadContext);
  return {
    last_outbound_from_us: lastOut || '(none — they may have written first)',
    latest_prospect_reply: String(inboundMessage || ''),
    thread: summarizeThread(threadContext),
  };
}

function buildJevRequest({ threadContext, inboundMessage }) {
  return {
    model: jevModel(),
    state: buildState(threadContext, inboundMessage),
    questions: QUESTIONS,
  };
}

function parseNoul(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && value !== null && 'noul' in value) {
    const n = Number(value.noul);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJevResponse(payload) {
  const answers = payload && typeof payload === 'object' ? payload.answers : null;
  if (!answers || typeof answers !== 'object') {
    throw new Error('jev response missing answers');
  }
  const cat = answers.category || answers.outcome || {};
  const choice = cat.choice != null ? String(cat.choice).trim() : '';
  if (!choice) throw new Error('jev response missing category.choice');
  return {
    classification: choice,
    pitchToUsProb: parseNoul(answers.pitch_to_us),
    probabilities: cat.probabilities || null,
    usage: payload.usage || null,
    source: 'jev',
  };
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function isRetryableError(err) {
  const msg = String(err?.message || err);
  return /timeout|aborted|network|fetch|econnreset|enotfound|429|502|503|504|unavailable/i.test(msg);
}

async function fetchJevOnce(url, key, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (isRetryableStatus(res.status)) {
      const err = new Error(`jev ${res.status}`);
      err.retryable = true;
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      throw new Error(`jev ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    }
    return parseJevResponse(json);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Single Jev call: category enum + pitch_to_us_prob.
 * Throws after retries; caller falls back to Gemini when the flag is on.
 */
async function classifyWithJev(threadContext, inboundMessage) {
  assertJevConfigured();
  const url = String(process.env.JEV_API_URL).trim();
  const key = String(process.env.JEV_API_KEY).trim();
  const body = buildJevRequest({ threadContext, inboundMessage });
  const timeoutMs = numberEnv('JEV_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const attempts = numberEnv('JEV_RETRY_ATTEMPTS', DEFAULT_ATTEMPTS);
  const baseDelayMs = numberEnv('JEV_RETRY_BASE_MS', DEFAULT_BASE_DELAY_MS);

  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetchJevOnce(url, key, body, timeoutMs);
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable || isRetryableError(err);
      if (!retryable || i === attempts - 1) throw err;
      await sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastErr || new Error('jev retries exhausted');
}

module.exports = {
  JEV_CATEGORIES,
  JEV_MODEL_DEFAULT,
  QUESTIONS,
  buildJevRequest,
  parseJevResponse,
  classifyWithJev,
  isJevConfigured,
  assertJevConfigured,
  isGeminiFallbackEnabled,
  missingJevEnv,
  lastOutboundFromThread,
};
