/**
 * Email the booked client (and Josh) the moment a meeting is booked: a call booked by a caller (Allo)
 * or a booking made on a scheduler page (Calendly, TidyCal, ...). It is a full brief (booked-brief.js).
 *
 * booking-bridge `log-booking` posts the already-resolved fields here (Allo call summary and the
 * prospect's name, company, email, phone, title); this module resolves recipients and sends.
 * Recipients are never taken from the request:
 *   To  = the booked client's always-CC list (clients.cc_emails / cc_email)
 *   CC  = Cayden (BOOKED_MEETING_EMAIL_CC, default cayden@salesglidergrowth.com) and Josh
 *   no always-CC configured (or the client cannot be resolved) = To Josh (he is the client), same CC.
 *   Josh (BOOKED_MEETING_EMAIL_TO) is ALWAYS on To or CC (Josh, Oct 29).
 *   Nobody else is copied: the caller is not on the CC, whoever it is (Josh, Oct 29: "CC Cayden, and me
 *   instead of Gabe, and the client's always-CC addressed"). Any Allo caller works; the brief names the
 *   caller from the booking payload (caller).
 * The client is always called by its display name; the caller line's brand (e.g. the name on the
 * outbound number) is replaced with it in the summary and highlights.
 * Layout is the approved brief (booked-brief.js); the data comes from booked-brief-data.js.
 * Reply-To is the same FYI reply-to.
 */

const gmail = require('./gmail-send');
const db = require('../db');
const { buildBookedMeetingNotifyEmail } = require('./client-notify-email');
const { buildBookedBrief } = require('./booked-brief');
const { gatherBrief } = require('./booked-brief-data');
const { alwaysCcEmails, parseEmailList } = require('./client-cc');
const { CLIENT_SLUG_ALIASES } = require('./booking-bridge');
const { fyiReplyTo } = require('../utils/fyi-notify');
const { generateHighlights } = require('./booked-meeting-highlights');
const { lookupMissingLinkedin } = require('./reply-card-identity');
const { resolveSchedulerContact } = require('./scheduler-contact');

const DEFAULT_TO = 'joshua@salesglidergrowth.com';
const DEFAULT_CC = 'cayden@salesglidergrowth.com';
// Caller-line brands per client slug, used when the booking payload does not carry one.
const KNOWN_CALLER_BRANDS = { emcor: ['Mesa Energy'], deeproots: ['Deep Roots Capital'] };
const EVENT = 'booked_meeting_email';
const SEEN_TTL_MS = 60 * 60 * 1000;
const seen = new Map();

function str(v, max = 500) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/[\r\n]+/g, ' ').trim();
  return s.slice(0, max);
}

function recipient(env = process.env) {
  const v = String(env.BOOKED_MEETING_EMAIL_TO || '').trim();
  return v || DEFAULT_TO;
}

/** CC list for booked-meeting emails. Cayden by default; BOOKED_MEETING_EMAIL_CC replaces it. Josh is added by buildRecipients. */
function bookedCcEmails(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, 'BOOKED_MEETING_EMAIL_CC')) {
    return parseEmailList(env.BOOKED_MEETING_EMAIL_CC);
  }
  return parseEmailList(DEFAULT_CC);
}

