'use strict';

/**
 * Admin: reopen a reply card that was closed with Reject.
 *
 * Only rejected -> pending. One atomic statement changes the row and writes the audit row
 * (followup_card_events, event_type 'admin_status_change'), so there is never a change
 * without its audit. Nothing is sent to a lead, no follow-up nudges are restored, no
 * campaign / lead status is touched. `repaintCard` optionally redraws the existing Slack
 * message from its stored payload so the Approve / Edit buttons come back (chat.update only).
 *
 * A card row with no Slack channel id (or no posted ts) can be pointed at its message with optional
 * slackChannel / slackTs in the body: they are backfilled onto the row only where the row has none,
 * and audited. With only the ts known the channel falls back to the follow-up channel for FOLLOW_UP
 * cards, then to the client's configured card channel.
 */
const db = require('../db');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE = ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION'];

function normalizeTarget(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (t === 'pending') return { status: 'pending', interested: false };
  if (t === 'interested') return { status: 'pending', interested: true };
  return null;
}

const CHANNEL_RE = /^[CGD][A-Z0-9]{8,}$/;
const TS_RE = /^\d{9,}\.\d{1,}$/;
const POSTED_TS = /^\d+\.\d+$/;

/**
 * Backfill slackChannel / slackTs onto a row that lacks them (never overwrites a value the row has).
 * Returns { reply, backfilled: string[], ignored: string[], error? }.
 */
