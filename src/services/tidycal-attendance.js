'use strict';

/**
 * TidyCal -> MeetStream attendance, for client bookings. Read-only: only GET requests are made to TidyCal and to
 * the client's calendar. Nothing is sent to anyone and nothing is posted.
 *
 * Every TidyCal team is a client (team name -> client slug, same aliases as the booking bridge), so a new client
 * is picked up the moment its TidyCal team has a booking: no per-client code. MEETSTREAM_CLIENTS_OFF switches one off.
 *
 * Two entry points, both idempotent on (source 'tidycal', booking id):
 *   registerById  a booking the bridge just reported (webhook /webhook/booking-bridge carries the booking id)
 *   runSync       every few minutes: each team's upcoming bookings, plus cancellations. This also heals a booking
 *                 whose link was missing when it was made, and follows reschedules.
 *
 * Join link: the booking's own `meeting_url` (TidyCal fills it with a Google Meet link when the booking type's
 * location is Google Meet and the host's Google calendar is connected). When TidyCal has none, the booker's event on
 * the client's connected Google calendar is read (attendee email match) and its Meet link is used.
 * Only Google Meet links are used; Zoom / Teams are recorded as skipped by the tracker.
 *
 * Needs TIDYCAL_API_TOKEN. Does nothing without it or when MEETSTREAM_ATTENDANCE_ENABLED is off.
 */
const attendance = require('./meetstream-attendance');

const API = 'https://tidycal.com/api';
const SOURCE = 'tidycal';
const DAY = 24 * 60 * 60 * 1000;
const MEET_RE = /^https:\/\/meet\.google\.com\/[a-z0-9-]+/i;
const CALENDAR_LOOKAHEAD_MS = 36 * 60 * 60 * 1000;

function tokenOf(env = process.env) {
  return String(env.TIDYCAL_API_TOKEN || '').trim();
}

function enabled(env = process.env) {
  return attendance.enabled(env) && !!tokenOf(env);
}

