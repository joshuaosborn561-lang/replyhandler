/**
 * Missed inbound call -> Slack @-mention.
 *
 * When someone calls one of our Allo lines and nobody picks up, find which
 * line / person was called and @-mention them in Slack:
 *   "You missed a call from <number> at <time> CT. Can you call them back?"
 * Text only: no buttons, no "I called them" card.
 *
 * Who was called: the Allo user on the call (user_email), else the owner of
 * the line (MISSED_CALL_LINE_OWNERS). Slack user: MISSED_CALL_SLACK_USERS map,
 * else Slack users.lookupByEmail. If no person can be resolved the alert still
 * posts, naming the line, so the call is never silently dropped.
 *
 * Env (off unless MISSED_CALL_ALERTS=true):
 *   MISSED_CALL_SLACK_CHANNEL_ID  default: follow-ups channel
 *   MISSED_CALL_SLACK_TOKEN       default: SLACK_BOT_TOKEN, else an active client's bot token
 *   MISSED_CALL_LINE_OWNERS       "+15551234567=cayden@x.com,+1555...=josh@x.com"
 *   MISSED_CALL_SLACK_USERS       "cayden@x.com=U123,+15551234567=U456"
 *   MISSED_CALL_LOOKBACK_MINUTES  default 30
 */
const db = require('../db');
const allo = require('./allo');

const MISSED_RESULTS = new Set([
  'VOICEMAIL', 'NO_ANSWER', 'NOANSWER', 'UNANSWERED', 'MISSED', 'BUSY', 'FAILED', 'CANCELED', 'CANCELLED',
]);

function enabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.MISSED_CALL_ALERTS || '').trim());
}

function lookbackMinutes(env = process.env) {
  const n = parseInt(env.MISSED_CALL_LOOKBACK_MINUTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** "a=b,c=d" -> Map(lowercased/normalised key -> value). Phone keys use last 10 digits. */
function parsePairs(raw) {
  const out = new Map();
  for (const part of String(raw || '').split(/[,;\n]+/)) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && v) out.set(keyOf(k), v);
  }
  return out;
}

function keyOf(k) {
  const s = String(k || '').trim().toLowerCase();
  if (s.includes('@')) return s;
  return allo.phoneKey(s) || s;
}

function isMissedInbound(call) {
  if (String(call?.type || '').toUpperCase() !== 'INBOUND') return false;
  const result = String(call?.result || '').toUpperCase().replace(/[\s-]/g, '_');
  return MISSED_RESULTS.has(result);
}

function candidateCalls(calls, { now = Date.now(), env = process.env } = {}) {
  const since = now - lookbackMinutes(env) * 60000;
  return (calls || []).filter((c) => {
    if (!isMissedInbound(c)) return false;
    const t = new Date(c?.start_date || 0).getTime();
    return Number.isFinite(t) && t >= since && t <= now + 60000;
  });
}

function callerNumber(call) {
  return call?.from_number || call?.from || call?.contact_number || call?.external_number || '';
}

function formatPhone(raw) {
  const k = allo.phoneKey(raw);
  if (!k) return String(raw || 'an unknown number');
  return `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}`;
}

function formatTimeCt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an unknown time';
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** Who on our side was called: { email, line }. */
function calledPerson(call, env = process.env) {
  const line = call?.allo_number || call?.to_number || '';
  const owners = parsePairs(env.MISSED_CALL_LINE_OWNERS);
  const email = String(call?.user_email || owners.get(keyOf(line)) || '').trim().toLowerCase();
  return { email, line };
}

async function resolveSlackUserId({ email, line }, slackApi, env = process.env) {
  const map = parsePairs(env.MISSED_CALL_SLACK_USERS);
  const direct = (email && map.get(keyOf(email))) || (line && map.get(keyOf(line)));
  if (direct) return direct;
  if (email && slackApi) {
    try {
      const r = await slackApi.users.lookupByEmail({ email });
      if (r?.user?.id) return r.user.id;
    } catch (err) {
      console.warn('[MissedCall] Slack lookupByEmail failed', { err: err.data?.error || err.message });
    }
  }
  return null;
}

function alertText({ slackUserId, line, number, at }) {
  const who = slackUserId ? `<@${slackUserId}>` : `Line ${formatPhone(line)}`;
  return `${who} You missed a call from ${formatPhone(number)} at ${formatTimeCt(at)} CT. Can you call them back?`;
}

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = db.query(`
      CREATE TABLE IF NOT EXISTS missed_call_alerts (
        allo_call_id TEXT PRIMARY KEY,
        status TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`).catch((err) => { tableReady = null; throw err; });
  }
  return tableReady;
}

async function claimCall(callId) {
  await ensureTable();
  const { rows } = await db.query(
    `INSERT INTO missed_call_alerts (allo_call_id, status) VALUES ($1, 'claimed')
     ON CONFLICT (allo_call_id) DO NOTHING RETURNING allo_call_id`,
    [String(callId)],
  );
  return rows.length > 0;
}

async function markCall(callId, status) {
  await db.query('UPDATE missed_call_alerts SET status = $2 WHERE allo_call_id = $1', [String(callId), status]).catch(() => {});
}

async function slackToken(env = process.env) {
  const t = String(env.MISSED_CALL_SLACK_TOKEN || env.SLACK_BOT_TOKEN || '').trim();
  if (t) return t;
  const { rows: [r] } = await db.query(
    "SELECT slack_bot_token FROM clients WHERE active IS NOT FALSE AND COALESCE(slack_bot_token, '') <> '' ORDER BY created_at LIMIT 1",
  );
  return r?.slack_bot_token || '';
}

function channelId(env = process.env) {
  const c = String(env.MISSED_CALL_SLACK_CHANNEL_ID || '').trim();
  return c || require('./follow-up-runner').followUpSlackChannelId();
}

/** Cron entry. Returns counts for logs. */
async function runMissedCallAlerts({ now = Date.now(), slackApi, env = process.env } = {}) {
  const counts = { calls: 0, missed: 0, alerted: 0 };
  if (!enabled(env) || !allo.isConfigured()) return counts;
  const numbers = await allo.alloNumbers();
  const calls = [];
  for (const n of numbers) {
    try { calls.push(...await allo.listRecentCalls(n)); } catch (err) {
      console.warn('[MissedCall] Allo list failed', { err: err.message });
    }
  }
  counts.calls = calls.length;
  const cands = candidateCalls(calls, { now, env });
  counts.missed = cands.length;
  if (!cands.length) return counts;

  let api = slackApi;
  if (!api) {
    const token = await slackToken(env);
    if (!token) { console.warn('[MissedCall] No Slack token'); return counts; }
    const { WebClient } = require('@slack/web-api');
    api = new WebClient(token);
  }
  const channel = channelId(env);

  for (const call of cands) {
    if (!(await claimCall(call.id))) continue;
    try {
      const person = calledPerson(call, env);
      const slackUserId = await resolveSlackUserId(person, api, env);
      const text = alertText({ slackUserId, line: person.line, number: callerNumber(call), at: call.start_date });
      await api.chat.postMessage({ channel, text, unfurl_links: false });
      await markCall(call.id, slackUserId ? 'alerted' : 'alerted_no_user');
      counts.alerted += 1;
    } catch (err) {
      await markCall(call.id, 'error');
      console.warn('[MissedCall] Alert failed', { callId: call.id, err: err.data?.error || err.message });
    }
  }
  return counts;
}

module.exports = {
  runMissedCallAlerts, isMissedInbound, candidateCalls, calledPerson, resolveSlackUserId, alertText, enabled,
};
