'use strict';

/**
 * Admin: reopen a reply card that was closed with Reject.
 *
 * Only rejected -> pending. One atomic statement changes the row and writes the audit row
 * (followup_card_events, event_type 'admin_status_change'), so there is never a change
 * without its audit. Nothing is sent to a lead, no follow-up nudges are restored, no
 * campaign / lead status is touched. `repaintCard` optionally redraws the existing Slack
 * message from its stored payload so the Approve / Edit buttons come back (chat.update only).
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

async function repaint(reply, { slackApi, loadCard }) {
  if (!reply.slack_message_ts || !reply.slack_channel_id) return 'no_slack_message';
  const { rows: [client] } = await db.query('SELECT slack_bot_token FROM clients WHERE id = $1', [reply.client_id]);
  if (!client || !client.slack_bot_token) return 'no_slack_token';
  const payload = await loadCard(reply.id);
  if (!payload) return 'no_stored_card';
  try {
    if (reply.draft_reply) await slackApi.updateDraftApprovalCard(client.slack_bot_token, reply.slack_channel_id, reply.slack_message_ts, payload);
    else await slackApi.updateAlertCard(client.slack_bot_token, reply.slack_channel_id, reply.slack_message_ts, payload);
    return 'repainted';
  } catch (err) {
    console.warn('[Admin] card repaint failed', { replyId: reply.id, err: err.message });
    return 'failed';
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

  const { rows: [cur] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [id]);
  if (!cur) return { status: 404, body: { ok: false, error: 'card_not_found' } };
  if (cur.status === 'pending') {
    return { status: 200, body: { ok: true, changed: false, status: 'pending', classification: cur.classification, note: 'already pending' } };
  }
  if (cur.status !== 'rejected') {
    return { status: 409, body: { ok: false, error: 'not_rejected', status: cur.status } };
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

  const warnings = [];
  const { rows: others } = await db.query(
    `SELECT count(*)::int AS n FROM pending_replies
      WHERE client_id = $1 AND id <> $2 AND status IN ('pending', 'flagged')
        AND lower(coalesce(lead_email, '')) = lower(coalesce($3, '#'))`,
    [cur.client_id, id, cur.lead_email],
  );
  if (others[0] && others[0].n) warnings.push('other_open_card_for_lead');

  let repainted = 'not_requested';
  if (input.repaintCard === true || input.repaintCard === 'true') {
    repainted = await repaint(
      { ...cur, status: 'pending' },
      { slackApi: slackApi || require('./slack'), loadCard: loadCard || require('./slack-reply-post').loadLatestCard },
    );
  }
  return {
    status: 200,
    body: {
      ok: true, changed: true, id, from: 'rejected', status: 'pending',
      classification: done.classification, auditId: done.audit_id, cardRepainted: repainted, warnings,
    },
  };
}

module.exports = { setCardStatus, normalizeTarget };
