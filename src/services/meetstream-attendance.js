'use strict';

/**
 * MeetStream attendance tracking. OFF by default (MEETSTREAM_ATTENDANCE_ENABLED).
 *
 * A silent bot named "Attendance" joins a Google Meet around its start time, reports who is in the
 * call, and leaves. It records nothing: no audio, no video, no transcript, no chat. The result is
 * written to meeting_attendance as showed / no_show (or unverified when we cannot tell).
 *
 *   MEETSTREAM_ATTENDANCE_ENABLED   master switch
 *   MEETSTREAM_ATTENDANCE_SCOPE     josh_only (default) | clients | all
 *   MEETSTREAM_API_KEY              MeetStream API key (never logged)
 *   MEETSTREAM_WEBHOOK_TOKEN        secret path segment on the webhook URL
 *   MEETSTREAM_NOSHOW_MINUTES       wait for the prospect this long after the start (default 10)
 *   MEETSTREAM_LEAD_MINUTES         send the bot this long before the start (default 2)
 *   MEETSTREAM_MAX_BOTS             lifetime cap on bots created (default 20), a spend guard
 *   MEETSTREAM_INTERNAL_NAMES       comma list of host-side display names (default Josh)
 *   MEETSTREAM_CLIENTS_OFF          comma list of client slugs that must NOT get a bot (default none: every
 *                                   TidyCal client is ON once the scope allows clients)
 *
 * Nothing here is client-facing and nothing posts to Slack.
 *
 * Decision rules (never guess a no-show):
 *   showed      a participant who is not internal and not a bot has been in the call
 *   no_show     our bot was in the call through start + NOSHOW minutes and nobody else showed
 *   unverified  our bot never got in (lobby not admitted, failed, removed) so we cannot say
 */
const crypto = require('crypto');
const db = require('../db');

const DEFAULT_BASE = 'https://api.meetstream.ai/api/v1';
const BOT_NAME = 'Attendance';
const COST_PER_HOUR_USD = 0.35;
const MIN = 60 * 1000;
const MAX_EVENTS = 60;

const BOT_NAME_RE = /attendance|notetaker|note taker|fireflies|otter|fathom|read\.ai|tl;?dv|grain|recorder|meetstream|krisp|\bbot\b/i;
const ENDING_EVENTS = new Set(['bot.stopped', 'bot.kicked', 'bot.denied', 'bot.notallowed', 'bot.failed']);
const ACTIVE = ['bot_requested', 'in_meeting'];

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v || '').trim());
}

function enabled(env = process.env) {
  return truthy(env.MEETSTREAM_ATTENDANCE_ENABLED);
}

function scopeSetting(env = process.env) {
  const v = String(env.MEETSTREAM_ATTENDANCE_SCOPE || 'josh_only').trim().toLowerCase();
  return ['josh_only', 'clients', 'all'].includes(v) ? v : 'josh_only';
}

/** Is a meeting of this scope (josh | client) allowed to get a bot under the current setting? */
function scopeAllows(rowScope, env = process.env) {
  const s = scopeSetting(env);
  if (s === 'all') return true;
  if (s === 'clients') return rowScope === 'client';
  return rowScope === 'josh';
}

/** Per-client switch. Every client is ON unless its slug is listed in MEETSTREAM_CLIENTS_OFF. */
function clientOff(slug, env = process.env) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return false;
  return String(env.MEETSTREAM_CLIENTS_OFF || '').split(',')
    .map((x) => x.trim().toLowerCase()).filter(Boolean).includes(s);
}

