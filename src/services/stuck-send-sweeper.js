/**
 * Rows left in approved or sending (process died, Slack update failed)
 * are finished without a second provider send when we already delivered,
 * retried once when approve never reached the provider, or marked failed
 * with a Retry button when a send was claimed and did not finish.
 */

const db = require('../db');
const slackService = require('./slack');
const { isSendInFlight } = require('./send-inflight');
const { alreadySentSameOutbound, STALE_SENDING_MS } = require('./reply-dedupe');

const APPROVED_STUCK_MS = 2 * 60 * 1000;

function ageMs(row, now) {
  const t = new Date(row?.updated_at || 0).getTime();
  if (!Number.isFinite(t)) return 0;
  return now - t;
}

async function defaultAlreadySent(row) {
  if (row?.sent_reply && String(row.sent_reply).trim()) return true;
  return alreadySentSameOutbound({
    clientId: row.client_id,
    platform: row.platform,
    leadId: row.lead_id,
    leadEmail: row.lead_email,
    replyText: row.draft_reply || row.sent_reply,
    exceptReplyId: row.id,
  });
}

async function paintTerminalCard(row, actionKind, extraFooter, deps) {
  const query = deps.query || ((sql, params) => db.query(sql, params));
  const ts = String(row.slack_message_ts || '');
  if (!/^\d+\.\d+$/.test(ts)) return;
  const { rows: [client] } = await query('SELECT * FROM clients WHERE id = $1', [row.client_id]);
  const token = client?.slack_bot_token;
  const channelId = row.slack_channel_id || client?.slack_channel_id;
  if (!token || !channelId) return;
  const helpers = deps.cardHelpers || require('../routes/slack').cardHelpers;
  const ctx = deps.cardContext
    ? await deps.cardContext(row, client)
    : await helpers.slackCardContextFromReply(row, client);
  const update = deps.updateCard || slackService.updateSentConfirmationCard;
  await update(
    token,
    channelId,
    ts,
    helpers.sentCardPayload(row, ctx, {
      sentReply: actionKind === 'failed' ? (row.draft_reply || null) : (row.sent_reply || row.draft_reply || null),
      actionKind,
      userId: null,
      extraFooter,
      replyId: row.id,
    })
  );
}

async function markSent(row, deps) {
  const query = deps.query || ((sql, params) => db.query(sql, params));
  const text = row.sent_reply || row.draft_reply || null;
  const { rowCount } = await query(
    `UPDATE pending_replies
        SET status = 'sent',
            sent_reply = COALESCE(sent_reply, $2),
            send_error = NULL,
            updated_at = now()
      WHERE id = $1
        AND status IN ('approved', 'sending')`,
    [row.id, text]
  );
  if (!rowCount) return false;
  try {
    await paintTerminalCard({ ...row, sent_reply: text, status: 'sent' }, 'approved', 'Already sent — no second send.', deps);
  } catch (err) {
    console.warn('[StuckSend] Sent card update failed', { replyId: row.id, err: err.message });
  }
  return true;
}

async function markFailed(row, message, deps) {
  const query = deps.query || ((sql, params) => db.query(sql, params));
  const note = String(message || 'Send did not finish. Use Retry. Nothing was sent again.').slice(0, 500);
  const { rowCount } = await query(
    `UPDATE pending_replies
        SET status = 'failed',
            send_error = $2,
            updated_at = now()
      WHERE id = $1
        AND status IN ('approved', 'sending')`,
    [row.id, note]
  );
  if (!rowCount) return false;
  try {
    await paintTerminalCard({ ...row, status: 'failed' }, 'failed', note, deps);
  } catch (err) {
    console.warn('[StuckSend] Failed card update failed', { replyId: row.id, err: err.message });
  }
  return true;
}

async function defaultRetry(row) {
  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [row.client_id]);
  if (!client) {
    const err = new Error('client missing');
    err.noSend = true;
    throw err;
  }
  const { withSmartleadKey } = require('./campaign-routing');
  const { sendReplyToPlatform } = require('./reply-send');
  return sendReplyToPlatform(withSmartleadKey(client), row, row.draft_reply);
}

/**
 * @returns {Promise<{ retried: number, failed: number, markedSent: number, skipped: number }>}
 */
async function sweepStuckSends(deps = {}) {
  const query = deps.query || ((sql, params) => db.query(sql, params));
  const now = deps.now == null ? Date.now() : deps.now;
  const approvedStuckMs = deps.approvedStuckMs == null ? APPROVED_STUCK_MS : deps.approvedStuckMs;
  const sendingStuckMs = deps.sendingStuckMs == null ? STALE_SENDING_MS : deps.sendingStuckMs;
  const inFlight = deps.isInFlight || isSendInFlight;
  const alreadySent = deps.alreadySent || defaultAlreadySent;
  const retrySend = deps.retrySend || defaultRetry;
  const out = { retried: 0, failed: 0, markedSent: 0, skipped: 0 };

  const { rows } = await query(
    `SELECT *
       FROM pending_replies
      WHERE status IN ('approved', 'sending')
      ORDER BY updated_at ASC
      LIMIT 50`
  );

  for (const row of rows) {
    if (inFlight(row.id)) {
      out.skipped += 1;
      continue;
    }
    const age = ageMs(row, now);
    const limit = row.status === 'sending' ? sendingStuckMs : approvedStuckMs;
    if (age < limit) {
      out.skipped += 1;
      continue;
    }

    let sent = false;
    try {
      sent = Boolean(row.sent_reply && String(row.sent_reply).trim()) || await alreadySent(row);
    } catch (err) {
      console.warn('[StuckSend] already-sent check failed', { replyId: row.id, err: err.message });
      sent = false;
    }
    if (sent) {
      const marked = await markSent(row, { ...deps, query });
      if (marked) out.markedSent += 1;
      else out.skipped += 1;
      continue;
    }

    // A sending row may already have reached the provider. Do not send again.
    if (row.status === 'sending') {
      const marked = await markFailed(
        row,
        'Send did not finish. Use Retry. Nothing was sent again.',
        { ...deps, query }
      );
      if (marked) out.failed += 1;
      else out.skipped += 1;
      continue;
    }

    try {
      const result = await retrySend(row);
      if (result && result.skippedDuplicate) {
        if (result.reason === 'already_actioned' || result.reason === 'same_inbound' || result.reason === 'same_text') {
          const marked = await markSent(row, { ...deps, query });
          if (marked) out.markedSent += 1;
          else out.skipped += 1;
        } else {
          out.skipped += 1;
        }
        continue;
      }
      await query(
        `UPDATE pending_replies
            SET status = 'sent',
                sent_reply = COALESCE(sent_reply, $2),
                send_error = NULL,
                updated_at = now()
          WHERE id = $1
            AND status IN ('approved', 'sending')`,
        [row.id, row.draft_reply || null]
      );
      try {
        await paintTerminalCard(
          { ...row, status: 'sent', sent_reply: row.draft_reply },
          'approved',
          null,
          { ...deps, query }
        );
      } catch (err) {
        console.warn('[StuckSend] Retry card update failed', { replyId: row.id, err: err.message });
      }
      out.retried += 1;
    } catch (err) {
      const marked = await markFailed(row, err.message || 'Send failed', { ...deps, query });
      if (marked) out.failed += 1;
      else out.skipped += 1;
    }
  }

  if (out.retried || out.failed || out.markedSent) {
    console.log('[StuckSend] Sweep', out);
  }
  return out;
}

module.exports = {
  APPROVED_STUCK_MS,
  sweepStuckSends,
  ageMs,
};