async function backfillSlackRef(reply, input) {
  const chan = String(input.slackChannel || input.slack_channel || '').trim();
  const ts = String(input.slackTs || input.slack_ts || '').trim();
  if (!chan && !ts) return { reply, backfilled: [], ignored: [] };
  if (chan && !CHANNEL_RE.test(chan)) return { error: 'slackChannel must look like C0123456789' };
  if (ts && !TS_RE.test(ts)) return { error: 'slackTs must look like 1234567890.123456' };
  const backfilled = [];
  const ignored = [];
  const hasTs = POSTED_TS.test(String(reply.slack_message_ts || ''));
  const hasChan = Boolean(String(reply.slack_channel_id || '').trim());
  const newChan = chan && !hasChan ? chan : null;
  const newTs = ts && !hasTs ? ts : null;
  if (chan && hasChan) ignored.push('slackChannel');
  if (ts && hasTs) ignored.push('slackTs');
  if (newChan || newTs) {
    const { rows: [row] } = await db.query(
      `UPDATE pending_replies
          SET slack_channel_id = COALESCE($2, slack_channel_id),
              slack_message_ts = COALESCE($3, slack_message_ts),
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [reply.id, newChan, newTs],
    );
    if (newChan) backfilled.push('slackChannel');
    if (newTs) backfilled.push('slackTs');
    try {
      await db.query(
        `INSERT INTO followup_card_events (client_id, pending_reply_id, event_type, outcome, detail)
         VALUES ($1, $2, 'admin_slack_backfill', 'backfilled', $3::jsonb)`,
        [reply.client_id, reply.id, JSON.stringify({ fields: backfilled, actor: String(input.actor || 'admin_api').slice(0, 60) })],
      );
    } catch (err) {
      console.warn('[Admin] slack backfill audit failed', { replyId: reply.id, err: err.message });
    }
    return { reply: row || reply, backfilled, ignored };
  }
  return { reply, backfilled, ignored };
}

async function repaint(reply, { slackApi, loadCard }) {
  const { rows: [client] } = await db.query('SELECT slack_bot_token, slack_channel_id FROM clients WHERE id = $1', [reply.client_id]);
  if (!client || !client.slack_bot_token) return { result: 'no_slack_token' };
  const ts = String(reply.slack_message_ts || '').trim();
  if (!POSTED_TS.test(ts)) return { result: 'no_slack_message' };
  const isFollowUp = String(reply.classification || '').toUpperCase() === 'FOLLOW_UP';
  const fromRow = String(reply.slack_channel_id || '').trim();
  const fallbacks = [
    isFollowUp ? require('./follow-up-runner').followUpSlackChannelId() : '',
    String(client.slack_channel_id || '').trim(),
  ];
  const channel = fromRow || fallbacks.find(Boolean) || '';
  if (!channel) return { result: 'no_slack_channel' };
  const payload = await loadCard(reply.id);
  if (!payload) return { result: 'no_stored_card' };
  const card = { ...payload, replyId: reply.id, draft: payload.draft || reply.draft_reply || undefined };
  try {
    if (card.draft) await slackApi.updateDraftApprovalCard(client.slack_bot_token, channel, ts, card);
    else await slackApi.updateAlertCard(client.slack_bot_token, channel, ts, card);
    return { result: 'repainted', channel: fromRow ? 'row' : 'fallback' };
  } catch (err) {
    console.warn('[Admin] card repaint failed', { replyId: reply.id, err: err.message });
    return { result: 'failed', error: String(err.data && err.data.error || err.message).slice(0, 80) };
  }
}

/** @returns {Promise<{status:number, body:object}>} */
async function setCardStatus(id, input = {}, { slackApi, loadCard } = {}) {
  if (!UUID.test(String(id || ''))) return { status: 400, body: { ok: false, error: 'card id must be a uuid' } };
  const target = normalizeTarget(input.status);
  if (!target) {
    return { status: 400, body: { ok: false, error: "status must be 'pending' or 'interested' (only a rejected card can be reopened)" } };
  }
  const reason = String(input.reason || '').trim().slice(0, 200) || null;
  const actor = String(input.actor || 'admin_api').trim().slice(0, 60);

  let { rows: [cur] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [id]);
  if (!cur) return { status: 404, body: { ok: false, error: 'card_not_found' } };
  if (cur.status !== 'pending' && cur.status !== 'rejected') {
    return { status: 409, body: { ok: false, error: 'not_rejected', status: cur.status } };
  }
  const wantsRepaint = input.repaintCard === true || input.repaintCard === 'true';
  const refGiven = Boolean(input.slackChannel || input.slack_channel || input.slackTs || input.slack_ts);
  // Validate the Slack reference before anything changes.
  const ref = refGiven ? await backfillSlackRef(cur, { ...input, actor }) : { reply: cur, backfilled: [], ignored: [] };
  if (ref.error) return { status: 400, body: { ok: false, error: ref.error } };
  cur = ref.reply;
  const slackBackfill = refGiven ? { backfilled: ref.backfilled, ignored: ref.ignored } : undefined;

  const doRepaint = async () => {
    if (!wantsRepaint) return { result: 'not_requested' };
    return repaint(
      { ...cur, status: 'pending' },
      { slackApi: slackApi || require('./slack'), loadCard: loadCard || require('./slack-reply-post').loadLatestCard },
    );
  };

  if (cur.status === 'pending') {
    const rp = await doRepaint();
    return {
      status: 200,
      body: {
        ok: true, changed: false, status: 'pending', classification: cur.classification, note: 'already pending',
        cardRepainted: rp.result, ...(rp.error ? { repaintError: rp.error } : {}), ...(slackBackfill ? { slackBackfill } : {}),
      },
    };
  }

  const setClass = target.interested && !POSITIVE.includes(String(cur.classification || '').toUpperCase());
  const { rows: [done] } = await db.query(
    `WITH upd AS (
       UPDATE pending_replies
          SET status = 'pending',
              classification = CASE WHEN $2::boolean THEN 'INTERESTED' ELSE classification END,
              updated_at = now()
        WHERE id = $1 AND status = 'rejected'
        RETURNING id, client_id, classification
     ), aud AS (
       INSERT INTO followup_card_events (client_id, pending_reply_id, event_type, outcome, detail)
       SELECT client_id, id, 'admin_status_change', 'reopened',
              jsonb_build_object('from', 'rejected', 'to', 'pending', 'classification_from', $3::text,
                                 'classification_to', classification, 'actor', $4::text, 'reason', $5::text)
         FROM upd
       RETURNING id
     )
     SELECT upd.id, upd.classification, aud.id AS audit_id FROM upd JOIN aud ON true`,
    [id, setClass, cur.classification, actor, reason],
  );
  if (!done) {
    // Lost a race with another click: report whatever it is now.
    const { rows: [now] } = await db.query('SELECT status FROM pending_replies WHERE id = $1', [id]);
    return { status: 409, body: { ok: false, error: 'not_rejected', status: now && now.status } };
  }
  console.log('[Admin] card reopened', { replyId: id, classification: done.classification, actor });
  cur = { ...cur, classification: done.classification };

  const warnings = [];
  const { rows: others } = await db.query(
    `SELECT count(*)::int AS n FROM pending_replies
      WHERE client_id = $1 AND id <> $2 AND status IN ('pending', 'flagged')
        AND lower(coalesce(lead_email, '')) = lower(coalesce($3, '#'))`,
    [cur.client_id, id, cur.lead_email],
  );
  if (others[0] && others[0].n) warnings.push('other_open_card_for_lead');

  const rp = await doRepaint();
  return {
    status: 200,
    body: {
      ok: true, changed: true, id, from: 'rejected', status: 'pending',
      classification: done.classification, auditId: done.audit_id, cardRepainted: rp.result,
      ...(rp.error ? { repaintError: rp.error } : {}), ...(slackBackfill ? { slackBackfill } : {}), warnings,
    },
  };
}

module.exports = { setCardStatus, normalizeTarget };
