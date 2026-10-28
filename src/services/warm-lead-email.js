'use strict';

/**
 * Warm-lead email to the client: a caller's cold call ended `interested`, or `to_call_back` with an agreed
 * time. Same layout and recipients as the booked-meeting email, but it never says a meeting is booked.
 *
 * allo-calling `log-booking` posts the already-resolved fields (Allo's own summary, prospect contact) to
 * POST /webhook/booking-bridge/warm-lead-email. Recipients are never taken from the request:
 *   To  = the client's always-CC list; when there is none, Vector falls back to its owner contact
 *         (WARM_LEAD_VECTOR_FALLBACK_TO, default Al Gancman), any other client falls to Josh like the booked email
 *   CC  = Cayden's ops address (FYI_CC_EMAILS) and Gabe (BOOKED_MEETING_EMAIL_CC_EXTRA); Josh is never CC'd
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
const KINDS = ['interested', 'callback'];
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
function agreedTimeFrom(body, callerFirst, { today = '' } = {}) {
  for (const s of sentences(body)) {
    if (AGREED.test(s) && TIME_WORDS.test(s) && !CALLER_CLAIM.test(s)) {
      // only the agreement itself: stop at ", and he gave ..." / "; ..."
      const clause = s.trim().split(/\s*(?:,\s*(?:and|but|while)\b|;)\s*/i)[0];
      const t = anchorToday(swapYou(clause, callerFirst), today).replace(/[.!?]+$/, '');
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

function clientSafeSummary(body, callerFirst, { today = '' } = {}) {
  const kept = sentences(body).map((s) => stripCallerClaim(s.trim())).filter(Boolean).map((s) => swapYou(s, callerFirst));
  return anchorToday(kept.join(' ').trim(), today);
}

/** "today" in a summary means the call day; the client reads it later. */
function anchorToday(text, callDay) {
  return callDay ? String(text || '').replace(/\btoday\b/gi, `on ${callDay}`) : String(text || '');
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
      phone: str(p.phone, 60), title: str(p.title, 200), linkedinUrl: cleanLinkedinUrl(p.linkedin_url),
    },
  };
  if (!parsed.alloCallId) return { ok: false, error: 'missing_allo_call_id' };
  return { ok: true, value: parsed };
}

function callerFirstName(caller) {
  const f = str(caller, 200).split(/\s+/)[0];
  return f || '';
}

/** Everything the email shows, from the payload. A callback with no agreed time returns { skip }. */
function prepareWarmLead(m) {
  const first = callerFirstName(m.caller);
  const { title, body } = splitAlloSummary(m.summary);
  const clientName = m.clientDisplay || m.client;
  const swap = (t) => useClientName(t, { clientName, brands: brandsFor(m), keep: [m.prospect && m.prospect.company] });
  const callDay = dayLabel(m.callAt);
  const agreed = swap(agreedTimeFrom(body, first, { today: callDay }));
  if (m.kind === 'callback' && !agreed) return { skip: 'no_agreed_time' };
  const safe = swap(clientSafeSummary(body, first, { today: callDay }));
  return {
    clientName,
    title: swap(title),
    summary: safe,
    agreedTime: agreed,
    callAtLabel: whenLabel(m.callAt),
    callDay,
  };
}

function vectorFallback(env = process.env) {
  const v = String(env.WARM_LEAD_VECTOR_FALLBACK_TO ?? DEFAULT_VECTOR_FALLBACK).trim();
  return v ? parseEmailList(v) : [];
}

/** To = client always-CC; else Vector -> its fallback contact; else Josh. CC = ops + Gabe, never Josh. */
function warmLeadRecipients({ always, clientSlug, env = process.env }) {
  const cc = mergeEmailLists(fyiCcEmails(env), ccExtra(env));
  const fallback = clientSlug === 'vector' && !(always || []).length ? vectorFallback(env) : [];
  const { to, cc: ccOut } = buildRecipients({ always: (always || []).length ? always : fallback, josh: recipient(env), cc });
  return { to, cc: ccOut };
}

function alreadySent(key, now = Date.now()) {
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  return seen.has(key);
}

async function defaultLinkedinLookup(m) {
  if (String(process.env.BOOKED_MEETING_LINKEDIN_LOOKUP || '').toLowerCase() === 'off') return '';
  const hit = await lookupMissingLinkedin({
    email: m.prospect.email || undefined,
    leadName: m.prospect.name || undefined,
    companyName: m.prospect.company || undefined,
    clientTag: m.clientDisplay || m.client || undefined,
  });
  return hit && hit.linkedinUrl ? cleanLinkedinUrl(hit.linkedinUrl) : '';
}

async function safeLinkedin(fn, m) {
  try {
    const hit = await Promise.race([Promise.resolve(fn(m)), new Promise((resolve) => setTimeout(() => resolve(''), 20000).unref())]);
    return cleanLinkedinUrl(hit);
  } catch (err) {
    console.warn('[WarmLeadEmail] LinkedIn lookup failed, omitting it', { err: err.message });
    return '';
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
  const linkedinUrl = m.prospect.linkedinUrl || (dryRun ? '' : await safeLinkedin(linkedinFn, m));
  if (linkedinUrl) m.prospect.linkedinUrl = linkedinUrl;
  const { subject, textBody, htmlBody } = buildWarmLeadNotifyEmail({
    kind: m.kind, prospect: m.prospect, clientName: prep.clientName, callAtLabel: prep.callAtLabel,
    title: prep.title, summary: prep.summary, agreedTime: prep.agreedTime, noSummaryText: NO_SUMMARY,
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
  parseWarmLeadPayload, prepareWarmLead, warmLeadRecipients, handleWarmLeadEmail, _resetSeenForTests,
};
