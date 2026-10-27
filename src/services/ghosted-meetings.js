'use strict';

/**
 * Ghosted-meeting detector. OFF by default (GHOSTED_MEETING_ENABLED).
 *
 * Finds booked meetings the prospect never showed up to, and enrolls each in the
 * follow-up card sequence (followup_sequences.origin = 'ghosted_meeting'). The
 * sequence posts every step to the follow-ups channel as a card a human clicks:
 * this file never sends anything to a lead.
 *
 * Data sources (all existing):
 *   - booking_events (campaignintelligence Supabase, same project as booking-bridge):
 *     booked meetings, with the meeting time when the scheduler payload carries one
 *   - the client's connected calendar (Google / Microsoft): real start and end,
 *     cancelled / declined state, and a later booking if the prospect rescheduled
 *   - meetings / pending_replies: booked evidence and the reply the sequence hangs off
 *   - Fireflies (FIREFLIES_API_KEY): was the prospect on the call and did they speak
 *
 * Obvious no-show (meeting ended GHOSTED_MEETING_GRACE_MINUTES ago, default 5): Fireflies has no
 * recording of it, OR the recording is under GHOSTED_MEETING_MIN_MINUTES (5), OR only one person
 * joined / spoke. Anything else is attended. The result is one rebook email card for Gabe/Cayden.
 * Without a Fireflies key a meeting is HELD, never guessed: it stays visible in
 * ghosted_meeting_checks with reason fireflies_not_configured.
 *
 * Every stage is logged as one JSON line tagged [GhostedMeeting] and appended to the
 * check row's `trail`: candidate_found, fireflies_checked, held, ghosted, attended,
 * enrolled, posted, dropped (always with a reason).
 */
const db = require('../db');
const slack = require('./slack');
const fireflies = require('./fireflies');
const google = require('./google-calendar');
const microsoft = require('./microsoft-calendar');
const { leadKey } = require('./follow-up-call-reminder');
const { isDisqualified } = require('./disqualified-prospects');
const { isLeadClaimed } = require('./client-claimed');
const { slugFromClientName, normalizeEmail } = require('./booking-bridge');
const { followUpSlackChannelId } = require('./follow-up-runner');
const time = require('../utils/followup-sequence-time');
const ghostText = require('../utils/ghosted-meeting-text');

const ORIGIN = 'ghosted_meeting';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function enabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.GHOSTED_MEETING_ENABLED || '').trim());
}

/** Default is one rebook email card. GHOSTED_MEETING_FULL_SEQUENCE=true adds the call cards, day 2 and breakup. */
function fullSequence(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.GHOSTED_MEETING_FULL_SEQUENCE || '').trim());
}

