'use strict';

/**
 * Writes the body of the client day-of brief the way Josh's own "Brief: ..." emails are written.
 *
 * Josh's briefs are not a code template. EA (the bot) runs the routine "Meeting brief 30m before":
 * an LLM reads the calendar, Gmail, Fireflies, Allo and the web, then writes short bullets under
 * Who / Why you're meeting / Rapport hooks / Easy openers / Allo / Fireflies / Logistics and posts
 * the HTML to the `send-brief` edge function (Client portal project, which only mails it to Josh).
 * This module reuses that routine's instructions for the CLIENT's copy. Same sections, same order,
 * same terse bullet voice, same kinds of content in each section (real background, real hooks,
 * real openers, real call history), with the internal-only material removed.
 *
 * Guardrails (code, not just prompt):
 *  - The model only sees what the lookups found. It is told never to invent.
 *  - Allo and Fireflies bullets are the plain lookup result when there is nothing to summarise.
 *  - Any URL, email address or phone number in the output that is not in the input is dropped.
 *  - Internal lines (LTV, pricing, unsubscribe, other clients, campaign names, tools) are dropped.
 *  - Any failure returns null and the caller keeps the plain mechanical sections.
 */

const SECTION_KEYS = ['who', 'why', 'rapport', 'openers', 'allo', 'fireflies', 'logistics'];
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';

/** Words and shapes a client never sees. Mirrors the filter in client-dayof-brief.js. */
const INTERNAL_LINE = /\bLTV\b|\bunsubscrib|\bsmartlead\b|\bheyreach\b|\bproof to lean on\b|\bcalendly wipe\b|\$\s?\d[\d,.]*\s*K\b|\bour (price|pricing|rate card)\b|\binternal pricing\b|\bsalesglider (intro|staffing|subs)\b|\bcampaigns?\b|\$\s?\d[\d,.]*\s*(?:\/|per\s+)(?:month|mo|meeting|account|inbox)/i;

const SYSTEM = `You write the pre-meeting brief that a CLIENT reads right before a sales meeting SalesGlider booked for them. You are copying the style of Josh Osborn's own meeting briefs. Output ONLY JSON:

{"who": string[], "why": string[], "rapport": string[], "openers": string[], "allo": string[], "fireflies": string[], "logistics": string[]}

These seven keys are the seven sections, in this order: Who, Why you're meeting, Rapport hooks, Easy openers, Allo, Fireflies / Cube, Logistics.

Goal is rapport plus readiness. Scannable bullets. The reader is the client taking the call ("you"). SalesGlider's outreach is "our" outreach. Write the way a sharp assistant briefs a busy owner: short factual fragments, one fact per bullet, specific names, dates and numbers. No filler, no marketing words, no hedging paragraphs.

WHO (3 to 5 bullets):
- Name, title, company (founder, years in business, partner names if the sources say so).
- Where they are based and what the company does in plain words (services, who they serve, size or footprint if a source gives it).
- One contact line: email | phone (| LinkedIn URL when known). Use pipes. Only values that appear in the input.
- Whether they are the decision maker and why, in one short bullet, using DECISION MAKER and ICP FIT from the input. Say it plainly (for example "Owner, so the decision maker. Commercial roofer, a fit for you.").

WHY YOU'RE MEETING (3 to 5 bullets): how this meeting came to exist, from the thread, with dates and times in the form "Oct 27, 7:21am PT". Say what they replied or asked in their own words (short quote when it carries meaning), who sent what, and how they picked the time. Do not name the campaign. Do not describe our internal process.

RAPPORT HOOKS (3 to 6 bullets): human things that let the client connect: background and path, tenure, school, military, hobbies, family, community, local team, awards, recent company news, how long the company has been around, a notable job or customer type. Many people share a name, so use a web result about the person ONLY when its company, title or place matches the prospect in the input; otherwise ignore it. Take them ONLY from WEB RESULTS, WEBSITE TEXT, the person's own email signature or messages, and LinkedIn snippets in the input. If the sources hold nothing personal, write one honest bullet naming what you did find about the business, for example "No personal details found. Their site leads with ...", never made-up warmth.

EASY OPENERS (2 or 3 bullets): questions or lines the client can say first, in quotes, built from the rapport hooks and what they said in the thread, ending in a question that gets them talking about how they win new business today. Natural, not creepy. Never quote their one-word reply back as an opener.

ALLO (1 to 3 bullets): the person's past calls, texts and voicemails with us, from CALLS in the input: date and time, direction, who spoke, what was said. If CALLS says none were found, write exactly "Allo had no history: no calls, texts or voicemails with <phone>". If calls were not checked, write "Allo was not checked."

FIREFLIES / CUBE (1 to 3 bullets): earlier recorded meetings that mention them, from FIREFLIES in the input: title and date, plus what mattered. If none were found write "No prior Fireflies transcripts mention <company>. First call". If not checked write "Fireflies was not checked."

LOGISTICS (2 to 4 bullets): the meeting day and time with the time zone, the join link exactly as given (or "No join link on the booking"), who accepted the invite if the input says so, no-show history, and any flag that needs a quick check (address in signature differs from website, title differs, link problems).

Hard rules:
- Use ONLY facts in the input. Never invent a name, title, number, date, link, quote, hobby or claim. If a fact is not in the input, leave it out.
- Never include: our pricing, fees or contract terms, lifetime value or revenue bars, proof or results from other clients, unsubscribe or stop status, campaign or list names, sender mailboxes, tool or vendor names (Smartlead, HeyReach, Serper, OpenRouter), or API keys.
- No em dashes or en dashes. Use commas, periods or three dots.
- No emoji. No markdown. Plain text bullets only (no leading dashes or numbers).
- Each bullet is one line, under 280 characters.
- Keep the whole brief short: it should read in under a minute.`;

