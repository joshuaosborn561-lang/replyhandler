/**
 * Email the booked client (and Josh) when a meeting a caller booked on a call lands in the
 * #meetings-booked Slack channel.
 *
 * booking-bridge `log-booking` posts the already-resolved fields here (Allo call summary and the
 * prospect's name, company, email, phone, title); this module resolves recipients and sends.
 * Recipients are never taken from the request:
 *   To  = the booked client's always-CC list (clients.cc_emails / cc_email), the same list the
 *         positive-reply notify email goes to
 *   CC  = Josh (BOOKED_MEETING_EMAIL_TO, default joshua@salesglidergrowth.com) plus the ops
 *         address the positive-reply email CCs (FYI_CC_EMAILS, default Cayden)
 *   no always-CC configured (or the client cannot be resolved) = To Josh, CC ops.
 * Layout, subject style and notes line match the positive-reply notify email
 * (buildBookedMeetingNotifyEmail in client-notify-email.js). Reply-To is the same FYI reply-to.
 */

const gmail = require('./gmail-send');
const db = require('../db');
const { buildBookedMeetingNotifyEmail } = require('./client-notify-email');
const { alwaysCcEmails, parseEmailList } = require('./client-cc');
const { CLIENT_SLUG_ALIASES } = require('./booking-bridge');
const { fyiReplyTo, fyiCcEmails, mergeEmailLists } = require('../utils/fyi-notify');
const { generateHighlights } = require('./booked-meeting-highlights');

const DEFAULT_TO = 'joshua@salesglidergrowth.com';
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
    list: str(b.list, 200),
    callAt: str(b.call_at, 60),
    summary: String(b.summary || '').replace(/\r\n/g, '\n').trim().slice(0, 6000),
    summarySource: str(b.summary_source, 40),
    transcript: String(b.transcript || '').replace(/\r\n/g, '\n').trim().slice(0, 12000),
    prospect: {
      name: str(p.name, 200),
      company: str(p.company, 200),
      email: str(p.email, 320),
      phone: str(p.phone, 60),
      title: str(p.title, 200),
    },
  };
  if (!parsed.bookingId && !parsed.alloCallId) return { ok: false, error: 'missing_booking_id' };
  return { ok: true, value: parsed };
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
  return buildBookedMeetingNotifyEmail({
    prospect: m.prospect,
    clientName: m.client,
    callAtLabel: whenLabel(m.callAt),
    summary: m.summary,
    highlights,
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
  if (!names.length) return { clients: [], always: [] };
  const { rows } = await query(
    `SELECT id, name, cc_emails, cc_email FROM clients
      WHERE active IS DISTINCT FROM false
        AND lower(name) = ANY($1::text[])`,
    [names]
  );
  const always = [];
  for (const row of rows) {
    for (const email of alwaysCcEmails(row)) if (!always.includes(email)) always.push(email);
  }
  return { clients: rows.map((r) => r.name), always };
}

/**
 * To = client always-CC (else Josh). CC = Josh when the client is on To, plus the ops FYI CC.
 * Josh and ops are never dropped or duplicated.
 */
function buildRecipients({ always, josh, ops = [] }) {
  const owner = parseEmailList(josh);
  const opsList = parseEmailList(Array.isArray(ops) ? ops.join(',') : ops);
  const clientList = (always || []).filter((e) => !owner.includes(e) && !opsList.includes(e));
  const to = clientList.length ? clientList : owner;
  const cc = mergeEmailLists(clientList.length ? owner : [], opsList).filter((e) => !to.includes(e));
  return { to, cc };
}

function alreadySent(key, now = Date.now()) {
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  return seen.has(key);
}

async function handleBookedMeetingEmail(body, {
  send = (m) => gmail.sendMail(m),
  now = Date.now(),
  env = process.env,
  resolveCc = resolveClientAlwaysCc,
  highlightsFn = generateHighlights,
} = {}) {
  const parsed = parseBookedMeetingPayload(body);
  if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
  const m = parsed.value;
  const key = `${m.bookingId}|${m.alloCallId}`;
  if (alreadySent(key, now)) return { status: 200, body: { ok: true, deduped: true } };

  let always = [];
  try {
    ({ always } = await resolveCc({ clientSlug: m.clientSlug, clientName: m.client }));
  } catch (err) {
    // Never lose Josh's copy because the client lookup failed.
    console.warn('[BookedMeetingEmail] client always-CC lookup failed, sending to Josh only', { err: err.message });
  }
  const { to, cc } = buildRecipients({ always, josh: recipient(env), ops: fyiCcEmails(env) });
  const highlights = await highlightsFn({ transcript: m.transcript, summary: m.summary });
  const { subject, textBody, htmlBody } = buildBookedMeetingEmail(m, highlights);
  try {
    await send({ to, cc, replyTo: fyiReplyTo(env), subject, htmlBody, textBody });
  } catch (err) {
    console.error('[BookedMeetingEmail] send failed', { err: err.message });
    return { status: 502, body: { ok: false, error: 'send_failed' } };
  }
  seen.set(key, now);
  return { status: 200, body: { ok: true, sent: true, to, cc } };
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
  buildBookedMeetingEmail,
  resolveClientAlwaysCc,
  buildRecipients,
  handleBookedMeetingEmail,
  _resetSeenForTests,
};
