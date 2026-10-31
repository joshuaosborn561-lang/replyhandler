'use strict';

/**
 * Click and outcome log for follow-up cards. The history modal reads this
 * plus the sequence steps, so a card posted before the table existed still
 * shows its outcome.
 */

const db = require('../db');

function stamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

const OUTCOME_WORDS = {
  booked: 'Booked',
  no_answer: 'No answer / Left VM',
  not_interested: 'Not interested',
  call_back: 'Call back',
  wrong_number: 'Wrong number',
  dq: 'DQ',
  snoozed: 'Snoozed',
  call_instead: 'Call instead',
  superseded: 'Superseded by a newer card',
};

function eventLine(row) {
  const when = stamp(row.created_at);
  const who = row.slack_user_id ? ` · <@${row.slack_user_id}>` : '';
  const kind = row.kind ? String(row.kind).replace(/_/g, ' ') : '';
  if (row.event_type === 'posted') {
    return `${when} · Card posted${kind ? ` (${kind})` : ''}`;
  }
  if (row.event_type === 'supersede' || row.outcome === 'superseded') {
    return `${when} · Superseded by a newer card`;
  }
  if (row.outcome === 'snoozed' || row.event_type === 'snooze') {
    let until = '';
    const detail = row.detail && typeof row.detail === 'object' ? row.detail : {};
    if (detail.until) until = ` until ${stamp(detail.until)}`;
    return `${when} · Snoozed${until}${who}`;
  }
  const word = OUTCOME_WORDS[row.outcome] || (row.outcome ? String(row.outcome).replace(/_/g, ' ') : '');
  if (word) return `${when} · ${word}${who}`;
  if (row.action_id) return `${when} · ${row.action_id}${who}`;
  return `${when} · ${row.event_type || 'event'}${who}`;
}

function stepLine(step) {
  const when = stamp(step.outcome_at || step.posted_at);
  if (!when && !step.outcome && step.status !== 'posted') return '';
  const kind = step.kind ? String(step.kind).replace(/_/g, ' ') : 'card';
  if (step.outcome) {
    const word = OUTCOME_WORDS[step.outcome] || String(step.outcome).replace(/_/g, ' ');
    const who = step.outcome_by ? ` · <@${step.outcome_by}>` : '';
    return `${when} · ${word}${who}`;
  }
  if (step.posted_at) return `${stamp(step.posted_at)} · Card posted (${kind})`;
  return '';
}

async function recordCardEvent(row, dbClient = db) {
  if (!row || !row.eventType) return;
  try {
    await dbClient.query(
      `INSERT INTO followup_card_events
         (client_id, sequence_id, step_id, pending_reply_id, lead_key,
          event_type, action_id, outcome, slack_user_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        row.clientId || null,
        row.sequenceId || null,
        row.stepId || null,
        row.pendingReplyId || null,
        row.leadKey || null,
        row.eventType,
        row.actionId || null,
        row.outcome || null,
        row.slackUserId || null,
        JSON.stringify(row.detail || {}),
      ],
    );
  } catch (err) {
    if (err && (err.code === '42P01' || /followup_card_events/.test(err.message || ''))) return;
    console.warn('[FollowupCard] event not stored', { err: err.message });
  }
}

/**
 * Timeline lines for the history modal. No lead names.
 * `reply` is the row the button opened (a follow-up row or the source reply).
 */
async function historyLinesForReply(reply, dbClient = db) {
  if (!reply || !reply.id) return [];
  const sourceId = reply.follow_up_source_id || null;
  let events = [];
  try {
    const { rows } = await dbClient.query(
      `SELECT e.created_at, e.event_type, e.action_id, e.outcome, e.slack_user_id, e.detail, st.kind
         FROM followup_card_events e
         LEFT JOIN followup_sequence_steps st ON st.id = e.step_id
         LEFT JOIN followup_sequences s ON s.id = COALESCE(e.sequence_id, st.sequence_id)
        WHERE e.pending_reply_id = $1
           OR s.source_reply_id = $1
           OR ($2::uuid IS NOT NULL AND s.source_reply_id = $2)
           OR e.step_id IN (
             SELECT id FROM followup_sequence_steps WHERE pending_reply_id = $1
           )
        ORDER BY e.created_at ASC
        LIMIT 40`,
      [reply.id, sourceId],
    );
    events = rows;
  } catch (err) {
    if (!(err && (err.code === '42P01' || /followup_card_events/.test(err.message || '')))) {
      console.warn('[FollowupCard] history read failed', { err: err.message });
    }
  }

  let steps = [];
  try {
    const { rows } = await dbClient.query(
      `SELECT st.kind, st.status, st.outcome, st.outcome_by, st.outcome_at, st.posted_at
         FROM followup_sequence_steps st
         JOIN followup_sequences s ON s.id = st.sequence_id
        WHERE s.source_reply_id = $1
           OR ($2::uuid IS NOT NULL AND s.source_reply_id = $2)
           OR st.pending_reply_id = $1
        ORDER BY st.posted_at NULLS LAST, st.seq_order ASC
        LIMIT 40`,
      [reply.id, sourceId],
    );
    steps = rows;
  } catch (err) {
    console.warn('[FollowupCard] step history read failed', { err: err.message });
  }

  const lines = [];
  const seen = new Set();
  const push = (line) => {
    const t = String(line || '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    lines.push(t);
  };
  if (!events.length) {
    for (const step of steps) push(stepLine(step));
  } else {
    for (const ev of events) push(eventLine(ev));
    for (const step of steps) {
      if (step.outcome && !events.some((e) => e.outcome === step.outcome && e.kind === step.kind)) {
        push(stepLine(step));
      }
    }
  }
  return lines.slice(0, 30);
}

module.exports = {
  recordCardEvent,
  historyLinesForReply,
  eventLine,
  stepLine,
  OUTCOME_WORDS,
};
