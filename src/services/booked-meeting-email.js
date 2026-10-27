/**
 * Email Josh when a meeting a caller booked on a call lands in the #meetings-booked Slack channel.
 *
 * booking-bridge `log-booking` posts the already-resolved fields here (Allo call summary and the
 * prospect's name, company, email, phone, title); this module only formats and sends. The recipient
 * is fixed by config (BOOKED_MEETING_EMAIL_TO, default joshua@salesglidergrowth.com) and is never
 * taken from the request, so the endpoint cannot be used to mail anyone else.
 */

const gmail = require('./gmail-send');

const DEFAULT_TO = 'joshua@salesglidergrowth.com';
const EVENT = 'booked_meeting_email';
const SEEN_TTL_MS = 60 * 60 * 1000;
const seen = new Map();

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  const summary = String(b.summary || '').replace(/\r\n/g, '\n').trim().slice(0, 6000);
  const parsed = {
    bookingId: str(b.booking_id, 100),
    alloCallId: str(b.allo_call_id, 100),
    caller: str(b.caller, 200),
    client: str(b.client, 200),
    list: str(b.list, 200),
    callAt: str(b.call_at, 60),
    summary,
    summarySource: str(b.summary_source, 40),
    recordingUrl: /^https:\/\//i.test(String(b.recording_url || '')) ? str(b.recording_url, 1000) : '',
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

function buildBookedMeetingEmail(m) {
  const who = m.prospect.company || m.prospect.name || 'a prospect';
  const by = m.caller ? m.caller.split(/\s+/)[0] : '';
  const subject = `Meeting booked: ${who}${m.client ? ` (${m.client})` : ''}${by ? ` via ${by}` : ''}`;

  const rows = [
    ['Name', m.prospect.name],
    ['Company', m.prospect.company],
    ['Title', m.prospect.title],
    ['Email', m.prospect.email],
    ['Phone', m.prospect.phone],
  ];
  const meta = [
    ['Client', m.client],
    ['List', m.list],
    ['Booked by', m.caller],
    ['Call time', whenLabel(m.callAt)],
  ].filter(([, v]) => v);

  const summary = m.summary || NO_SUMMARY;
  const text = [
    `Meeting booked${by ? ` by ${by}` : ''}.`,
    '',
    'PROSPECT',
    ...rows.map(([k, v]) => `${k}: ${v || '-'}`),
    '',
    'CALL SUMMARY (Allo)',
    summary,
    '',
    ...meta.map(([k, v]) => `${k}: ${v}`),
    ...(m.recordingUrl ? [`Recording: ${m.recordingUrl}`] : []),
  ].join('\n');

  const cell = 'padding:4px 12px 4px 0;vertical-align:top;';
  const contactRows = rows.map(([k, v]) => {
    let val = escapeHtml(v || '-');
    if (k === 'Email' && v) val = `<a href="mailto:${escapeHtml(v)}">${escapeHtml(v)}</a>`;
    return `<tr><td style="${cell}color:#666;">${k}</td><td style="${cell}"><b>${val}</b></td></tr>`;
  }).join('');
  const metaLine = meta.map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join(' &middot; ');
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">',
    `<p><b>Meeting booked${by ? ` by ${escapeHtml(by)}` : ''}.</b></p>`,
    `<table style="border-collapse:collapse;">${contactRows}</table>`,
    '<p style="margin:16px 0 4px;color:#666;">Call summary (Allo)</p>',
    `<div style="white-space:pre-wrap;">${escapeHtml(summary)}</div>`,
    metaLine ? `<p style="margin-top:16px;color:#666;font-size:12px;">${metaLine}</p>` : '',
    m.recordingUrl
      ? `<p style="font-size:12px;"><a href="${escapeHtml(m.recordingUrl)}">Call recording</a></p>`
      : '',
    '</div>',
  ].join('');

  return { subject, text, html };
}

function alreadySent(key, now = Date.now()) {
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  return seen.has(key);
}

async function handleBookedMeetingEmail(body, { send = gmail.sendMail, now = Date.now(), env = process.env } = {}) {
  const parsed = parseBookedMeetingPayload(body);
  if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } };
  const m = parsed.value;
  const key = `${m.bookingId}|${m.alloCallId}`;
  if (alreadySent(key, now)) return { status: 200, body: { ok: true, deduped: true } };

  const { subject, text, html } = buildBookedMeetingEmail(m);
  const to = recipient(env);
  try {
    await send({ to, subject, htmlBody: html, textBody: text });
  } catch (err) {
    console.error('[BookedMeetingEmail] send failed', { err: err.message });
    return { status: 502, body: { ok: false, error: 'send_failed' } };
  }
  seen.set(key, now);
  return { status: 200, body: { ok: true, sent: true } };
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
  handleBookedMeetingEmail,
  _resetSeenForTests,
};
