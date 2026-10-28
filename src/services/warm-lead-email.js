'use strict';

/**
 * Callback email to the client: a prospect on a cold call asked for a callback (Allo tag `to_call_back`). Nothing
 * else triggers it (not `interested`). With an agreed time it is shown in the prospect's zone with CT in brackets;
 * with none the email says the caller will reach out. Same layout as the booked-meeting email, but it never says a
 * meeting is booked.
 *
 * allo-calling `log-booking` posts the already-resolved fields (Allo's own summary, prospect contact) to
 * POST /webhook/booking-bridge/warm-lead-email. Recipients are never taken from the request:
 *   To  = the client's always-CC list; when there is none, Vector falls back to its owner contact
 *         (WARM_LEAD_VECTOR_FALLBACK_TO, default Al Gancman); any other client with no list sends nothing
 *   CC  = Cayden's ops address (FYI_CC_EMAILS) and Gabe (BOOKED_MEETING_EMAIL_CC_EXTRA)
 *   Josh's address is stripped from To and CC whatever the lists hold, and there is no BCC.
 *
 * OFF unless WARM_LEAD_EMAIL_ENABLED=true. `dry_run: true` in the body returns the rendered email and
 * recipients without sending (allowed while the flag is off).
 *
 * The summary is Allo's own summary minus its "Outcome" line (Allo says "Meeting booked" for callbacks) and
 * minus sentences where the caller asserts facts about the client's offer. Those claims are the caller's, not verified.
 */

const gmail = require('./gmail-send');
const { buildWarmLeadNotifyEmail } = require('./client-notify-email');
const { buildRecipients, ccExtra, recipient, resolveClientAlwaysCc, brandsFor, useClientName } = require('./booked-meeting-email');
const { fyiReplyTo, fyiCcEmails, mergeEmailLists } = require('../utils/fyi-notify');
const { parseEmailList } = require('./client-cc');
const { lookupMissingLinkedin } = require('./reply-card-identity');

const EVENT = 'warm_lead_email';
const KINDS = ['callback'];
const DEFAULT_VECTOR_FALLBACK = 'agancman@vectorenergygroup.com';
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
const seen = new Map();
const NO_SUMMARY = 'Allo has not produced a summary for this call yet.';

function str(v, max = 500) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function enabled(env = process.env) {
  return String(env.WARM_LEAD_EMAIL_ENABLED || '').trim().toLowerCase() === 'true';
}

/** A title worth showing: more than 3 characters and at least one letter. Anything else is ''. */
function usableTitle(v) {
  const s = str(v, 200);
  return s.length > 3 && /\p{L}/u.test(s) ? s : '';
}