/** The caller's name for the brief, from the booking payload. Empty when the payload has none. */
function callerLabel(m) {
  const n = String((m && m.caller) || '').replace(/\s+/g, ' ').trim();
  return n && !/^(unknown|unknown caller|n\/a|none|null)$/i.test(n) ? n : '';
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace each caller-line brand with the client's display name. */
function useClientName(text, { clientName, brands = [], keep = [] } = {}) {
  let out = String(text || '');
  if (!clientName) return out;
  const protectedNames = keep.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
  for (const brand of brands) {
    const b = String(brand || '').trim();
    if (!b || b.toLowerCase() === String(clientName).toLowerCase()) continue;
    if (protectedNames.includes(b.toLowerCase())) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(b)}(?![A-Za-z0-9])`, 'gi'), clientName);
  }
  return out;
}

function brandsFor(m) {
  return [...new Set([m.callerBrand, ...(KNOWN_CALLER_BRANDS[m.clientSlug] || [])].filter(Boolean))];
}

/**
 * The client's display name for the email. The booking row carries the bare slug ("vector") when the lead
 * could not be matched to a campaign, so a slug-shaped name is replaced by the matched client's real name,
 * then by the booking bridge's first alias for the slug.
 */
function displayNameFor(m, clientRows = []) {
  const current = String(m.clientDisplay || m.client || '').trim();
  const slugShaped = !current || current === String(m.clientSlug || '');
  if (!slugShaped) return current;
  const row = (clientRows || []).find((r) => r && r.name);
  if (row) return String(row.name).trim();
  const alias = (CLIENT_SLUG_ALIASES[m.clientSlug] || [])[0];
  return alias || current;
}

function parseBookedMeetingPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (String(b.event || '') !== EVENT) return { ok: false, error: 'unsupported_event' };
  const p = b.prospect && typeof b.prospect === 'object' ? b.prospect : {};
  const parsed = {
    bookingId: str(b.booking_id, 100),
    alloCallId: str(b.allo_call_id, 100),
    caller: str(b.caller, 200),
    client: str(b.client, 200),
    clientSlug: str(b.client_slug, 100).toLowerCase(),
    clientDisplay: str(b.client_display, 200) || str(b.client, 200),
    callerBrand: str(b.caller_brand, 200),
    list: str(b.list, 200),
    callAt: str(b.call_at, 60),
    platform: str(b.platform, 40).toLowerCase(),
    meetingAt: isoOrEmpty(b.meeting_at),
    bookedAt: isoOrEmpty(b.booked_at),
    // Scheduler bookings (Calendly, TidyCal, ...): the id / invitee URI the scheduler's own API answers to.
    schedulerBookingId: str(b.scheduler_booking_id, 100),
    schedulerInviteeUri: str(b.scheduler_invitee_uri, 500),
    smartleadCampaignId: str(b.smartlead_campaign_id, 40),
    smartleadLeadId: str(b.smartlead_lead_id, 40),
    summary: String(b.summary || '').replace(/\r\n/g, '\n').trim().slice(0, 6000),
    summarySource: str(b.summary_source, 40),
    transcript: String(b.transcript || '').replace(/\r\n/g, '\n').trim().slice(0, 12000),
    prospect: {
      name: str(p.name, 200),
      company: str(p.company, 200),
      email: str(p.email, 320),
      phone: str(p.phone, 60),
      title: str(p.title, 200),
      linkedinUrl: cleanLinkedinUrl(p.linkedin_url),
    },
  };
  if (!parsed.bookingId && !parsed.alloCallId) return { ok: false, error: 'missing_booking_id' };
  return { ok: true, value: parsed };
}

function isoOrEmpty(v) {
  const d = v ? new Date(String(v)) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
}

function cleanLinkedinUrl(v) {
  const m = String(v || '').match(/https?:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^/?#\s]+/i);
  return m ? m[0] : '';
}

function whenLabel(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)} CT`;
}

const NO_SUMMARY = 'Allo has not produced a summary for this call yet.';

function buildBookedMeetingEmail(m, highlights = null) {
  const clientName = m.clientDisplay || m.client;
  const swap = (t) => useClientName(t, { clientName, brands: brandsFor(m), keep: [m.prospect && m.prospect.company] });
  const h = highlights && {
    painPoints: (highlights.painPoints || []).map(swap),
    currentSetup: highlights.currentSetup ? swap(highlights.currentSetup) : null,
    objections: (highlights.objections || []).map(swap),
    nextStep: highlights.nextStep ? swap(highlights.nextStep) : null,
  };
  return buildBookedMeetingNotifyEmail({
    prospect: m.prospect,
    clientName,
    callAtLabel: whenLabel(m.callAt),
    summary: swap(m.summary),
    highlights: h,
    noSummaryText: NO_SUMMARY,
  });
}

/**
 * The booked client's always-CC addresses. Matches the booking's client to active ReplyHandler
 * clients the same way the booking bridge does (slug aliases, then exact client name); when more
 * than one active client matches, their lists are merged. Throws on a DB error.
 */
async function resolveClientAlwaysCc({ clientSlug, clientName }, { query = db.query.bind(db) } = {}) {
  const names = [
    ...(CLIENT_SLUG_ALIASES[clientSlug] || []),
    ...(clientName ? [clientName] : []),
  ].map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  if (!names.length) return { clients: [], always: [], rows: [] };
  const { rows } = await query(
    `SELECT id, name, cc_emails, cc_email, smartlead_api_key FROM clients
      WHERE active IS DISTINCT FROM false
        AND lower(name) = ANY($1::text[])`,
    [names]
  );
  const always = [];
  for (const row of rows) {
    for (const email of alwaysCcEmails(row)) if (!always.includes(email)) always.push(email);
  }
  return { clients: rows.map((r) => r.name), always, rows };
}

/**
 * To = client always-CC (else Josh, who is the client then). CC = Cayden, plus Josh
 * whenever he is not already on To. Nobody is listed twice, and Josh is always on To or CC.
 */
function buildRecipients({ always, josh, cc = [] }) {
  const owner = parseEmailList(josh);
  const ccList = parseEmailList(Array.isArray(cc) ? cc.join(',') : cc);
  const clientList = (always || []).filter((e) => !ccList.includes(e));
  const to = clientList.length ? clientList : owner;
  const out = ccList.filter((e) => !to.includes(e));
  for (const o of owner) if (!to.includes(o) && !out.includes(o)) out.push(o);
  return { to, cc: out };
}

function alreadySent(key, now = Date.now()) {
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  return seen.has(key);
}

/** Cheap capped lookup (the reply cards' $0.05 LinkedIn lookup). Never throws; a miss returns ''. */
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
    const hit = await Promise.race([
      Promise.resolve(fn(m)),
      new Promise((resolve) => setTimeout(() => resolve(''), 20000).unref()),
    ]);
    return cleanLinkedinUrl(hit);
  } catch (err) {
    console.warn('[BookedMeetingEmail] LinkedIn lookup failed, omitting it', { err: err.message });
    return '';
  }
}

