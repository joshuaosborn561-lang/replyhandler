'use strict';

/**
 * Admin DQ: the same thing the Slack "DQ" button does (handleDisqualify in
 * routes/slack.js), reachable without a Slack click.
 *
 *  - records the prospect in disqualified_prospects (markDisqualified)
 *  - marks the reply row, and any other open card for the same thread, 'disqualified'
 *  - stops the follow-up card sequence and retires its unsent cards
 *  - cancels pending outbound follow-up nudges and blocks future ones
 *  - closes the reply's Slack card the way the button does (best effort)
 *
 * Nothing is sent to a lead.
 */
const db = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['pending', 'alert_only', 'flagged'];

function cleanNote(note) {
  const s = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return s ? `admin_dq: ${s}` : 'admin_dq';
}

/** Resolve the reply row to DQ from a reply id, or from client + lead email / LinkedIn URL. */
async function findReply({ replyId, clientId, leadEmail, linkedinUrl }, dbClient = db) {
  if (replyId) {
    const { rows: [row] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
    return row || null;
  }
  const email = String(leadEmail || '').trim().toLowerCase();
  const li = String(linkedinUrl || '').trim();
  const { rows: [row] } = await dbClient.query(
    `SELECT * FROM pending_replies
      WHERE client_id = $1
        AND (($2::text <> '' AND lower(coalesce(lead_email, '')) = $2)
          OR ($3::text <> '' AND linkedin_url = $3))
      ORDER BY (upper(classification) <> 'FOLLOW_UP') DESC, created_at DESC
      LIMIT 1`,
    [clientId, email, li],
  );
  return row || null;
}

/**
 * @returns {Promise<{http: number, body: object}>}
 */
async function disqualifyFromAdmin(input = {}, deps = {}) {
  const dbClient = deps.db || db;
  const { replyId, clientId, leadEmail, linkedinUrl, note, dryRun = false } = input;

  if (replyId && !UUID_RE.test(String(replyId))) {
    return { http: 400, body: { error: 'replyId must be a pending_replies uuid' } };
  }
  if (!replyId && !(clientId && (leadEmail || linkedinUrl))) {
    return { http: 400, body: { error: 'pass replyId, or clientId with leadEmail or linkedinUrl' } };
  }
  if (!replyId && !UUID_RE.test(String(clientId))) {
    return { http: 400, body: { error: 'clientId must be a clients uuid' } };
  }

  const reply = await findReply({ replyId, clientId, leadEmail, linkedinUrl }, dbClient);
  if (!reply) return { http: 404, body: { error: 'no reply found for that lead' } };

  const { rows: [rawClient] } = await dbClient.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  if (!rawClient) return { http: 404, body: { error: 'client not found' } };
  const { withSmartleadKey } = require('./campaign-routing');
  const client = (deps.withSmartleadKey || withSmartleadKey)(rawClient);

  const { isDisqualified, threadKeys, markDisqualified } = deps.dq || require('./disqualified-prospects');
  const alreadyBefore = await isDisqualified(client.id, threadKeys(reply));
  const wasOpen = OPEN_STATUSES.includes(reply.status);

  const summary = {
    replyId: reply.id,
    client: client.name,
    leadName: reply.lead_name || null,
    leadEmail: reply.lead_email || null,
    previousStatus: reply.status,
    alreadyDisqualified: alreadyBefore,
  };
  if (dryRun) return { http: 200, body: { ok: true, dryRun: true, wouldRecordDq: !alreadyBefore, ...summary } };

  const result = await markDisqualified({
    clientId: client.id,
    reply,
    reason: cleanNote(note),
    slackUserId: null,
  });
  const cancelled = result.cancelledFollowUps || 0;

  // Close the Slack card like the button does. Best effort: the DQ is already recorded.
  let cardUpdated = false;
  let cardError = null;
  const { isPostedSlackTs } = deps.isPostedSlackTs ? { isPostedSlackTs: deps.isPostedSlackTs } : require('./reply-dedupe');
  if (wasOpen && isPostedSlackTs(reply.slack_message_ts) && client.slack_bot_token) {
    try {
      const slackService = deps.slackService || require('./slack');
      const helpers = deps.cardHelpers || require('../routes/slack').cardHelpers;
      const { followUpSlackChannelId } = require('./follow-up-runner');
      const channel = String(reply.classification || '').toUpperCase() === 'FOLLOW_UP'
        ? followUpSlackChannelId()
        : client.slack_channel_id;
      const ctx = await helpers.slackCardContextFromReply(reply, client);
      await slackService.updateSentConfirmationCard(
        client.slack_bot_token, channel, reply.slack_message_ts,
        helpers.sentCardPayload(reply, ctx, {
          sentReply: null,
          actionKind: 'disqualified',
          userId: undefined,
          extraFooter: `${cancelled > 0
            ? `Cancelled ${cancelled} pending follow-up nudge${cancelled === 1 ? '' : 's'}.`
            : 'No pending follow-up nudges. Future nudges blocked.'} Disqualified via admin API.`,
        }),
      );
      cardUpdated = true;
    } catch (err) {
      cardError = String(err.message || err).slice(0, 160);
      console.warn('[AdminDQ] could not update Slack card', { replyId: reply.id, err: cardError });
    }
  }

  console.log('[AdminDQ] Prospect disqualified', { replyId: reply.id, already: result.already, cancelledFollowUps: cancelled, cardUpdated });
  return {
    http: 200,
    body: {
      ok: true,
      ...summary,
      alreadyDisqualified: Boolean(result.already),
      cancelledFollowUps: cancelled,
      cardUpdated,
      ...(cardError ? { cardError } : {}),
    },
  };
}

module.exports = { disqualifyFromAdmin, findReply, cleanNote };
