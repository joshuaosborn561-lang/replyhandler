/**
 * Missed call -> follow-up draft card.
 *
 * When the caller (Cayden by default) dials a positive-reply lead from Allo and
 * the call does not connect, prepare a follow-up email draft card right away,
 * the same way the regular follow-up runner does (same drafter, same
 * follow-ups channel, same Approve button). Nothing auto-sends.
 *
 * "Did not connect" = Allo result is voicemail / no answer / busy / failed, or
 * the Jev label on the call (Supabase call_tag_review) is voicemail,
 * hung_up_or_no_response or call_screener. A Jev conversation label wins over
 * Allo's ANSWERED/VOICEMAIL either way.
 *
 * Off unless MISSED_CALL_FOLLOWUPS=true.
 */
const db = require('../db');
const allo = require('./allo');

const MISSED_RESULTS = new Set([
  'VOICEMAIL', 'NO_ANSWER', 'NOANSWER', 'UNANSWERED', 'MISSED', 'BUSY', 'FAILED', 'CANCELED', 'CANCELLED',
]);
const MISSED_JEV = new Set(['voicemail', 'hung_up_or_no_response', 'call_screener']);
const CONNECTED_JEV = new Set([
  'interested', 'not_interested', 'meeting_booked', 'callback_requested', 'conversation_other',
  'different_number_given', 'wrong_person', 'gatekeeper', 'do_not_call', 'wrong_number',
]);
const POSITIVE = ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION'];

function enabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.MISSED_CALL_FOLLOWUPS || '').trim());
}

function callerEmails(env = process.env) {
  return String(env.MISSED_CALL_CALLER_EMAILS || 'cayden@salesglidergrowth.com')
    .split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function lookbackMinutes(env = process.env) {
  const n = parseInt(env.MISSED_CALL_LOOKBACK_MINUTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** 'missed' | 'connected' | null (unknown yet). */
function callOutcome(call, jevLabel) {
  const label = String(jevLabel || '').toLowerCase();
  if (MISSED_JEV.has(label)) return 'missed';
  if (CONNECTED_JEV.has(label)) return 'connected';
  const result = String(call?.result || '').toUpperCase().replace(/[\s-]/g, '_');
  if (MISSED_RESULTS.has(result)) return 'missed';
  if (result === 'ANSWERED' || result === 'COMPLETED') return 'connected';
  return null;
}

/** Outbound calls by the caller within the lookback window. */
function candidateCalls(calls, { now = Date.now(), env = process.env } = {}) {
  const who = new Set(callerEmails(env));
  const since = now - lookbackMinutes(env) * 60000;
  return (calls || []).filter((c) => {
    if (String(c?.type || '').toUpperCase() !== 'OUTBOUND') return false;
    if (who.size && !who.has(String(c?.user_email || '').toLowerCase())) return false;
    const t = new Date(c?.start_date || 0).getTime();
    return Number.isFinite(t) && t >= since && t <= now + 60000;
  });
}

async function jevLabels(callIds) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !callIds.length) return new Map();
  const list = callIds.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
  try {
    const res = await fetch(`${url}/rest/v1/call_tag_review?select=call_id,jev_label&call_id=in.(${encodeURIComponent(list)})`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    return new Map((rows || []).map((r) => [String(r.call_id), r.jev_label]));
  } catch (err) {
    console.warn('[MissedCall] Jev label lookup failed', { err: err.message });
    return new Map();
  }
}

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = db.query(`
      CREATE TABLE IF NOT EXISTS missed_call_cards (
        allo_call_id TEXT PRIMARY KEY,
        reply_id UUID,
        follow_up_id UUID,
        status TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`).catch((err) => { tableReady = null; throw err; });
  }
  return tableReady;
}

/** Latest positive reply whose enriched phone matches the dialled number. */
async function findReplyForNumber(number) {
  const key = allo.phoneKey(number);
  if (!key) return null;
  const { rows: [r] } = await db.query(
    `SELECT * FROM pending_replies
      WHERE classification = ANY($2::text[])
        AND created_at > now() - interval '45 days'
        AND (right(regexp_replace(COALESCE(lead_phone, ''), '\\D', '', 'g'), 10) = $1
          OR right(regexp_replace(COALESCE(lead_phone_alt, ''), '\\D', '', 'g'), 10) = $1)
      ORDER BY created_at DESC LIMIT 1`,
    [key, POSITIVE],
  );
  return r || null;
}