async function getJson(path, params, env, fetchImpl) {
  const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
  const res = await fetchImpl(`${API}${path}${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenOf(env)}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`tidycal_${res.status}`);
  return res.json();
}

/** Google Meet join link of a TidyCal booking, or null (Zoom, Teams, phone, none yet). */
function meetUrlOf(booking) {
  const url = String((booking && booking.meeting_url) || '').trim();
  return MEET_RE.test(url) ? url : null;
}

function hostNames(booking) {
  return (Array.isArray(booking && booking.hosts) ? booking.hosts : [])
    .map((h) => String((h && h.name) || '').trim()).filter(Boolean).slice(0, 8);
}

/** Team name -> client slug, the same way the booking bridge names clients. */
function slugForTeamName(name, aliasSlug) {
  const fn = aliasSlug || require('./booking-bridge').slugFromClientName;
  return String(fn(name) || '').toLowerCase();
}

/**
 * The booker's Meet link from the client's connected Google calendar: the event with this attendee that starts
 * within 10 minutes of the booking. Returns null when the client has no Google calendar or no such event.
 */
async function calendarMeetUrl({ clientSlug, email, startsAt }, deps = {}) {
  const db = deps.db || require('../db');
  const google = deps.google || require('./google-calendar');
  const aliases = (deps.aliases || require('./booking-bridge').CLIENT_SLUG_ALIASES)[clientSlug] || [];
  const names = [...aliases, clientSlug].map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  if (!names.length || !email || !startsAt) return null;
  const { rows: clients } = await db.query(
    `SELECT id FROM clients WHERE active IS DISTINCT FROM false AND lower(name) = ANY($1::text[])`, [names]);
  if (!clients.length) return null;
  const { rows: conns } = await db.query(
    `SELECT * FROM calendar_connections WHERE client_id = ANY($1::uuid[]) AND provider = 'google' ORDER BY updated_at DESC`,
    [clients.map((c) => c.id)]);
  const want = new Date(startsAt).getTime();
  for (const conn of conns) {
    const events = await google.findUpcomingEvents(conn, email, { days: 30 }).catch(() => []);
    for (const ev of events) {
      const attends = (ev.attendees || []).some((a) => String(a.email || '').toLowerCase() === String(email).toLowerCase());
      const start = new Date((ev.start || {}).dateTime || 0).getTime();
      if (!attends || !start || Math.abs(start - want) > 10 * 60 * 1000) continue;
      const entry = ((ev.conferenceData || {}).entryPoints || []).find((p) => MEET_RE.test(String(p.uri || '')));
      const url = (MEET_RE.test(String(ev.hangoutLink || '')) && ev.hangoutLink) || (entry && entry.uri) || null;
      if (url) return url;
    }
  }
  return null;
}

/** Turn one TidyCal booking into a tracker registration (or a cancellation). */
async function toRegistration(booking, { clientSlug, env, now = Date.now(), calendarLookup = calendarMeetUrl }) {
  const ref = String(booking.id);
  if (booking.cancelled_at) {
    return { source: SOURCE, booking_ref: ref, scope: 'client', client_slug: clientSlug, cancelled: true };
  }
  let meetingUrl = meetUrlOf(booking);
  const startsMs = new Date(booking.starts_at).getTime();
  if (!meetingUrl && Number.isFinite(startsMs) && startsMs - now < CALENDAR_LOOKAHEAD_MS) {
    const email = booking.contact && booking.contact.email;
    try {
      meetingUrl = await calendarLookup({ clientSlug, email, startsAt: booking.starts_at });
    } catch (_) { meetingUrl = null; }
  }
  const cfg = attendance.config(env);
  const internal = [...new Set([...hostNames(booking), ...cfg.internalNames])].slice(0, 10);
  return {
    source: SOURCE,
    booking_ref: ref,
    scope: 'client',
    client_slug: clientSlug,
    meeting_url: meetingUrl,
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    internal_names: internal,
  };
}

/** Register one booking the bridge reported. Returns the tracker result, or null when TidyCal can't be read. */
async function registerById(id, { env = process.env, clientSlug = '', fetchImpl = globalThis.fetch, register = attendance.registerBooking, calendarLookup } = {}) {
  let raw;
  try {
    raw = await getJson(`/bookings/${encodeURIComponent(id)}`, null, env, fetchImpl);
  } catch (err) {
    console.warn('[TidyCalAttendance] booking fetch failed', { id, err: err.message });
    return null;
  }
  const booking = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
  if (!booking || !booking.id || !booking.starts_at) return null;
  const team = booking.booking_type && booking.booking_type.team;
  const slug = String(clientSlug || (team && slugForTeamName(team.name)) || '').toLowerCase();
  if (!slug) return null; // not a team booking we can tie to a client
  const input = await toRegistration(booking, { clientSlug: slug, env, calendarLookup });
  return register(input, env);
}

async function listPaged(path, params, env, fetchImpl, maxPages = 3) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const body = await getJson(path, { ...params, page: String(page) }, env, fetchImpl);
    out.push(...(body.data || []));
    if (!body.links || !body.links.next) break;
  }
  return out;
}

function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function runSync({ env = process.env, fetchImpl = globalThis.fetch, register = attendance.registerBooking, now = Date.now(), days = 14, calendarLookup } = {}) {
  const result = { teams: 0, registered: 0, scheduled: 0, cancelled: 0, no_link: 0, errors: 0 };
  if (!enabled(env)) return { ...result, disabled: true };
  const teams = (await getJson('/teams', null, env, fetchImpl)).data || [];
  const params = { start_date: ymd(now - DAY), end_date: ymd(now + days * DAY) };
  for (const team of teams) {
    result.teams += 1;
    const clientSlug = slugForTeamName(team.name);
    if (!clientSlug) continue;
    let live = [];
    let cancelled = [];
    try {
      live = await listPaged(`/teams/${team.id}/bookings`, params, env, fetchImpl);
      cancelled = await listPaged(`/teams/${team.id}/bookings`, { ...params, cancelled: 'true' }, env, fetchImpl, 1);
    } catch (err) {
      result.errors += 1;
      console.warn('[TidyCalAttendance] team list failed', { team: team.id, err: err.message });
      continue;
    }
    for (const b of live) {
      if (!b || b.cancelled_at || !b.starts_at) continue;
      if (new Date(b.starts_at).getTime() < now - 5 * 60 * 1000) continue; // already over (or the tracker's window has passed)
      try {
        const input = await toRegistration(b, { clientSlug, env, now, calendarLookup });
        const r = await register(input, env);
        if (r && r.ok) {
          result.registered += 1;
          if (r.status === 'scheduled') result.scheduled += 1;
          if (r.reason === 'no_meeting_url') result.no_link += 1;
        } else result.errors += 1;
      } catch (_) { result.errors += 1; }
    }
    for (const b of cancelled) {
      if (!b || !b.id) continue;
      try {
        const r = await register({ source: SOURCE, booking_ref: String(b.id), scope: 'client', client_slug: clientSlug, cancelled: true }, env);
        if (r && r.cancelled) result.cancelled += 1;
      } catch (_) { result.errors += 1; }
    }
  }
  return result;
}

module.exports = { SOURCE, tokenOf, enabled, meetUrlOf, hostNames, slugForTeamName, calendarMeetUrl, toRegistration, registerById, runSync };