function cleanLinkedinUrl(v) {
  const m = String(v || '').match(/https?:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^/?#\s]+/i);
  return m ? m[0] : '';
}

function whenLabel(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(d)} CT`;
}

function dayLabel(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'short', day: 'numeric' }).format(d);
}

/** Sentences of a block of text. */
function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
}

// "You confirmed rebates are available", "you told him it saves 40%": the caller asserting something about the offer.
const CALLER_CLAIM = /\b(?:you|gabe|gabriel)\s+(?:also\s+)?(?:confirmed|confirm|said|told|explained|mentioned|noted|promised|assured|guaranteed|stated|claimed|shared that|explained that|let (?:him|her|them) know|informed)\b/i;
// Allo writes in second person to the caller ("you agreed to call him at 11:00").
const AGREED = /\b(?:agreed|scheduled|set up|set|plan(?:ned)?|arranged|will|are going to|to)\b[^.]*\b(?:call|speak|talk|reconnect|follow up|touch base|meet|connect)\b/i;
const TIME_WORDS = /\b(?:\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}|noon|midnight|tomorrow|today|tonight|this (?:morning|afternoon|evening)|next (?:week|monday|tuesday|wednesday|thursday|friday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\bat \d{1,2}\b)/i;

/**
 * Allo's summary without the "Last dialed" and "Outcome" sections. Allo sends either real markdown lines or one
 * line with inline "# Title ## Last dialed ... ## Outcome ... ## Summary ..." markers; both are handled.
 */
function splitAlloSummary(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return { title: '', body: '' };
  const parts = text.split(/(?:^|\s)(#{1,6})\s+/);
  // parts: [pre, marks, seg, marks, seg, ...]
  const segs = [];
  if (parts[0].trim()) segs.push({ level: 0, text: parts[0].trim() });
  for (let i = 1; i < parts.length; i += 2) segs.push({ level: parts[i].length, text: (parts[i + 1] || '').trim() });
  let title = '';
  const keep = [];
  for (const sg of segs) {
    if (sg.level === 1 && !title) { title = sg.text.replace(/\s+/g, ' '); continue; }
    if (/^(last dialed|outcome)\b/i.test(sg.text)) continue;
    const body = sg.text.replace(/^(summary|key points|details|next steps)\b[:\s]*/i, '').trim();
    if (body) keep.push(body.replace(/\s*\n\s*/g, ' '));
  }
  return { title, body: keep.join('\n') };
}

function swapYou(sentence, callerFirst) {
  const c = callerFirst || 'the caller';
  return sentence
    .replace(/\bYou're\b/g, `${c} is`).replace(/\byou're\b/g, `${c} is`)
    .replace(/\bYou've\b/g, `${c} has`).replace(/\byou've\b/g, `${c} has`)
    .replace(/\bYou\b/g, c).replace(/\byou\b/g, c)
    .replace(/\bYour\b/g, `${c}'s`).replace(/\byour\b/g, `${c}'s`);
}

/** The agreed callback/follow-up time: the sentence that says it, in the caller's name, or ''. */
function agreedTimeFrom(body, callerFirst, { today = '', callAtMs, zone } = {}) {
  for (const s of sentences(body)) {
    if (AGREED.test(s) && TIME_WORDS.test(s) && !CALLER_CLAIM.test(s)) {
      // only the agreement itself: stop at ", and he gave ..." / "; ..."
      const clause = s.trim().split(/\s*(?:,\s*(?:and|but|while)\b|;)\s*/i)[0];
      const t = anchorToday(localizeTime(swapYou(clause, callerFirst), { callAtMs, zone }), today).replace(/[.!?]+$/, '');
      return t.charAt(0).toUpperCase() + t.slice(1);
    }
  }
  return '';
}

/**
 * The summary body that is safe to show a client: a clause where the caller asserts something about the offer
 * ("... and you confirmed rebates are available") is cut; the prospect's own words before it stay.
 */
function stripCallerClaim(sentence) {
  const m = sentence.match(CALLER_CLAIM);
  if (!m) return sentence;
  const before = sentence.slice(0, m.index).replace(/[\s,;:\-]*(?:and|but|while|so|then)?[\s,;:\-]*$/i, '').trim();
  if (before.length < 25 || CALLER_CLAIM.test(before)) return '';
  return /[.!?]$/.test(before) ? before : `${before}.`;
}

function clientSafeSummary(body, callerFirst, { today = '', callAtMs, zone } = {}) {
  const kept = sentences(body).map((s) => stripCallerClaim(s.trim())).filter(Boolean).map((s) => swapYou(s, callerFirst))
    .map((s) => (AGREED.test(s) && TIME_WORDS.test(s) ? localizeTime(s, { callAtMs, zone }) : s));
  return anchorToday(kept.join(' ').trim(), today);
}

/** "today" in a summary means the call day; the client reads it later. */
function anchorToday(text, callDay) {
  return callDay ? String(text || '').replace(/\btoday\b/gi, `on ${callDay}`) : String(text || '');
}

const ZONE_LABEL = {
  'America/Los_Angeles': 'PT', 'America/Denver': 'MT', 'America/Phoenix': 'MT', 'America/Chicago': 'CT',
  'America/New_York': 'ET', 'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT',
};
const CT_ZONE = 'America/Chicago';
const NAMED_ZONES = [
  [/^(?:pt|pst|pdt|pacific)$/i, 'America/Los_Angeles'], [/^(?:mt|mst|mdt|mountain)$/i, 'America/Denver'],
  [/^(?:ct|cst|cdt|central)$/i, CT_ZONE], [/^(?:et|est|edt|eastern)$/i, 'America/New_York'],
];

function validZone(z) {
  if (!z) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return ''; }
}

function zoneLabel(z) {
  return ZONE_LABEL[z] || (z ? z.split('/').pop().replace(/_/g, ' ') : 'CT');
}

function zoneParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(ms));
  const o = {};
  for (const p of f) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

/** The instant at which the wall clock in `tz` reads y-m-d h:mi. */
function zonedToInstant({ y, m, d, h, mi }, tz) {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, tz);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += want - got;
  }
  return guess;
}

function clock(ms, tz) {
  const p = zoneParts(ms, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

const TIME_TOKEN = /(?:\b(?:at|around|by|for|@)\s+)?\b(\d{1,2})(?::(\d{2}))?(?:\s*(a\.?m\.?|p\.?m\.?)(?![a-z]))?(?:\s*(PT|PST|PDT|Pacific|MT|MST|MDT|Mountain|CT|CST|CDT|Central|ET|EST|EDT|Eastern)\b)?/gi;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function findTime(text) {
  TIME_TOKEN.lastIndex = 0;
  let m;
  while ((m = TIME_TOKEN.exec(text))) {
    const hasPrefix = /^(?:at|around|by|for|@)\s/i.test(m[0]);
    if (!(m[2] || m[3] || hasPrefix)) continue;
    const h = Number(m[1]);
    if (h < 1 || h > 12 || (m[2] && Number(m[2]) > 59)) continue;
    return m;
  }
  if (/\bnoon\b/i.test(text)) {
    const i = text.search(/\bnoon\b/i);
    return Object.assign(['noon', '12', '00', 'pm', undefined], { index: i, noon: true });
  }
  return null;
}

/**
 * Rewrites the time in a sentence like "call him at 11:00 today" into the prospect's zone with Central in brackets,
 * "at 11:00 AM PT (1:00 PM CT) today". The time is read in the prospect's zone (the callback is arranged on their
 * clock); a zone named in the sentence wins; with no known zone it is read as Central. Returns the sentence unchanged when
 * there is no clock time in it.
 */
function localizeTime(sentence, { callAtMs, zone } = {}) {
  const m = findTime(sentence);
  if (!m || !Number.isFinite(callAtMs)) return sentence;
  const named = m[4] && NAMED_ZONES.find(([re]) => re.test(m[4]));
  const tz = named ? named[1] : (zone || CT_ZONE);
  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3] ? m[3].toLowerCase()[0] : '';
  const call = zoneParts(callAtMs, tz);
  const low = sentence.toLowerCase();
  let dayShift = 0;
  if (/\btomorrow\b/.test(low)) dayShift = 1;
  else {
    const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(low));
    if (wd >= 0) {
      const today = new Date(Date.UTC(call.year, call.month - 1, call.day)).getUTCDay();
      dayShift = (wd - today + 7) % 7;
    }
  }
  const base = new Date(Date.UTC(call.year, call.month - 1, call.day + dayShift));
  const day = { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
  const at = (h24) => zonedToInstant({ ...day, h: h24, mi: minute }, tz);
  let when;
  if (meridiem) {
    when = at((hour % 12) + (meridiem === 'p' ? 12 : 0));
  } else {
    const cands = hour === 12 ? [12] : [hour, hour + 12];
    const ok = cands.map(at).filter((t) => t > callAtMs && zoneParts(t, tz).hour >= 7 && zoneParts(t, tz).hour <= 19);
    when = ok.length ? Math.min(...ok) : at(hour <= 6 ? hour + 12 : hour % 12);
  }
  const local = `${clock(when, tz)} ${zoneLabel(tz)}`;
  const text = tz === CT_ZONE ? local : `${local} (${clock(when, CT_ZONE)} CT)`;
  const lead = (m[0].match(/^(?:at|around|by|for|@)\s+/i) || [''])[0];
  return sentence.slice(0, m.index) + lead + text + sentence.slice(m.index + m[0].length);
}

function editDistance(a, b) {
  const x = String(a).toLowerCase(); const y = String(b).toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** An address in Allo's summary that is a mis-hearing of the verified email shown in the card becomes that email. */
function fixHeardEmails(text, shown, verified) {
  if (!shown || !verified) return text;
  return String(text || '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (e) => (
    e.toLowerCase() !== shown.toLowerCase() && editDistance(e, shown) <= 3 ? shown : e));
}

function parseWarmLeadPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (String(b.event || '') !== EVENT) return { ok: false, error: 'unsupported_event' };
  const kind = str(b.kind, 20).toLowerCase();
  if (!KINDS.includes(kind)) return { ok: false, error: 'unsupported_kind' };
  const p = b.prospect && typeof b.prospect === 'object' ? b.prospect : {};
  const parsed = {
    kind,
    alloCallId: str(b.allo_call_id, 100),
    caller: str(b.caller, 200),
    client: str(b.client, 200),
    clientSlug: str(b.client_slug, 100).toLowerCase(),
    clientDisplay: str(b.client_display, 200) || str(b.client, 200),
    callerBrand: str(b.caller_brand, 200),
    callAt: str(b.call_at, 60),
    summary: String(b.summary || '').replace(/\r\n/g, '\n').trim().slice(0, 6000),
    prospect: {
      name: str(p.name, 200), company: str(p.company, 200), email: str(p.email, 320),
      phone: str(p.phone, 60), title: usableTitle(p.title), linkedinUrl: cleanLinkedinUrl(p.linkedin_url),
      // false only when the email is the one heard on the call and nothing verified it
      emailVerified: p.email_verified !== false,
    },
    prospectZone: validZone(str(b.prospect_zone, 60)),
  };
  if (!parsed.alloCallId) return { ok: false, error: 'missing_allo_call_id' };
  return { ok: true, value: parsed };
}

function callerFirstName(caller) {
  const f = str(caller, 200).split(/\s+/)[0];
  return f || '';
}

/** Everything the email shows, from the payload. The agreed time is optional. */
function prepareWarmLead(m) {
  const first = callerFirstName(m.caller);
  const { title, body } = splitAlloSummary(m.summary);
  const clientName = m.clientDisplay || m.client;
  const swap = (t) => useClientName(t, { clientName, brands: brandsFor(m), keep: [m.prospect && m.prospect.company] });
  const callDay = dayLabel(m.callAt);
  const callAtMs = Date.parse(m.callAt);
  const zone = m.prospectZone || '';
  const agreed = swap(agreedTimeFrom(body, first, { today: callDay, callAtMs, zone }));
  const safe = swap(fixHeardEmails(clientSafeSummary(body, first, { today: callDay, callAtMs, zone }), m.prospect.email, m.prospect.emailVerified));
  return {
    clientName,
    title: swap(title),
    summary: safe,
    agreedTime: agreed,
    callerFirst: first,
    callAtLabel: whenLabel(m.callAt),
    callDay,
    zone,
  };
}

function vectorFallback(env = process.env) {
  const v = String(env.WARM_LEAD_VECTOR_FALLBACK_TO ?? DEFAULT_VECTOR_FALLBACK).trim();
  return v ? parseEmailList(v) : [];
}

/** Every address that is Josh's: the booked-email owner, the default owner and the Reply-To. Never a recipient here. */
function joshAddresses(env = process.env) {
  return new Set([...parseEmailList(recipient(env)), 'joshua@salesglidergrowth.com', fyiReplyTo(env)].map((e) => String(e).toLowerCase()));
}

/**
 * To = client always-CC; else Vector -> its fallback contact; else nobody (the caller then skips the send).
 * CC = ops + Gabe. Josh is removed from both lists; there is no BCC.
 */
function warmLeadRecipients({ always, clientSlug, env = process.env }) {
  const josh = joshAddresses(env);
  const notJosh = (list) => (list || []).filter((e) => !josh.has(String(e).toLowerCase()));
  const clientList = notJosh(always);
  const fallback = clientSlug === 'vector' && !clientList.length ? notJosh(vectorFallback(env)) : [];
  const to = clientList.length ? clientList : fallback;
  const cc = notJosh(mergeEmailLists(fyiCcEmails(env), ccExtra(env))).filter((e) => !to.includes(e));
  return { to, cc };
}

function alreadySent(key, now = Date.now()) {
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  return seen.has(key);
}

/** LinkedIn URL (and a job title when the enrichment returns one) for a prospect. Never throws. */
async function defaultLinkedinLookup(m) {
  if (String(process.env.BOOKED_MEETING_LINKEDIN_LOOKUP || '').toLowerCase() === 'off') return {};
  const hit = await lookupMissingLinkedin({
    email: m.prospect.email || undefined,
    leadName: m.prospect.name || undefined,
    companyName: m.prospect.company || undefined,
    clientTag: m.clientDisplay || m.client || undefined,
  });
  return { linkedinUrl: hit && hit.linkedinUrl ? cleanLinkedinUrl(hit.linkedinUrl) : '', title: hit && hit.title ? usableTitle(hit.title) : '' };
}

async function safeLookup(fn, m) {
  try {
    const hit = await Promise.race([Promise.resolve(fn(m)), new Promise((resolve) => setTimeout(() => resolve({}), 20000).unref())]);
    if (typeof hit === 'string') return { linkedinUrl: cleanLinkedinUrl(hit), title: '' };
    return { linkedinUrl: cleanLinkedinUrl(hit && hit.linkedinUrl), title: usableTitle(hit && hit.title) };
  } catch (err) {
    console.warn('[WarmLeadEmail] LinkedIn lookup failed, omitting it', { err: err.message });
    return { linkedinUrl: '', title: '' };
  }
}

async function handleWarmLeadEmail(body, {
  send = (m) => gmail.sendMail(m),
  now = Date.now(),
  env = process.env,
  resolveCc = resolveClientAlwaysCc,
  linkedinFn = defaultLinkedinLookup,
} = {}) {
  const dryRun = !!(body && body.dry_run === true);
  if (!dryRun && !enabled(env)) return { status: 200, body: { ok: true, skipped: 'disabled' } };
  const parsed = parseWarmLeadPayload(body);
  if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
  const m = parsed.value;
  const key = `${m.alloCallId}`;
  if (!dryRun && alreadySent(key, now)) return { status: 200, body: { ok: true, deduped: true } };

  const prep = prepareWarmLead(m);
  if (prep.skip) return { status: 200, body: { ok: true, skipped: prep.skip } };

  let always = [];
  try {
    ({ always } = await resolveCc({ clientSlug: m.clientSlug, clientName: m.client }));
  } catch (err) {
    console.warn('[WarmLeadEmail] client always-CC lookup failed', { err: err.message });
    if (!dryRun) return { status: 502, body: { ok: false, error: 'recipient_lookup_failed' } };
  }
  const { to, cc } = warmLeadRecipients({ always, clientSlug: m.clientSlug, env });
  if (!to.length) return { status: 200, body: { ok: true, skipped: 'no_client_recipient' } };
  if (!dryRun && !m.prospect.linkedinUrl) {
    const hit = await safeLookup(linkedinFn, m);
    if (hit.linkedinUrl) m.prospect.linkedinUrl = hit.linkedinUrl;
    if (!m.prospect.title && hit.title) m.prospect.title = hit.title;
  }
  const { subject, textBody, htmlBody } = buildWarmLeadNotifyEmail({
    kind: m.kind, prospect: m.prospect, clientName: prep.clientName, callAtLabel: prep.callAtLabel,
    title: prep.title, summary: prep.summary, agreedTime: prep.agreedTime, callerFirst: prep.callerFirst, noSummaryText: NO_SUMMARY,
  });
  if (dryRun) return { status: 200, body: { ok: true, dry_run: true, to, cc, subject, textBody, htmlBody } };
  try {
    await send({ to, cc, replyTo: fyiReplyTo(env), subject, htmlBody, textBody });
  } catch (err) {
    console.error('[WarmLeadEmail] send failed', { err: err.message });
    return { status: 502, body: { ok: false, error: 'send_failed' } };
  }
  seen.set(key, now);
  return { status: 200, body: { ok: true, sent: true, to, cc } };
}

function _resetSeenForTests() { seen.clear(); }

module.exports = {
  EVENT, KINDS, DEFAULT_VECTOR_FALLBACK, enabled, splitAlloSummary, agreedTimeFrom, clientSafeSummary, swapYou,
  parseWarmLeadPayload, prepareWarmLead, usableTitle, localizeTime, fixHeardEmails, warmLeadRecipients, handleWarmLeadEmail, _resetSeenForTests,
};