async function claimCall(callId, replyId) {
  await ensureTable();
  const { rows } = await db.query(
    `INSERT INTO missed_call_cards (allo_call_id, reply_id, status)
     VALUES ($1, $2, 'claimed') ON CONFLICT (allo_call_id) DO NOTHING RETURNING allo_call_id`,
    [String(callId), replyId || null],
  );
  return rows.length > 0;
}

/** One missed-call card per lead per 12h, however many times they were dialled. */
async function recentCardForReply(replyId) {
  const { rows } = await db.query(
    `SELECT 1 FROM missed_call_cards
      WHERE reply_id = $1 AND status = 'carded' AND created_at > now() - interval '12 hours' LIMIT 1`,
    [replyId],
  );
  return rows.length > 0;
}

async function markCall(callId, status, followUpId = null) {
  await db.query(
    'UPDATE missed_call_cards SET status = $2, follow_up_id = COALESCE($3, follow_up_id) WHERE allo_call_id = $1',
    [String(callId), status, followUpId],
  ).catch(() => {});
}

async function cardForMissedCall(call, reply, { postCard } = {}) {
  const post = postCard || require('./follow-up-runner').postFollowUpCard;
  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  if (!client) return { status: 'no_client' };
  const { rows: [fu] } = await db.query(
    `INSERT INTO outbound_follow_ups
       (client_id, platform, campaign_id, lead_id, conversation_id, lead_name, lead_email, linkedin_url,
        source_pending_reply_id, sent_at, due_at, status, step)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now() + interval '1 hour', 'pending', 0)
     RETURNING *`,
    [
      reply.client_id, reply.platform, reply.campaign_id, reply.lead_id, `missed_call:${call.id}`,
      reply.lead_name, reply.lead_email, reply.linkedin_url, reply.id,
    ],
  );
  const voicemail = String(call.result || '').toUpperCase() === 'VOICEMAIL';
  let card;
  try {
    card = await post(client, fu, {
    reasoningExtra: `📞 Missed call just now (${voicemail ? 'voicemail' : 'no answer'}). Follow-up email drafted.`,
    extraThreadMessages: [{
      role: 'us',
      body: `(Phone call just now: we called and could not reach them${voicemail ? '; went to voicemail' : ''}. This email follows up on that missed call.)`,
    }],
    });
  } catch (err) {
    // Never leave the row pending for the regular runner to post without the call context.
    await db.query(
      `UPDATE outbound_follow_ups SET status = 'skipped', skip_reason = $2, updated_at = now() WHERE id = $1`,
      [fu.id, `missed_call:${err.code || 'failed'}`],
    ).catch(() => {});
    throw err;
  }
  return { status: card ? 'carded' : 'skipped', followUpId: fu.id };
}

/** Cron entry. Returns counts for logs. */
async function runMissedCallFollowUps({ now = Date.now(), postCard } = {}) {
  const counts = { calls: 0, missed: 0, matched: 0, carded: 0 };
  if (!enabled() || !allo.isConfigured()) return counts;
  const numbers = await allo.alloNumbers();
  const calls = [];
  for (const n of numbers) {
    try { calls.push(...await allo.listRecentCalls(n)); } catch (err) {
      console.warn('[MissedCall] Allo list failed', { err: err.message });
    }
  }
  const cands = candidateCalls(calls, { now });
  counts.calls = cands.length;
  if (!cands.length) return counts;
  const labels = await jevLabels(cands.map((c) => c.id));
  for (const call of cands) {
    if (callOutcome(call, labels.get(String(call.id))) !== 'missed') continue;
    counts.missed += 1;
    const reply = await findReplyForNumber(call.to_number);
    if (!reply) continue;
    counts.matched += 1;
    if (!(await claimCall(call.id, reply.id))) continue;
    if (await recentCardForReply(reply.id)) { await markCall(call.id, 'dup_12h'); continue; }
    try {
      const out = await cardForMissedCall(call, reply, { postCard });
      await markCall(call.id, out.status, out.followUpId);
      if (out.status === 'carded') counts.carded += 1;
    } catch (err) {
      await markCall(call.id, `error:${err.code || 'failed'}`);
      console.warn('[MissedCall] Card failed', { callId: call.id, replyId: reply.id, err: err.message });
    }
  }
  return counts;
}

module.exports = {
  runMissedCallFollowUps, callOutcome, candidateCalls, enabled, callerEmails,
};