function envNumber(env, name, fallback) {
  const n = parseFloat(env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function config(env = process.env) {
  const start = env.GHOSTED_MEETING_START ? new Date(env.GHOSTED_MEETING_START) : null;
  return {
    graceMs: envNumber(env, 'GHOSTED_MEETING_GRACE_MINUTES', 5) * MIN,
    minMeetingMs: envNumber(env, 'GHOSTED_MEETING_MIN_MINUTES', 5) * MIN,
    lookbackMs: (envNumber(env, 'GHOSTED_MEETING_LOOKBACK_HOURS', 48) || 48) * HOUR,
    defaultDurationMs: (envNumber(env, 'GHOSTED_MEETING_DEFAULT_MINUTES', 30) || 30) * MIN,
    floor: start && Number.isFinite(start.getTime()) ? start : null,
    maxPerRun: envNumber(env, 'GHOSTED_MEETING_MAX_PER_RUN', 25) || 25,
    bookingLookbackMs: 30 * 24 * HOUR,
    futureMs: 14 * 24 * HOUR,
  };
}

function parseJson(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

/** One JSON line per stage so a meeting can be traced with `grep GhostedMeeting`. */
function log(stage, fields = {}) {
  console.log('[GhostedMeeting]', JSON.stringify({ stage, ...fields }));
}

async function trail(dbClient, checkId, stage, detail = {}) {
  if (!checkId) return;
  try {
    await dbClient.query(
      `UPDATE ghosted_meeting_checks
          SET trail = trail || $2::jsonb, updated_at = now()
        WHERE id = $1`,
      [checkId, JSON.stringify([{ at: new Date().toISOString(), stage, ...detail }])],
    );
  } catch (err) {
    console.warn('[GhostedMeeting] could not write trail', { checkId, stage, err: err.message });
  }
}

async function decide(dbClient, check, decision, reason, evidence, extra = {}) {
  const ids = { check_id: check.id, client: check.client_name || check.client_id, lead_key: check.lead_key };
  await dbClient.query(
    `UPDATE ghosted_meeting_checks
        SET decision = $2, reason = $3,
            evidence = evidence || $4::jsonb,
            decided_at = CASE WHEN $2 IN ('ghosted', 'attended', 'enrolled', 'dropped') THEN now() ELSE decided_at END,
            sequence_id = COALESCE($5, sequence_id),
            updated_at = now()
      WHERE id = $1`,
    [check.id, decision, reason || null, JSON.stringify(evidence || {}), extra.sequenceId || null],
  );
  await trail(dbClient, check.id, decision, { reason: reason || null, ...(evidence || {}) });
  log(decision, { ...ids, reason: reason || null, ...(evidence || {}) });
}

// ─── Meeting time from a booking payload ──────────────────────────────────────

const TIME_KEYS = new Set([
  'start_time', 'starttime', 'event_start_time', 'eventstarttime', 'meeting_start_time',
  'meetingstarttime', 'scheduled_time', 'scheduledtime', 'startat', 'start_at',
]);
const END_KEYS = new Set(['end_time', 'endtime', 'event_end_time', 'meeting_end_time', 'end_at', 'endat']);

function asDate(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return asDate(value.dateTime || value.date_time || value.start_time || null);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (/^\d{10,13}$/.test(s)) return asDate(Number(s));
  // A wall-clock time without an offset cannot be placed in time; refuse to guess.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function walk(node, keys, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, keys, out, depth + 1)); return; }
  for (const [k, v] of Object.entries(node)) {
    if (keys.has(String(k).toLowerCase().replace(/[\s-]/g, '_'))) out.push(v);
    if (v && typeof v === 'object') walk(v, keys, out, depth + 1);
  }
}

/** { start, end|null } from a scheduler payload, or null when it carries no usable time. */
function meetingTimesFromPayload(payloadRaw) {
  const payload = parseJson(payloadRaw);
  if (!payload || typeof payload !== 'object') return null;
  const get = (o, ...path) => path.reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);
  const explicit = [
    get(payload, 'scheduled_event', 'start_time'),
    get(payload, 'payload', 'scheduled_event', 'start_time'),
    get(payload, 'payload', 'start_time'),
    get(payload, 'meetingsPayload', 'startTime'),
    get(payload, 'meetingsPayload', 'start_time'),
    get(payload, 'start_time'),
    get(payload, 'startTime'),
    get(payload, 'start'),
  ];
  const walked = [];
  walk(payload, TIME_KEYS, walked);
  let start = null;
  for (const raw of [...explicit, ...walked]) {
    start = asDate(raw);
    if (start) break;
  }
  if (!start) return null;
  const endCandidates = [
    get(payload, 'scheduled_event', 'end_time'),
    get(payload, 'payload', 'scheduled_event', 'end_time'),
    get(payload, 'meetingsPayload', 'endTime'),
    get(payload, 'end_time'),
    get(payload, 'end'),
  ];
  const walkedEnd = [];
  walk(payload, END_KEYS, walkedEnd);
  let end = null;
  for (const raw of [...endCandidates, ...walkedEnd]) {
    end = asDate(raw);
    if (end && end > start) break;
    end = null;
  }
  return { start, end };
}

// ─── Candidate sources ────────────────────────────────────────────────────────

async function fetchBookingEvents({ now, cfg, env = process.env, fetchImpl = fetch }) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!base || !key) return { rows: [], error: 'supabase_not_configured' };
  const qs = new URLSearchParams({
    select: 'id,client_slug,client_name,lead_email,lead_name,created_at,payload',
    event_type: 'eq.booking_confirmed',
    created_at: `gte.${new Date(now.getTime() - cfg.bookingLookbackMs).toISOString()}`,
    order: 'created_at.desc',
    limit: '500',
  });
  try {
    const res = await fetchImpl(`${base}/rest/v1/booking_events?${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) return { rows: [], error: `booking_events_http_${res.status}` };
    const rows = text ? JSON.parse(text) : [];
    return { rows: Array.isArray(rows) ? rows : [], error: null };
  } catch (err) {
    return { rows: [], error: `booking_events_${err.message}`.slice(0, 120) };
  }
}

function clientForBookingEvent(ev, clients) {
  const slug = String(ev.client_slug || '').trim().toLowerCase();
  const name = String(ev.client_name || '').trim().toLowerCase();
  return clients.find((c) => (slug && slugFromClientName(c.name) === slug)
    || (name && String(c.name || '').trim().toLowerCase() === name)) || null;
}

/** Calendar event (Google or Microsoft) in one shape. Times are Dates. */
function normalizeCalendarEvent(provider, ev, selfEmail) {
  const self = String(selfEmail || '').toLowerCase();
  let start; let end; let attendees; let cancelled;
  if (provider === 'google') {
    start = ev.start && (ev.start.dateTime ? new Date(ev.start.dateTime) : null); // all-day events have no time
    end = ev.end && (ev.end.dateTime ? new Date(ev.end.dateTime) : null);
    cancelled = ev.status === 'cancelled';
    attendees = (ev.attendees || []).map((a) => ({
      email: normalizeEmail(a.email),
      response: a.responseStatus || null,
      isSelf: a.self === true || a.organizer === true || a.resource === true,
    }));
  } else {
    start = ev.start && ev.start.dateTime ? new Date(`${String(ev.start.dateTime).replace(/Z?$/, 'Z')}`) : null;
    end = ev.end && ev.end.dateTime ? new Date(`${String(ev.end.dateTime).replace(/Z?$/, 'Z')}`) : null;
    cancelled = ev.isCancelled === true;
    attendees = (ev.attendees || []).map((a) => ({
      email: normalizeEmail(a.emailAddress && a.emailAddress.address),
      response: a.status && a.status.response ? String(a.status.response).toLowerCase() : null,
      isSelf: a.type === 'resource',
    }));
  }
  if (!start || !Number.isFinite(start.getTime())) return null;
  if (!end || !Number.isFinite(end.getTime()) || end <= start) end = null;
  return {
    id: ev.id || null,
    start,
    end,
    cancelled,
    attendees: attendees.filter((a) => a.email && !a.isSelf && a.email !== self),
  };
}

async function calendarEvents(client, { now, cfg, deps = {} }) {
  const { rows: [conn] } = await db.query(
    'SELECT * FROM calendar_connections WHERE client_id = $1 ORDER BY updated_at DESC LIMIT 1', [client.id]);
  if (!conn) return { events: [], error: 'no_calendar' };
  const provider = conn.provider === 'google' ? 'google' : 'microsoft';
  const api = deps.calendarApi ? deps.calendarApi[provider] : (provider === 'google' ? google : microsoft);
  try {
    const raw = await api.listEventsBetween(
      conn, new Date(now.getTime() - cfg.lookbackMs - 2 * HOUR), new Date(now.getTime() + cfg.futureMs));
    return { events: raw.map((e) => normalizeCalendarEvent(provider, e, conn.email)).filter(Boolean), error: null };
  } catch (err) {
    return { events: [], error: `calendar_${err.message}`.slice(0, 120) };
  }
}

async function bookedEmailsFor(clientId, now, cfg) {
  const out = new Set();
  const since = new Date(now.getTime() - cfg.bookingLookbackMs);
  const { rows } = await db.query(
    `SELECT lower(lead_email) AS email FROM meetings
      WHERE client_id = $1 AND status IN ('confirmed', 'booked') AND lead_email IS NOT NULL
        AND updated_at >= $2
     UNION
     SELECT lower(lead_email) FROM pending_replies
      WHERE client_id = $1 AND status = 'meeting_booked' AND lead_email IS NOT NULL
        AND updated_at >= $2`,
    [clientId, since],
  );
  rows.forEach((r) => { if (r.email) out.add(r.email); });
  return out;
}

/**
 * All booked meetings that may have been ghosted, one object per (client, email, start).
 * Also returns `future`: later bookings, used to spot a prospect who rescheduled.
 */
async function collectCandidates({ now, cfg, clients, env, deps = {} }) {
  const found = [];
  const sourceErrors = [];

  const bookings = await (deps.fetchBookingEvents || fetchBookingEvents)({ now, cfg, env, fetchImpl: deps.fetchImpl });
  if (bookings.error) sourceErrors.push({ source: 'booking_events', error: bookings.error });
  const bookedByClient = new Map();
  for (const ev of bookings.rows) {
    const client = clientForBookingEvent(ev, clients);
    const email = normalizeEmail(ev.lead_email);
    if (!client || !email) continue;
    if (!bookedByClient.has(client.id)) bookedByClient.set(client.id, new Set());
    bookedByClient.get(client.id).add(email);
    const when = meetingTimesFromPayload(ev.payload);
    if (!when) continue;
    found.push({
      client, email, name: ev.lead_name || null, source: 'booking_events', sourceRef: String(ev.id),
      start: when.start, end: when.end || new Date(when.start.getTime() + cfg.defaultDurationMs),
      endKnown: Boolean(when.end), calendar: null,
    });
  }

  for (const client of clients) {
    const { events, error } = await calendarEvents(client, { now, cfg, deps });
    if (error && error !== 'no_calendar') sourceErrors.push({ source: 'calendar', client: client.name, error });
    if (!events.length) continue;
    const booked = new Set([
      ...(bookedByClient.get(client.id) || []),
      ...(await bookedEmailsFor(client.id, now, cfg)),
    ]);
    for (const ev of events) {
      for (const a of ev.attendees) {
        if (!booked.has(a.email)) continue;
        found.push({
          client, email: a.email, name: null, source: 'calendar', sourceRef: ev.id,
          start: ev.start, end: ev.end || new Date(ev.start.getTime() + cfg.defaultDurationMs),
          endKnown: Boolean(ev.end), calendar: { cancelled: ev.cancelled, response: a.response },
        });
      }
    }
  }

  // Merge: the same meeting seen by two sources keeps the calendar view (real end, response state).
  const byLead = new Map();
  for (const c of found) {
    const k = `${c.client.id}|${c.email}`;
    if (!byLead.has(k)) byLead.set(k, []);
    byLead.get(k).push(c);
  }
  const merged = [];
  for (const list of byLead.values()) {
    list.sort((a, b) => a.start - b.start);
    const kept = [];
    for (const c of list) {
      const dup = kept.find((k) => Math.abs(k.start - c.start) <= 3 * HOUR);
      if (!dup) { kept.push(c); continue; }
      if (c.source === 'calendar' && dup.source !== 'calendar') {
        c.name = c.name || dup.name;
        kept[kept.indexOf(dup)] = c;
      } else {
        dup.name = dup.name || c.name;
      }
    }
    // A later booking for the same lead means the earlier one was rescheduled or replaced.
    kept.forEach((c, i) => { c.supersededBy = kept[i + 1] ? kept[i + 1].start : null; });
    merged.push(...kept);
  }
  return { candidates: merged, sourceErrors };
}

// ─── Fireflies ────────────────────────────────────────────────────────────────

function nameTokens(name) {
  return String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

function rowMentionsLead(row, { email, name }) {
  const blob = fireflies.attendeeBlob(row);
  if (!blob) return false;
  if (email && blob.includes(email)) return true;
  const tokens = nameTokens(name);
  return tokens.length >= 2 && tokens.every((t) => blob.includes(t));
}

/**
 * Was the prospect on the call, and did they speak?
 * @returns {{status: 'attended'|'ghosted'|'held', reason: string, evidence: object}}
 */
async function checkFireflies(cand, { env = process.env, deps = {} } = {}) {
  const api = deps.firefliesApi || fireflies;
  if (!api.isConfigured(env)) {
    return { status: 'held', reason: 'fireflies_not_configured', evidence: { fireflies: 'not_configured' } };
  }
  let list;
  try {
    list = await api.listTranscriptsBetween(
      new Date(cand.start.getTime() - 90 * MIN), new Date(cand.end.getTime() + 3 * HOUR), { env, fetchImpl: deps.fetchImpl });
  } catch (err) {
    return { status: 'held', reason: 'fireflies_error', evidence: { fireflies_error: String(err.message).slice(0, 120) } };
  }
  const lead = { email: cand.email, name: cand.name };
  const matches = list.filter((t) => rowMentionsLead(t, lead));
  if (!matches.length) {
    return {
      status: 'ghosted', reason: 'no_recording',
      evidence: { fireflies: 'no_transcript', transcripts_in_window: list.length },
    };
  }
  const t = matches[0];
  if (t.is_live === true) {
    return { status: 'held', reason: 'meeting_still_live', evidence: { fireflies: 'live', transcript_id: t.id } };
  }
  const state = String((t.meeting_info && t.meeting_info.summary_status) || '').toLowerCase();
  if (state === 'processing' || state === 'pending') {
    return { status: 'held', reason: 'transcript_processing', evidence: { fireflies: state, transcript_id: t.id } };
  }
  if (t.meeting_info && t.meeting_info.silent_meeting === true) {
    return { status: 'ghosted', reason: 'silent_call', evidence: { fireflies: 'silent_meeting', transcript_id: t.id } };
  }
  // Obvious no-show rule 2: the recording is shorter than the minimum (Fireflies duration is in minutes).
  const minMinutes = envNumber(env, 'GHOSTED_MEETING_MIN_MINUTES', 5);
  const durationMin = Number(t.duration);
  if (Number.isFinite(durationMin) && durationMin < minMinutes) {
    return {
      status: 'ghosted', reason: 'short_meeting',
      evidence: { fireflies: 'short', transcript_id: t.id, duration_minutes: Math.round(durationMin * 10) / 10 },
    };
  }
  // Obvious no-show rule 1: only one person was on the call (joined or spoke).
  let detail;
  try {
    detail = await api.getTranscriptAttendance(t.id, { env, fetchImpl: deps.fetchImpl });
  } catch (err) {
    return { status: 'held', reason: 'fireflies_error', evidence: { fireflies_error: String(err.message).slice(0, 120), transcript_id: t.id } };
  }
  const people = distinctPeople(detail, t);
  const evidence = {
    fireflies: 'transcript', transcript_id: t.id, participants: people.size,
    ...(Number.isFinite(durationMin) ? { duration_minutes: Math.round(durationMin * 10) / 10 } : {}),
  };
  if (people.size >= 2) return { status: 'attended', reason: 'multiple_participants', evidence };
  return { status: 'ghosted', reason: 'single_participant', evidence };
}

const NOTETAKER = /fireflies|notetaker|note taker|otter\.ai|read\.ai|fathom/i;

/** Distinct humans who joined or spoke (Fireflies' own notetaker bot never counts). */
function distinctPeople(detail, row) {
  const out = new Set();
  const add = (v) => {
    const k = String(v || '').trim().toLowerCase();
    if (k && !NOTETAKER.test(k)) out.add(k);
  };
  const d = detail || {};
  for (const a of d.meeting_attendance || row.meeting_attendance || []) add(a && a.name);
  for (const s of d.sentences || []) if (s && String(s.text || '').trim()) add(s.speaker_name);
  return out;
}

// ─── Dedupe against what is already on the board ─────────────────────────────

function fullNameInText(text, name) {
  const tokens = nameTokens(name);
  const hay = String(text || '').toLowerCase();
  return tokens.length >= 2 && tokens.every((t) => hay.includes(t));
}

/**
 * Has someone already posted this lead into the follow-ups channel (including by hand)?
 * Matches the lead's email or full name in the channel's recent history.
 * @returns {Promise<{found: boolean, error?: string}>}
 */
async function channelAlreadyHasLead(client, { email, name, since, deps = {} }) {
  const channel = followUpSlackChannelId();
  try {
    const history = deps.channelHistory
      ? await deps.channelHistory({ client, channel, since })
      : (await slack.getClient(client.slack_bot_token).conversations.history({
        channel, oldest: String(Math.floor(since.getTime() / 1000)), limit: 200,
      })).messages;
    for (const m of history || []) {
      const hay = `${m.text || ''} ${m.blocks ? JSON.stringify(m.blocks) : ''} ${m.attachments ? JSON.stringify(m.attachments) : ''}`;
      if ((email && hay.toLowerCase().includes(email)) || fullNameInText(hay, name)) return { found: true };
    }
    return { found: false };
  } catch (err) {
    return { found: false, error: String(err.message).slice(0, 120) };
  }
}

async function existingFollowUpFor(client, key, { email, since }) {
  const { rows: [seq] } = await db.query(
    `SELECT id, origin, status FROM followup_sequences
      WHERE client_id = $1 AND lead_key = $2
        AND (status = 'active' OR (origin = $3 AND created_at >= $4))
      ORDER BY created_at DESC LIMIT 1`,
    [client.id, key, ORIGIN, since],
  );
  if (seq) return seq.status === 'active' ? 'sequence_already_active' : 'already_enrolled';
  const { rows: [card] } = await db.query(
    `SELECT id FROM pending_replies
      WHERE client_id = $1 AND upper(classification) = 'FOLLOW_UP'
        AND lower(coalesce(lead_email, '')) = $2 AND created_at >= $3
      LIMIT 1`,
    [client.id, email, since],
  );
  return card ? 'follow_up_card_exists' : null;
}

async function repliedSince(client, email, since) {
  const { rows } = await db.query(
    `SELECT 1 FROM pending_replies
      WHERE client_id = $1 AND upper(classification) <> 'FOLLOW_UP'
        AND lower(coalesce(lead_email, '')) = $2 AND created_at > $3
      LIMIT 1`,
    [client.id, email, since],
  );
  return rows.length > 0;
}

async function sourceReplyFor(client, email) {
  const { rows: [viaMeeting] } = await db.query(
    `SELECT pr.* FROM meetings m JOIN pending_replies pr ON pr.id = m.pending_reply_id
      WHERE m.client_id = $1 AND lower(coalesce(m.lead_email, '')) = $2
        AND pr.platform IN ('smartlead', 'heyreach')
      ORDER BY m.updated_at DESC LIMIT 1`,
    [client.id, email],
  );
  if (viaMeeting) return viaMeeting;
  const { rows: [row] } = await db.query(
    `SELECT * FROM pending_replies
      WHERE client_id = $1 AND lower(coalesce(lead_email, '')) = $2
        AND platform IN ('smartlead', 'heyreach') AND upper(classification) <> 'FOLLOW_UP'
      ORDER BY created_at DESC LIMIT 1`,
    [client.id, email],
  );
  return row || null;
}

// ─── Enrollment ───────────────────────────────────────────────────────────────

async function enrollGhost(check, client, source, { now, env, dbClient = db }) {
  const key = leadKey({ clientId: client.id, leadEmail: source.lead_email || check.lead_email, linkedinUrl: source.linkedin_url, leadId: source.lead_id });
  const tz = time.resolveTimeZone(source.lead_timezone, client.digest_timezone);
  let seqId;
  try {
    const { rows } = await dbClient.query(
      `INSERT INTO followup_sequences
         (client_id, source_reply_id, platform, campaign_id, lead_key, lead_name, lead_email,
          linkedin_url, lead_timezone, enrolled_at, status, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11)
       ON CONFLICT (source_reply_id, origin) DO NOTHING
       RETURNING id`,
      [client.id, source.id, source.platform, source.campaign_id || null, key,
        source.lead_name || check.lead_name || null, source.lead_email || check.lead_email || null,
        source.linkedin_url || null, source.lead_timezone || null, now, ORIGIN],
    );
    seqId = rows[0] && rows[0].id;
  } catch (err) {
    if (err && err.code === '23505') return { ok: false, reason: 'sequence_already_active' };
    throw err;
  }
  if (!seqId) return { ok: false, reason: 'already_enrolled' };

  const plan = ghostText.planGhostSequence({ enrolledAt: now, timeZone: tz, time, env, fullSequence: fullSequence(env) });
  for (const s of plan) {
    await dbClient.query(
      `INSERT INTO followup_sequence_steps (sequence_id, kind, seq_order, due_at, status, payload)
       VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)`,
      [seqId, s.kind, s.order, s.due, JSON.stringify({
        ghost: { checkId: check.id, meetingStart: check.meeting_start, reason: check.reason },
      })],
    );
  }
  return { ok: true, sequenceId: seqId, steps: plan.length };
}

// ─── One candidate ────────────────────────────────────────────────────────────

async function processCandidate(cand, { now, cfg, env, dryRun, deps, totals, dbClient = db }) {
  const { client } = cand;
  const key = leadKey({ clientId: client.id, leadEmail: cand.email });
  const idsBase = { client: client.name, lead_key: key, meeting_start: cand.start.toISOString(), source: cand.source };

  // Not due yet, or too old to act on: leave it alone (no row, no noise).
  if (cand.end > now - cfg.graceMs) return;
  if (cand.end < now - cfg.lookbackMs) return;

  const { rows: [inserted] } = await dbClient.query(
    `INSERT INTO ghosted_meeting_checks
       (client_id, lead_key, lead_email, lead_name, meeting_start, meeting_end, source, source_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (client_id, lead_key, meeting_start) DO NOTHING
     RETURNING *`,
    [client.id, key, cand.email, cand.name, cand.start, cand.end, cand.source, cand.sourceRef || null],
  );
  let check = inserted;
  if (check) {
    totals.candidates++;
    check.client_name = client.name;
    await trail(dbClient, check.id, 'candidate_found', { source: cand.source });
    log('candidate_found', { check_id: check.id, ...idsBase, end_known: cand.endKnown });
  } else {
    const { rows: [existing] } = await dbClient.query(
      'SELECT * FROM ghosted_meeting_checks WHERE client_id = $1 AND lead_key = $2 AND meeting_start = $3',
      [client.id, key, cand.start]);
    check = existing;
    check.client_name = client.name;
    // Only undecided rows are worked again. A ghosted row that failed to enroll retries.
    if (!['candidate', 'held', 'ghosted'].includes(check.decision)) return;
    if (check.decision === 'ghosted' && check.sequence_id) return;
  }

  const drop = async (reason, evidence = {}) => {
    totals.dropped++;
    await decide(dbClient, check, 'dropped', reason, evidence);
  };

  if (cfg.floor && cand.end < cfg.floor) return drop('before_start_floor');
  if (cand.supersededBy) return drop('rescheduled_or_replaced', { later_booking: cand.supersededBy.toISOString() });
  if (cand.calendar && cand.calendar.cancelled) return drop('meeting_cancelled');
  if (cand.calendar && ['declined'].includes(String(cand.calendar.response || '').toLowerCase())) {
    return drop('invitee_declined');
  }
  if (await isDisqualified(client.id, { leadEmail: cand.email })) return drop('disqualified');
  if (await repliedSince(client, cand.email, cand.start)) return drop('prospect_replied_since_meeting');

  const existing = await existingFollowUpFor(client, key, { email: cand.email, since: cand.start });
  if (existing) return drop(existing);

  // Fireflies: the attendance signal.
  const ff = await checkFireflies(cand, { env, deps });
  await trail(dbClient, check.id, 'fireflies_checked', { status: ff.status, reason: ff.reason });
  log('fireflies_checked', { check_id: check.id, ...idsBase, status: ff.status, reason: ff.reason, ...ff.evidence });

  if (ff.status === 'attended') {
    totals.attended++;
    return decide(dbClient, check, 'attended', ff.reason, ff.evidence);
  }
  if (ff.status === 'held') {
    totals.held++;
    if (check.decision !== 'held' || check.reason !== ff.reason) {
      await decide(dbClient, check, 'held', ff.reason, ff.evidence);
    }
    return undefined;
  }

  totals.ghosted++;
  if (check.decision !== 'ghosted') await decide(dbClient, check, 'ghosted', ff.reason, ff.evidence);

  // Last dedupe: a card someone posted by hand never shows up in the database.
  const seen = await channelAlreadyHasLead(client, { email: cand.email, name: cand.name, since: new Date(cand.start.getTime() - HOUR), deps });
  if (seen.found) return drop('already_in_channel', { dedupe: 'channel_history' });
  if (seen.error) log('dedupe_history_unavailable', { check_id: check.id, ...idsBase, error: seen.error });

  const source = await sourceReplyFor(client, cand.email);
  if (!source) return drop('no_source_reply');
  if (await isLeadClaimed({ leadEmail: cand.email, campaignId: source.campaign_id })) return drop('client_claimed');

  if (dryRun) {
    await trail(dbClient, check.id, 'dry_run', { would_enroll: true });
    log('dry_run', { check_id: check.id, ...idsBase, would_enroll: true });
    return undefined;
  }

  check.reason = ff.reason; // the step payload carries it onto the cards
  const res = await enrollGhost(check, client, source, { now, env, dbClient });
  if (!res.ok) return drop(res.reason);
  totals.enrolled++;
  await decide(dbClient, check, 'enrolled', ff.reason, { steps: res.steps }, { sequenceId: res.sequenceId });
  log('enrolled', { check_id: check.id, ...idsBase, sequence_id: res.sequenceId, steps: res.steps });
  return undefined;
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

let scanActive = false;

/**
 * Find ghosted meetings and enroll them. `dryRun` decides and logs but enrolls nothing.
 * Safe to call when the flag is off only with dryRun (the admin route forces that).
 */
async function runGhostedMeetingScan({ now = new Date(), env = process.env, dryRun = false, deps = {} } = {}) {
  const totals = { candidates: 0, ghosted: 0, attended: 0, held: 0, dropped: 0, enrolled: 0, sourceErrors: [] };
  if (!enabled(env) && !dryRun) return { ...totals, disabled: true };
  if (scanActive) return { ...totals, overlap: true };
  scanActive = true;
  try {
    const cfg = config(env);
    const { rows: clients } = await db.query(
      `SELECT * FROM clients WHERE active IS DISTINCT FROM false AND slack_bot_token IS NOT NULL`);
    const { candidates, sourceErrors } = await collectCandidates({ now, cfg, clients, env, deps });
    totals.sourceErrors = sourceErrors;
    for (const e of sourceErrors) log('source_error', e);
    const due = candidates
      .filter((c) => c.end <= now - cfg.graceMs && c.end >= now - cfg.lookbackMs)
      .sort((a, b) => a.end - b.end)
      .slice(0, cfg.maxPerRun);
    for (const cand of due) {
      try {
        await processCandidate(cand, { now, cfg, env, dryRun, deps, totals });
      } catch (err) {
        console.error('[GhostedMeeting] candidate failed', { client: cand.client.name, err: err.message });
        log('error', { client: cand.client.name, source: cand.source, error: String(err.message).slice(0, 160) });
      }
    }
    // Anything still undecided after the lookback is closed with a reason, never left silent.
    const expired = await db.query(
      `UPDATE ghosted_meeting_checks
          SET decision = 'dropped', reason = 'expired_' || decision, decided_at = now(),
              trail = trail || jsonb_build_array(jsonb_build_object('at', now(), 'stage', 'dropped', 'reason', 'expired_' || decision)),
              updated_at = now()
        WHERE decision IN ('candidate', 'held', 'ghosted') AND sequence_id IS NULL AND meeting_end < $1
        RETURNING id, lead_key, reason`,
      [new Date(now.getTime() - cfg.lookbackMs)],
    );
    for (const r of expired.rows) log('dropped', { check_id: r.id, lead_key: r.lead_key, reason: r.reason });
    return totals;
  } finally {
    scanActive = false;
  }
}

// ─── Hooks used by the sequence runner ───────────────────────────────────────

/**
 * Should this ghosted-meeting sequence stop? The source reply is already marked
 * booked (that is the premise), so the normal booked check does not apply. Stops
 * on: DQ or client claim, any new prospect reply, or a new booking after enrollment.
 */
async function stopReason(seq, source, { dbClient = db, env = process.env, deps = {} } = {}) {
  const clientId = seq.client_id;
  const email = String(seq.lead_email || source.lead_email || '').trim().toLowerCase();
  if (await isDisqualified(clientId, { leadEmail: email })) return 'disqualified';
  if (await isLeadClaimed({ leadEmail: email, campaignId: source.campaign_id })) return 'client_claimed';
  if (!email) return null;
  const { rows: inbound } = await dbClient.query(
    `SELECT 1 FROM pending_replies
      WHERE client_id = $1 AND upper(classification) <> 'FOLLOW_UP'
        AND lower(coalesce(lead_email, '')) = $2 AND created_at > $3 LIMIT 1`,
    [clientId, email, seq.enrolled_at],
  );
  if (inbound.length) return 'inbound_reply';
  const { rows: booked } = await dbClient.query(
    `SELECT 1 FROM meetings
      WHERE client_id = $1 AND lower(coalesce(lead_email, '')) = $2
        AND status IN ('confirmed', 'booked') AND updated_at > $3 LIMIT 1`,
    [clientId, email, seq.enrolled_at],
  );
  if (booked.length) return 'rebooked';
  const cfg = config(env);
  const pulled = await (deps.fetchBookingEvents || fetchBookingEvents)({
    now: new Date(), cfg: { ...cfg, bookingLookbackMs: cfg.bookingLookbackMs }, env, fetchImpl: deps.fetchImpl });
  for (const ev of pulled.rows || []) {
    if (normalizeEmail(ev.lead_email) === email && new Date(ev.created_at) > new Date(seq.enrolled_at)) return 'rebooked';
  }
  return null;
}

/** Called by the runner when a ghosted-meeting step's card is up. Never throws. */
async function recordStepPosted(seq, step, { dbClient = db, ts = null } = {}) {
  try {
    const payload = parseJson(step.payload) || {};
    const checkId = payload.ghost && payload.ghost.checkId;
    await trail(dbClient, checkId, 'posted', { kind: step.kind, slack_ts: ts });
    log('posted', { check_id: checkId || null, sequence_id: seq.id, kind: step.kind, channel: followUpSlackChannelId(), slack_ts: ts });
  } catch (err) {
    console.warn('[GhostedMeeting] recordStepPosted failed', { err: err.message });
  }
}

module.exports = {
  ORIGIN,
  enabled,
  config,
  log,
  meetingTimesFromPayload,
  normalizeCalendarEvent,
  collectCandidates,
  checkFireflies,
  channelAlreadyHasLead,
  enrollGhost,
  runGhostedMeetingScan,
  stopReason,
  recordStepPosted,
};