function num(env, name, fallback) {
  const n = parseFloat(env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function config(env = process.env) {
  return {
    base: String(env.MEETSTREAM_API_BASE || DEFAULT_BASE).replace(/\/+$/, ''),
    publicUrl: String(env.MEETSTREAM_PUBLIC_URL || 'https://app-production-9354.up.railway.app').replace(/\/+$/, ''),
    noShowMs: num(env, 'MEETSTREAM_NOSHOW_MINUTES', 10) * MIN,
    leadMs: num(env, 'MEETSTREAM_LEAD_MINUTES', 2) * MIN,
    maxBots: Math.floor(num(env, 'MEETSTREAM_MAX_BOTS', 20)),
    hardStopMs: num(env, 'MEETSTREAM_HARD_STOP_MINUTES', 45) * MIN,
    internalNames: String(env.MEETSTREAM_INTERNAL_NAMES || 'Josh,Josh Osborn,Joshua Osborn')
      .split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function apiKey(env = process.env) {
  return String(env.MEETSTREAM_API_KEY || '').trim();
}

function webhookToken(env = process.env) {
  return String(env.MEETSTREAM_WEBHOOK_TOKEN || '').trim();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function tokenOk(candidate, env = process.env) {
  const t = webhookToken(env);
  return Boolean(t) && safeEqual(candidate, t);
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function platformOf(url) {
  const u = String(url || '').toLowerCase();
  if (/^https?:\/\/meet\.google\.com\//.test(u)) return 'google_meet';
  if (/zoom\.(us|com)\//.test(u)) return 'zoom';
  if (/teams\.(microsoft|live)\.com\//.test(u)) return 'teams';
  return 'other';
}

/** Rough worst-case spend for one bot: lead + no-show window + a 3 minute exit margin. */
function estimateCostUsd(cfg = config()) {
  const minutes = (cfg.leadMs + cfg.noShowMs) / MIN + 3;
  return Math.round((minutes / 60) * COST_PER_HOUR_USD * 10000) / 10000;
}

function nameKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isInternal(name, internalNames) {
  const n = nameKey(name);
  if (!n) return false;
  // Exact match only: a prospect called "Josh Smith" must never be mistaken for the host.
  return (internalNames || []).some((x) => nameKey(x) === n);
}

/**
 * Classify a get_participants list. Names are used only to classify, never stored.
 * A participant counts as present when MeetStream saw them in the meeting at any point
 * (in_meeting or not_in_meeting both mean they joined).
 */
function classifyParticipants(list, internalNames) {
  const out = { prospect: false, internal: 0, bots: 0, summary: [] };
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || p.parentDeviceId) continue; // secondary device of someone already listed
    const name = p.displayName || p.fullName || '';
    const state = /not_in_meeting/i.test(String(p.humanized_status || '')) ? 'left' : 'in_call';
    let role;
    if (p.isHost === true || isInternal(name, internalNames)) role = 'internal';
    else if (BOT_NAME_RE.test(name)) role = 'bot';
    else if (!String(name).trim()) role = 'unknown';
    else role = 'other';
    if (role === 'internal') out.internal += 1;
    else if (role === 'bot') out.bots += 1;
    else if (role === 'other') out.prospect = true;
    out.summary.push({ role, state });
  }
  return out;
}

/**
 * Pure decision. `now` and times are epoch ms. Returns null when nothing is decided yet.
 *   inMeeting: our bot was admitted at some point
 *   botEnded:  our bot is gone (ended / removed)
 */
function decide({ prospect, inMeeting, botEnded, startsAtMs, nowMs, noShowMs }) {
  if (prospect) return { status: 'showed', reason: 'participant_joined' };
  const windowEnd = startsAtMs + noShowMs;
  if (inMeeting && nowMs >= windowEnd) return { status: 'no_show', reason: 'nobody_joined_in_window' };
  if (botEnded) {
    return inMeeting
      ? { status: 'unverified', reason: 'bot_left_before_window_end' }
      : { status: 'unverified', reason: 'bot_never_admitted' };
  }
  if (!inMeeting && nowMs >= windowEnd + 5 * MIN) return { status: 'unverified', reason: 'bot_never_admitted' };
  return null;
}

function createBotPayload(row, cfg = config(), env = process.env) {
  const hook = `${cfg.publicUrl}/webhook/meetstream/${webhookToken(env)}`;
  return {
    meeting_link: row.meeting_url,
    bot_name: BOT_NAME,
    // Silent: no mixed audio, no video, no separate streams, no transcript provider, no chat message.
    audio_required: false,
    video_required: false,
    audio_separate_streams: false,
    video_separate_streams: false,
    callback_url: hook,
    deduplication_key: `rh-attendance-${row.id}`,
    custom_attributes: { rh_attendance_id: row.id, scope: row.scope },
    automatic_leave: {
      waiting_room_timeout: 600,
      no_one_joined_timeout: 600,
      everyone_left_timeout: 60,
      voice_inactivity_timeout: 1800,
    },
    recording_config: {
      retention: { type: 'timed', hours: 1 },
      realtime_endpoints: [
        { type: 'webhook', url: hook, events: ['participant_events.join', 'participant_events.leave'] },
      ],
    },
  };
}

// ─── MeetStream API ──────────────────────────────────────────────────────────

async function api(method, path, { body, headers, env = process.env, fetchImpl = fetch } = {}) {
  const key = apiKey(env);
  if (!key) throw new Error('meetstream_api_key_missing');
  const cfg = config(env);
  const res = await fetchImpl(`${cfg.base}${path}`, {
    method,
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json', ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text: json ? undefined : String(text).slice(0, 300) };
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function addEvent(id, entry) {
  await db.query(
    `UPDATE meeting_attendance
        SET events = (
          SELECT COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM (
            SELECT e, n FROM jsonb_array_elements(events || $2::jsonb) WITH ORDINALITY t(e, n)
            ORDER BY n DESC LIMIT ${MAX_EVENTS}
          ) s
        ),
        updated_at = now()
      WHERE id = $1`,
    [id, JSON.stringify([{ t: new Date().toISOString(), ...entry }])]
  );
}

async function getRow(id) {
  const { rows } = await db.query('SELECT * FROM meeting_attendance WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getRowByBot(botId) {
  const { rows } = await db.query('SELECT * FROM meeting_attendance WHERE bot_id = $1', [botId]);
  return rows[0] || null;
}

// ─── Registration ────────────────────────────────────────────────────────────

function asIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Record a meeting we may track. Idempotent on (source, booking_ref): a reschedule moves the time of a
 * row that has no bot yet, a cancel marks it cancelled. Rows outside the scope are stored as skipped.
 */
async function registerBooking(input, env = process.env) {
  const source = String(input.source || '').trim().slice(0, 40);
  const bookingRef = String(input.booking_ref || '').trim().slice(0, 200);
  const scope = input.scope === 'josh' ? 'josh' : 'client';
  const startsAt = asIso(input.starts_at);
  if (!source || !bookingRef) return { ok: false, status: 400, error: 'source_and_booking_ref_required' };

  if (input.cancelled === true) {
    const { rows } = await db.query(
      `UPDATE meeting_attendance SET status = 'cancelled', reason = 'booking_cancelled', updated_at = now()
        WHERE source = $1 AND booking_ref = $2 AND status IN ('scheduled', 'skipped') RETURNING id, status`,
      [source, bookingRef]
    );
    return { ok: true, cancelled: rows.length > 0, id: rows[0]?.id || null };
  }
  if (!startsAt) return { ok: false, status: 400, error: 'starts_at_required' };

  const meetingUrl = input.meeting_url ? String(input.meeting_url).trim().slice(0, 500) : null;
  const platform = platformOf(meetingUrl);
  const cfg = config(env);
  const internal = Array.isArray(input.internal_names) && input.internal_names.length
    ? input.internal_names.map((s) => String(s).trim()).filter(Boolean).slice(0, 10)
    : cfg.internalNames;
  const endsAt = asIso(input.ends_at) || new Date(new Date(startsAt).getTime() + 30 * MIN).toISOString();

  let status = 'scheduled';
  let reason = null;
  if (!meetingUrl) { status = 'skipped'; reason = 'no_meeting_url'; }
  else if (platform === 'zoom') { status = 'skipped'; reason = 'zoom_manual'; }
  else if (platform !== 'google_meet') { status = 'skipped'; reason = `unsupported_platform_${platform}`; }
  else if (scope === 'client' && clientOff(input.client_slug, env)) { status = 'skipped'; reason = 'client_off'; }
  else if (!scopeAllows(scope, env)) { status = 'skipped'; reason = `scope_${scopeSetting(env)}`; }

  const { rows } = await db.query(
    `INSERT INTO meeting_attendance
       (source, booking_ref, scope, client_slug, meeting_url, platform, starts_at, ends_at, internal_names, status, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (source, booking_ref) DO UPDATE SET
       meeting_url = EXCLUDED.meeting_url,
       platform = EXCLUDED.platform,
       starts_at = CASE WHEN meeting_attendance.bot_id IS NULL THEN EXCLUDED.starts_at ELSE meeting_attendance.starts_at END,
       ends_at = CASE WHEN meeting_attendance.bot_id IS NULL THEN EXCLUDED.ends_at ELSE meeting_attendance.ends_at END,
       status = CASE WHEN meeting_attendance.bot_id IS NULL AND meeting_attendance.status IN ('scheduled','skipped','cancelled')
                          AND NOT (meeting_attendance.status = 'skipped' AND meeting_attendance.reason IN ('missed_window','bot_cap_reached'))
                     THEN EXCLUDED.status ELSE meeting_attendance.status END,
       reason = CASE WHEN meeting_attendance.bot_id IS NULL AND meeting_attendance.status IN ('scheduled','skipped','cancelled')
                          AND NOT (meeting_attendance.status = 'skipped' AND meeting_attendance.reason IN ('missed_window','bot_cap_reached'))
                     THEN EXCLUDED.reason ELSE meeting_attendance.reason END,
       updated_at = now()
     RETURNING id, status, reason, platform`,
    [source, bookingRef, scope, input.client_slug ? String(input.client_slug).slice(0, 80) : null,
      meetingUrl, platform, startsAt, endsAt, internal, status, reason]
  );
  return { ok: true, id: rows[0].id, status: rows[0].status, reason: rows[0].reason, platform: rows[0].platform };
}

/**
 * booking-bridge /webhook/booking-bridge payloads. A TidyCal booking (numeric booking_ref) is resolved through the
 * TidyCal API, which is the source of truth for the join link and time (the embed event carries neither a link nor
 * a host). Anything else needs meeting_url + starts_at on the payload itself.
 */
async function registerFromBridgePayload(body, env = process.env, deps = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.event !== 'booking_confirmed') return { ok: true, skipped: 'no_meeting_fields' };
  const ref = String(b.booking_ref || b.tidycal_booking_id || '').trim();
  if (/^\d+$/.test(ref)) {
    const tidycal = deps.tidycal || require('./tidycal-attendance');
    if (tidycal.tokenOf(env)) {
      const r = await tidycal.registerById(ref, { env, clientSlug: b.client_slug, fetchImpl: deps.fetchImpl, register: deps.register });
      if (r) return r;
    }
  }
  if (!b.meeting_url || !b.starts_at) return { ok: true, skipped: 'no_meeting_fields' };
  return registerBooking({
    source: 'booking_bridge',
    booking_ref: ref || `${b.client_slug || 'client'}:${b.email || ''}:${b.starts_at}`,
    scope: 'client',
    client_slug: b.client_slug,
    meeting_url: b.meeting_url,
    starts_at: b.starts_at,
    ends_at: b.ends_at,
    internal_names: b.internal_names,
  }, env);
}

// ─── Decisions ───────────────────────────────────────────────────────────────

async function finish(row, decision, extra = {}) {
  const { rows } = await db.query(
    `UPDATE meeting_attendance
        SET status = $2, reason = $3, decided_at = now(), updated_at = now(),
            prospect_joined_at = COALESCE(prospect_joined_at, $4)
      WHERE id = $1 AND status IN ('creating','bot_requested','in_meeting','scheduled')
      RETURNING *`,
    [row.id, decision.status, decision.reason, decision.status === 'showed' ? new Date() : null]
  );
  if (rows[0]) await addEvent(row.id, { decision: decision.status, reason: decision.reason, ...extra });
  return rows[0] || null;
}

async function removeBot(row, env = process.env, fetchImpl = fetch) {
  if (!row.bot_id) return { ok: false, error: 'no_bot' };
  try {
    const r = await api('GET', `/bots/${encodeURIComponent(row.bot_id)}/remove_bot`, { env, fetchImpl });
    await addEvent(row.id, { remove_bot: r.status });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    await addEvent(row.id, { remove_bot_error: String(err.message).slice(0, 100) });
    return { ok: false, error: err.message };
  }
}

/**
 * Re-read participants for one active row, record the roles, and decide.
 * Called from the minute tick and straight from webhook events.
 */
async function evaluateRow(rowIn, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const row = typeof rowIn === 'string' ? await getRow(rowIn) : rowIn;
  if (!row || !row.bot_id || !['bot_requested', 'in_meeting'].includes(row.status)) return { skipped: true };
  const cfg = config(env);

  let list = null;
  try {
    const r = await api('GET', `/bots/${encodeURIComponent(row.bot_id)}/get_participants`, { env, fetchImpl });
    if (r.ok && Array.isArray(r.json)) list = r.json;
  } catch (err) {
    await addEvent(row.id, { participants_error: String(err.message).slice(0, 100) });
  }
  const cls = classifyParticipants(list || [], row.internal_names);
  if (list) {
    await db.query('UPDATE meeting_attendance SET participants = $2::jsonb, updated_at = now() WHERE id = $1',
      [row.id, JSON.stringify(cls.summary)]);
  }

  const startsMs = new Date(row.starts_at).getTime();
  const inMeeting = Boolean(row.bot_joined_at) || row.status === 'in_meeting';
  const botEnded = Boolean(row.bot_left_at);
  const d = decide({ prospect: cls.prospect, inMeeting, botEnded, startsAtMs: startsMs, nowMs: now, noShowMs: cfg.noShowMs });
  if (!d) return { decided: false, participants: cls.summary.length };

  const done = await finish(row, d, { participants: cls.summary.length });
  if (done && !botEnded) await removeBot(row, env, fetchImpl);
  return { decided: true, status: d.status, reason: d.reason };
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

function eventName(body) {
  return String(body.bot_event || body.event || '').trim();
}

/** Apply one MeetStream webhook delivery. Unknown bots and unknown events are ignored, never errors. */
async function handleWebhook(body, { env = process.env, fetchImpl = fetch } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const botId = String(b.bot_id || b.botId || '').trim();
  if (!botId) return { ok: true, ignored: 'no_bot_id' };
  const row = await getRowByBot(botId);
  if (!row) return { ok: true, ignored: 'unknown_bot' };
  const ev = eventName(b);
  const status = b.bot_status ? String(b.bot_status) : null;

  // Keep the shape of participant events visible (keys only, never names) so the handler can be tuned.
  const entry = { event: ev || 'unknown', bot_status: status, code: b.status_code ?? null };
  if (ev.startsWith('participant_events')) entry.keys = Object.keys(b).slice(0, 12);
  if (b.failure_reason) entry.failure_reason = String(b.failure_reason).slice(0, 60);
  await addEvent(row.id, entry);

  if (ev === 'bot.inmeeting') {
    await db.query(
      `UPDATE meeting_attendance SET status = CASE WHEN status = 'bot_requested' THEN 'in_meeting' ELSE status END,
              bot_status = $2, bot_joined_at = COALESCE(bot_joined_at, now()), updated_at = now() WHERE id = $1`,
      [row.id, status]
    );
    return { ok: true, event: ev };
  }
  if (ev === 'participant_events.join' || ev === 'participant_events.leave') {
    setImmediate(() => evaluateRow(row.id, { env, fetchImpl }).catch((e) =>
      console.error('[Meetstream] evaluate failed', { err: e.message })));
    return { ok: true, event: ev };
  }
  if (ENDING_EVENTS.has(ev) || String(b.event) === 'bot.stopped') {
    await db.query(
      `UPDATE meeting_attendance SET bot_status = $2, bot_left_at = COALESCE(bot_left_at, now()), updated_at = now() WHERE id = $1`,
      [row.id, status]
    );
    const fresh = await getRow(row.id);
    const failed = ['bot.failed', 'bot.denied', 'bot.notallowed'].includes(ev);
    if (failed && !fresh.bot_joined_at) {
      await finish(fresh, { status: 'unverified', reason: `bot_${ev.replace('bot.', '')}` });
    } else {
      setImmediate(() => evaluateRow(fresh, { env, fetchImpl }).catch((e) =>
        console.error('[Meetstream] evaluate failed', { err: e.message })));
    }
    return { ok: true, event: ev };
  }
  if (status) {
    await db.query('UPDATE meeting_attendance SET bot_status = $2, updated_at = now() WHERE id = $1', [row.id, status]);
  }
  return { ok: true, event: ev || 'unknown' };
}

// ─── Tick ────────────────────────────────────────────────────────────────────

async function botsCreatedCount() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM meeting_attendance WHERE bot_created_at IS NOT NULL');
  return rows[0]?.n || 0;
}

async function createBotFor(row, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = config(env);
  const claim = await db.query(
    `UPDATE meeting_attendance SET status = 'creating', updated_at = now()
      WHERE id = $1 AND status = 'scheduled' RETURNING *`, [row.id]);
  if (!claim.rows[0]) return { skipped: 'already_claimed' };
  const claimed = claim.rows[0];
  const est = estimateCostUsd(cfg);
  try {
    const r = await api('POST', '/bots/create_bot', {
      body: createBotPayload(claimed, cfg, env),
      headers: { 'Idempotency-Key': claimed.id },
      env, fetchImpl,
    });
    const botId = r.json && r.json.bot_id;
    if ((r.status === 200 || r.status === 201 || r.status === 507) && botId) {
      await db.query(
        `UPDATE meeting_attendance SET status = 'bot_requested', bot_id = $2, bot_status = $3,
                bot_created_at = now(), est_cost_usd = $4, updated_at = now() WHERE id = $1`,
        [claimed.id, botId, r.json.status || 'Active', est]);
      await addEvent(claimed.id, { create_bot: r.status });
      return { created: true, botId };
    }
    const msg = `create_bot_http_${r.status}`;
    await db.query(`UPDATE meeting_attendance SET status = 'failed', reason = $2, updated_at = now() WHERE id = $1`, [claimed.id, msg]);
    await addEvent(claimed.id, { create_bot: r.status, detail: JSON.stringify(r.json || r.text || '').slice(0, 200) });
    return { failed: true, reason: msg };
  } catch (err) {
    await db.query(`UPDATE meeting_attendance SET status = 'failed', reason = 'create_bot_error', updated_at = now() WHERE id = $1`, [claimed.id]);
    await addEvent(claimed.id, { create_bot_error: String(err.message).slice(0, 100) });
    return { failed: true, reason: 'create_bot_error' };
  }
}

async function runAttendanceTick({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const out = { created: 0, evaluated: 0, decided: 0, expired: 0, capped: 0, hardStopped: 0 };
  if (!enabled(env)) return out;
  const cfg = config(env);
  const nowDate = new Date(now);

  // 0. Meetings parked only because of the scope setting come back when the scope is widened.
  const allowedScopes = ['josh', 'client'].filter((sc) => scopeAllows(sc, env));
  await db.query(
    `UPDATE meeting_attendance SET status = 'scheduled', reason = NULL, updated_at = now()
      WHERE status = 'skipped' AND reason LIKE 'scope\\_%' AND bot_id IS NULL AND scope = ANY($1)`,
    [allowedScopes]);
  // A client that was switched off and is switched back on (removed from MEETSTREAM_CLIENTS_OFF) comes back too.
  const { rows: offRows } = await db.query(
    `SELECT id, client_slug FROM meeting_attendance
      WHERE status = 'skipped' AND reason = 'client_off' AND bot_id IS NULL AND scope = 'client'
        AND starts_at > now() - interval '1 hour'`);
  for (const r of offRows) {
    if (!clientOff(r.client_slug, env) && scopeAllows('client', env)) {
      await db.query(`UPDATE meeting_attendance SET status = 'scheduled', reason = NULL, updated_at = now() WHERE id = $1`, [r.id]);
    }
  }

  // 1. Rows whose window passed without a bot.
  const exp = await db.query(
    `UPDATE meeting_attendance SET status = 'skipped', reason = 'missed_window', updated_at = now()
      WHERE status = 'scheduled' AND starts_at + ($2 || ' milliseconds')::interval < $1 RETURNING id`,
    [nowDate, String(cfg.noShowMs)]);
  out.expired = exp.rows.length;

  // 2. Send bots to meetings that start within the lead window (and are in scope, on Meet).
  const { rows: due } = await db.query(
    `SELECT * FROM meeting_attendance
      WHERE status = 'scheduled' AND platform = 'google_meet' AND meeting_url IS NOT NULL
        AND starts_at - ($2 || ' milliseconds')::interval <= $1
      ORDER BY starts_at LIMIT 5`,
    [nowDate, String(cfg.leadMs)]);
  for (const row of due) {
    if (!scopeAllows(row.scope, env)) continue;
    if (row.scope === 'client' && clientOff(row.client_slug, env)) {
      await db.query(`UPDATE meeting_attendance SET status = 'skipped', reason = 'client_off', updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [row.id]);
      continue;
    }
    if (!apiKey(env) || !webhookToken(env)) { out.capped += 1; continue; }
    if ((await botsCreatedCount()) >= cfg.maxBots) {
      await db.query(`UPDATE meeting_attendance SET status = 'skipped', reason = 'bot_cap_reached', updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [row.id]);
      out.capped += 1;
      continue;
    }
    const r = await createBotFor(row, { env, fetchImpl });
    if (r.created) out.created += 1;
  }

  // 3. Active bots: check participants, decide, and enforce a hard stop so nothing lingers (spend guard).
  const { rows: active } = await db.query(
    `SELECT * FROM meeting_attendance WHERE status = ANY($1) AND bot_id IS NOT NULL ORDER BY starts_at LIMIT 20`, [ACTIVE]);
  for (const row of active) {
    const hardStopAt = new Date(row.starts_at).getTime() + cfg.hardStopMs;
    if (now > hardStopAt) {
      await finish(row, { status: 'unverified', reason: 'hard_stop' });
      await removeBot(row, env, fetchImpl);
      out.hardStopped += 1;
      continue;
    }
    const r = await evaluateRow(row, { env, fetchImpl, now });
    out.evaluated += 1;
    if (r.decided) out.decided += 1;
  }
  return out;
}

/** Compact rows for the read endpoint. No names, no bot key. */
async function listAttendance(limit = 50) {
  const { rows } = await db.query(
    `SELECT id, source, booking_ref, scope, client_slug, platform, starts_at, status, reason, bot_id, bot_status,
            bot_created_at, bot_joined_at, bot_left_at, prospect_joined_at, decided_at, participants, events, est_cost_usd
       FROM meeting_attendance ORDER BY starts_at DESC LIMIT $1`,
    [Math.max(1, Math.min(200, parseInt(limit, 10) || 50))]);
  return rows;
}

module.exports = {
  BOT_NAME,
  enabled,
  scopeSetting,
  scopeAllows,
  clientOff,
  config,
  tokenOk,
  platformOf,
  estimateCostUsd,
  classifyParticipants,
  isInternal,
  decide,
  createBotPayload,
  registerBooking,
  registerFromBridgePayload,
  handleWebhook,
  evaluateRow,
  runAttendanceTick,
  listAttendance,
  removeBot,
};