function str(v, max = 600) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseJsonLoose(raw) {
  const t = String(raw || '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out`)), ms); if (t.unref) t.unref(); }),
  ]).finally(() => clearTimeout(t));
}

function writerConfigured(env = process.env) {
  return Boolean(String(env.ANTHROPIC_API_KEY || '').trim() || String(env.OPENROUTER_API_KEY || '').trim());
}

/** Anthropic first (the repo's Sonnet setting), OpenRouter as the second route. */
async function defaultLlm({ system, user }, { env = process.env, fetchImpl = fetch } = {}) {
  const anthropicKey = String(env.ANTHROPIC_API_KEY || '').trim();
  if (anthropicKey) {
    const { anthropicModel } = require('./anthropic-model');
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: anthropicModel(env), max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(40000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Anthropic client brief failed (${res.status})`);
    const data = JSON.parse(text);
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  const orKey = String(env.OPENROUTER_API_KEY || '').trim();
  if (!orKey) return null;
  const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orKey}` },
    body: JSON.stringify({
      model: String(env.CLIENT_BRIEF_OPENROUTER_MODEL || '').trim() || DEFAULT_OPENROUTER_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter client brief failed (${res.status})`);
  const data = JSON.parse(text);
  return (((data.choices || [])[0] || {}).message || {}).content || '';
}

function lines(list, max = 8) {
  return (Array.isArray(list) ? list : []).map((x) => str(x, 700)).filter(Boolean).slice(0, max);
}

/** What the model is allowed to see. No campaign name, no sender mailbox, no keys. */
function writerInput(facts, research = {}) {
  const f = facts || {};
  const p = f.prospect || {};
  const c = f.company || {};
  const hist = f.history || {};
  const flags = f.flags || {};
  const calls = lines(hist.callLines);
  const callNotes = str(hist.callNotes, 1500);
  const callsState = calls.length ? 'found' : (/^No calls on file\.?$/i.test(callNotes) ? 'none' : (callNotes ? 'found' : 'not checked'));
  const ff = lines(hist.firefliesLines);
  const ffState = ff.length ? 'found' : (hist.firefliesChecked ? 'none' : 'not checked');
  const web = (Array.isArray(research.results) ? research.results : []).slice(0, 8)
    .map((r) => ({ title: str(r.title, 160), snippet: str(r.snippet, 320), link: str(r.link, 240) }));
  return {
    client: str(f.clientName, 160),
    meeting: { when: str(f.whenLabel, 120), where: str(f.where, 80), joinLink: str(f.joinUrl, 400) },
    prospect: {
      name: str(p.name, 200), title: str(p.title, 200), company: str(c.name || p.company, 200),
      email: str(p.email, 320), phone: str(p.phone, 60), linkedin: str(p.linkedinUrl, 300), location: str(p.location, 160),
    },
    companySite: { website: str(c.website, 300), summary: str(c.whatTheyDo, 600), size: str(c.size, 300) },
    howTheyBooked: str(f.how && f.how.channel, 60),
    icpFit: str(flags.icpFit, 400),
    decisionMaker: str(flags.decisionMaker, 400),
    emailThread: lines(hist.emailLines, 10),
    linkedinThread: lines(hist.dmLines, 6),
    theirAsks: lines(f.openItems, 4),
    calls: { state: callsState, lines: calls.length ? calls : (callsState === 'found' ? [callNotes] : []) },
    fireflies: { state: ffState, lines: ff },
    flags: { noShows: str(flags.noShowHistory, 300), other: lines(flags.risks, 4) },
    webResults: web,
    websiteText: str(research.siteText, 3500),
  };
}

function inputBlob(input) {
  return JSON.stringify(input).toLowerCase();
}

/** Digits of a phone-like token, for comparison with the input. */
function digits(s) { return String(s || '').replace(/\D+/g, ''); }

/** A bullet that names a link, address or number the input does not hold is not trusted. */
function grounded(line, blob, blobDigits) {
  const urls = line.match(/https?:\/\/[^\s<>")]+/gi) || [];
  for (const u of urls) {
    const clean = u.replace(/[.,;:]+$/, '').toLowerCase();
    if (!blob.includes(clean)) return false;
  }
  const emails = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  for (const e of emails) if (!blob.includes(e.toLowerCase())) return false;
  const phones = line.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g) || [];
  for (const ph of phones) {
    const d = digits(ph);
    if (d.length >= 10 && !blobDigits.includes(d.slice(-10))) return false;
  }
  return true;
}

function cleanBullet(raw) {
  return str(raw, 400)
    .replace(/^[-*\u2022]\s+/, '')
    .replace(/^\d{1,2}[.)]\s+/, '')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Validate the model's JSON. Returns only sections that survived, or null. */
function normalizeWritten(parsed, input) {
  if (!parsed || typeof parsed !== 'object') return null;
  const blob = inputBlob(input);
  const blobDigits = digits(blob);
  const out = {};
  for (const key of SECTION_KEYS) {
    const kept = (Array.isArray(parsed[key]) ? parsed[key] : [])
      .map(cleanBullet)
      .filter((l) => l && !INTERNAL_LINE.test(l) && grounded(l, blob, blobDigits))
      .slice(0, 6);
    if (kept.length) out[key] = kept;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Allo and Fireflies stay the plain lookup result when there is nothing to summarise, so the
 * model can never write a call that did not happen.
 */
function pinLookupSections(written, input) {
  const out = { ...(written || {}) };
  if (input.calls.state !== 'found') delete out.allo;
  if (input.fireflies.state !== 'found') delete out.fireflies;
  return out;
}

async function writeClientBriefSections(facts, research = {}, { llm, env = process.env, fetchImpl = fetch } = {}) {
  const run = llm || ((msg) => defaultLlm(msg, { env, fetchImpl }));
  const input = writerInput(facts, research);
  const user = `Write the brief from this input. JSON only.\n\n${JSON.stringify(input, null, 1)}`.slice(0, 26000);
  const raw = await withTimeout(run({ system: SYSTEM, user }), 65000, 'client brief writer');
  const written = normalizeWritten(parseJsonLoose(raw), input);
  const pinned = pinLookupSections(written, input);
  return Object.keys(pinned).length ? pinned : null;
}

module.exports = {
  SECTION_KEYS,
  SYSTEM,
  INTERNAL_LINE,
  DEFAULT_OPENROUTER_MODEL,
  writerConfigured,
  writerInput,
  normalizeWritten,
  pinLookupSections,
  writeClientBriefSections,
  defaultLlm,
};