async function handleBookedMeetingEmail(body, {
  send = (m) => gmail.sendMail(m),
  now = Date.now(),
  env = process.env,
  resolveCc = resolveClientAlwaysCc,
  highlightsFn = generateHighlights,
  linkedinFn = defaultLinkedinLookup,
  briefDataFn = gatherBrief,
  contactFn = resolveSchedulerContact,
} = {}) {
  const parsed = parseBookedMeetingPayload(body);
  if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
  const m = parsed.value;
  const key = `${m.bookingId}|${m.alloCallId}`;
  if (alreadySent(key, now)) return { status: 200, body: { ok: true, deduped: true } };

  let always = [];
  let clientRows = [];
  try {
    const resolved = await resolveCc({ clientSlug: m.clientSlug, clientName: m.client });
    always = resolved.always || [];
    clientRows = resolved.rows || [];
  } catch (err) {
    // Never lose Josh's copy because the client lookup failed.
    console.warn('[BookedMeetingEmail] client always-CC lookup failed, sending to Josh only', { err: err.message });
  }
  const { to, cc } = buildRecipients({
    always,
    josh: recipient(env),
    cc: bookedCcEmails(env),
  });
  if (!always.length) {
    console.warn('[BookedMeetingEmail] client has no always-CC address, so this brief goes to Josh and Cayden only', { client: m.clientSlug || m.client });
  }
  m.clientDisplay = displayNameFor(m, clientRows);
  const clientName = m.clientDisplay || m.client;
  // A booking made on a scheduler page reaches us before the scheduler's webhook, with no name. Ask the
  // scheduler's API who booked, so the brief, the LinkedIn match and the research all have a real person.
  const isCallBooking = Boolean(m.alloCallId) || m.platform === 'allo';
  if (!isCallBooking && !m.prospect.name && (m.schedulerBookingId || m.schedulerInviteeUri)) {
    const hit = await contactFn({
      platform: m.platform,
      bookingId: m.schedulerBookingId,
      inviteeUri: m.schedulerInviteeUri,
      email: m.prospect.email,
    }).catch(() => null);
    if (hit) {
      m.prospect.name = m.prospect.name || hit.name || '';
      m.prospect.company = m.prospect.company || hit.company || '';
      m.prospect.title = m.prospect.title || hit.title || '';
      m.prospect.phone = m.prospect.phone || hit.phone || '';
      m.prospect.email = m.prospect.email || hit.email || '';
      m.meetingAt = m.meetingAt || isoOrEmpty(hit.startsAt);
    }
  }
  const [highlights, linkedinUrl] = await Promise.all([
    highlightsFn({
      transcript: m.transcript,
      summary: m.summary,
      clientName,
      brands: brandsFor(m),
    }),
    // The lookup only trusts a profile that carries the lead's own name (PR #183), so with no name there is
    // nothing to check a hit against: skip it rather than pay for a result that would be thrown away.
    m.prospect.linkedinUrl ? m.prospect.linkedinUrl : (m.prospect.name ? safeLinkedin(linkedinFn, m) : ''),
  ]);
  if (linkedinUrl) m.prospect.linkedinUrl = linkedinUrl;
  const swap = (t) => useClientName(t, { clientName, brands: brandsFor(m), keep: [m.prospect && m.prospect.company] });
  const h = highlights && {
    painPoints: (highlights.painPoints || []).map(swap),
    currentSetup: highlights.currentSetup ? swap(highlights.currentSetup) : null,
    objections: (highlights.objections || []).map(swap),
    nextStep: highlights.nextStep ? swap(highlights.nextStep) : null,
  };
  // The brief's extra sections (thread, company, talking points) are best effort: a failure here
  // still sends the email with what the booking itself carries.
  let data = null;
  const briefOff = briefDataFn === gatherBrief && String(env.BOOKED_BRIEF_DATA || process.env.BOOKED_BRIEF_DATA || '').toLowerCase() === 'off';
  if (!briefOff) {
    try {
      data = await briefDataFn(m, { clients: clientRows, linkedinUrl: m.prospect.linkedinUrl, highlights: h, swap }, { callBrands: brandsFor(m), env });
    } catch (err) {
      console.warn('[BookedMeetingEmail] brief data failed, sending the short brief', { err: String(err && err.message || err).slice(0, 200) });
    }
  }
  const isCall = Boolean(m.alloCallId) || m.platform === 'allo';
  const { subject, textBody, htmlBody } = buildBookedBrief({
    ...(data || {
      clientName,
      prospect: { ...m.prospect, linkedinUrl: m.prospect.linkedinUrl },
      when: { label: '', fallback: isCall ? 'Agreed on the call. See Next step in the call notes.' : 'See the calendar invite.' },
      company: {},
      how: { client: clientName, channel: isCall ? 'Cold call' : '' },
    }),
    summary: swap(m.summary),
    highlights: h,
    isCall,
    callNotesLabel: isCall ? [callerLabel(m) ? `Booked on a cold call by ${callerLabel(m)}` : 'Booked on a cold call', whenLabel(m.callAt)].filter(Boolean).join(' \u00b7 ') : '',
    noSummaryText: NO_SUMMARY,
  });
  // Ops checks (bearer-protected route): dry_run returns the brief unsent; josh_only sends one copy to
  // Josh and nobody else, so a test never reaches a client. Neither marks the booking as emailed.
  if (body && body.dry_run === true) {
    return { status: 200, body: { ok: true, dry_run: true, to, cc, subject, textBody } };
  }
  if (body && body.josh_only === true) {
    try {
      await send({ to: [DEFAULT_TO], cc: [], replyTo: fyiReplyTo(env), subject: `[TEST] ${subject}`, htmlBody, textBody });
    } catch (err) {
      return { status: 502, body: { ok: false, error: 'send_failed' } };
    }
    return { status: 200, body: { ok: true, josh_only: true, to: [DEFAULT_TO] } };
  }
  try {
    await send({ to, cc, replyTo: fyiReplyTo(env), subject, htmlBody, textBody });
  } catch (err) {
    console.error('[BookedMeetingEmail] send failed', { err: err.message });
    return { status: 502, body: { ok: false, error: 'send_failed' } };
  }
  seen.set(key, now);
  return { status: 200, body: { ok: true, sent: true, to, cc, client_recipients: always.length } };
}

function _resetSeenForTests() {
  seen.clear();
}

module.exports = {
  EVENT,
  DEFAULT_TO,
  NO_SUMMARY,
  recipient,
  parseBookedMeetingPayload,
  displayNameFor,
  buildBookedMeetingEmail,
  buildBookedBrief,
  resolveClientAlwaysCc,
  buildRecipients,
  bookedCcEmails,
  callerLabel,
  useClientName,
  brandsFor,
  KNOWN_CALLER_BRANDS,
  handleBookedMeetingEmail,
  _resetSeenForTests,
};
