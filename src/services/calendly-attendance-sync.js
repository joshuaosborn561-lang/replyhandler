/**
 * Read-only daily Calendly sync for the MeetStream attendance tracker (Josh's own bookings only).
 *
 * Lists Josh's scheduled Calendly events in a forward window and registers the Google Meet ones with the
 * attendance tracker (source calendly_josh, scope josh). Zoom and other locations are skipped. Events
 * Calendly reports as canceled are marked cancelled. Only GET requests are made to Calendly: this never
 * creates, edits or deletes anything there.
 *
 * Needs CALENDLY_API_TOKEN (a Calendly personal access token). Does nothing when it is unset.
 */
const attendance = require('./meetstream-attendance');

const API = 'https://api.calendly.com';
const SOURCE = 'calendly_josh';
const DAY = 24 * 60 * 60 * 1000;

function tokenOf(env = process.env) {
  return String(env.CALENDLY_API_TOKEN || '').trim();
}

function enabled(env = process.env) {
  return attendance.enabled(env) && !!tokenOf(env);
}

function uuidOf(uri) {
  const m = String(uri || '').match(/([^/]+)\/?$/);
  return m ? m[1] : null;
}

/** Google Meet link of a Calendly scheduled event, or null (Zoom, phone, in person, none). */
function meetUrlOf(event) {
  const loc = event && event.location;
  if (!loc || typeof loc !== 'object') return null;
  const url = String(loc.join_url || '').trim();
  if (/^https:\/\/meet\.google\.com\//i.test(url)) return url;
  return null;
}

async function getJson(path, params, token, fetchImpl) {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
  const res = await fetchImpl(`${API}${path}${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`calendly_${res.status}`);
  return res.json();
}

async function listEvents({ token, userUri, status, minStart, maxStart, fetchImpl, maxPages = 5 }) {
  const out = [];
  let next = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params = next || {
      user: userUri, status, min_start_time: minStart, max_start_time: maxStart, count: '100', sort: 'start_time:asc',
    };
    const body = await getJson('/scheduled_events', params, token, fetchImpl);
    out.push(...(body.collection || []));
    const token2 = body.pagination && body.pagination.next_page_token;
    if (!token2) break;
    next = { user: userUri, status, min_start_time: minStart, max_start_time: maxStart, count: '100', sort: 'start_time:asc', page_token: token2 };
  }
  return out;
}

async function runSync({ env = process.env, fetchImpl = globalThis.fetch, register = attendance.registerBooking, now = new Date(), days = 14 } = {}) {
  const result = { registered: 0, skipped_non_meet: 0, cancelled: 0, errors: 0 };
  const token = tokenOf(env);
  if (!token || !attendance.enabled(env)) return { ...result, disabled: true };

  const me = await getJson('/users/me', null, token, fetchImpl);
  const userUri = me.resource && me.resource.uri;
  if (!userUri) throw new Error('calendly_no_user');
  const minStart = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const maxStart = new Date(now.getTime() + days * DAY).toISOString();

  const active = await listEvents({ token, userUri, status: 'active', minStart, maxStart, fetchImpl });
  for (const ev of active) {
    const url = meetUrlOf(ev);
    if (!url) { result.skipped_non_meet += 1; continue; }
    try {
      const r = await register({
        source: SOURCE, booking_ref: uuidOf(ev.uri), scope: 'josh', meeting_url: url,
        starts_at: ev.start_time, ends_at: ev.end_time,
      }, env);
      if (r && r.ok) result.registered += 1; else result.errors += 1;
    } catch (_) { result.errors += 1; }
  }

  const canceled = await listEvents({ token, userUri, status: 'canceled', minStart, maxStart, fetchImpl });
  for (const ev of canceled) {
    try {
      const r = await register({ source: SOURCE, booking_ref: uuidOf(ev.uri), scope: 'josh', cancelled: true }, env);
      if (r && r.cancelled) result.cancelled += 1;
    } catch (_) { result.errors += 1; }
  }
  return result;
}

module.exports = { SOURCE, enabled, tokenOf, uuidOf, meetUrlOf, runSync };
