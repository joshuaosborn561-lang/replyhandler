/**
 * One card for Marbella Porcayo's 10:32 AM ET reply, posted once on startup.
 *
 * The webhook dropped it (campaign access check hit a 429) and no row was
 * stored, so the poller had nothing to recover. This inserts one pending
 * row keyed to her Message-ID and posts one approval card in the Vector
 * channel. The draft is fixed text. The mailbox adds the signature.
 * A later boot that finds a Slack timestamp does nothing. It does not send.
 */

const db = require('../db');
const { canonicalInboundMessageId, claimNewInbound, isPostedSlackTs } = require('./reply-dedupe');
const { postProspectSlackCard } = require('./slack-reply-post');
const { formatCampaignDisplay } = require('../utils/campaign-display');

const MARBELLA_LEAD_EMAIL = 'marbella@pacocean.net';
const MARBELLA_LEAD_NAME = 'Marbella Porcayo';
const MARBELLA_CAMPAIGN_ID = '4242292';
const MARBELLA_LEAD_ID = '4826394186';
const MARBELLA_MESSAGE_ID = '<C472638D-01F3-4902-B61B-C0C8AE0A923A@pacocean.net>';
const MARBELLA_INBOUND = 'Wed, Oct 28 at 11:00 AM PDT';
const MARBELLA_DRAFT = 'Hey Marbella, that time works for us. We look forward to meeting with you Wednesday, Oct 28 at 11:00 AM PDT!';

const ACTIONED = new Set([
  'sent', 'approved', 'sending', 'rejected', 'disqualified', 'meeting_booked',
]);

function marbellaMessageId() {
  return canonicalInboundMessageId(MARBELLA_MESSAGE_ID);
}

function rowAlreadyHandled(row) {
  if (!row) return false;
  if (isPostedSlackTs(row.slack_message_ts)) return true;
  return ACTIONED.has(String(row.status || '').toLowerCase());
}

async function loadVectorClient(query) {
  const { rows: routed } = await query(
    `SELECT c.*
       FROM smartlead_campaign_routes r
       JOIN clients c ON c.id = r.client_id
      WHERE r.campaign_id::text = $1
        AND c.active IS DISTINCT FROM false
      LIMIT 1`,
    [MARBELLA_CAMPAIGN_ID]
  );
  if (routed[0]) return routed[0];
  const { rows } = await query(
    `SELECT *
       FROM clients
      WHERE active IS DISTINCT FROM false
        AND lower(name) LIKE 'vector%'
      ORDER BY created_at ASC
      LIMIT 1`
  );
  return rows[0] || null;
}

async function ensureMarbellaReplyCard({
  query = (...args) => db.query(...args),
  loadClient = () => loadVectorClient(query),
  claim = claimNewInbound,
  postCard = postProspectSlackCard,
} = {}) {
  const messageId = marbellaMessageId();
  const { rows } = await query(
    `SELECT id, slack_message_ts, status, draft_reply, classification,
            inbound_message_id, lead_email, campaign_id
       FROM pending_replies
      WHERE lower(COALESCE(inbound_message_id, '')) = $1
        AND COALESCE(classification, '') <> 'FOLLOW_UP'
      ORDER BY created_at ASC`,
    [messageId]
  );
  const existing = rows || [];
  if (existing.some(rowAlreadyHandled)) return { action: 'already_posted' };

  const client = await loadClient();
  if (!client) return { action: 'no_client' };

  let reply = existing[0] || null;
  if (!reply) {
    const threadContext = {
      history: [{
        type: 'REPLY',
        time: '2026-10-27T14:32:00.000Z',
        message_id: MARBELLA_MESSAGE_ID,
        email_body: MARBELLA_INBOUND,
      }],
    };
    const claimed = await claim({
      clientId: client.id,
      platform: 'smartlead',
      leadId: MARBELLA_LEAD_ID,
      leadEmail: MARBELLA_LEAD_EMAIL,
      inboundMessage: MARBELLA_INBOUND,
      messageId,
    }, async (conn) => {
      const q = conn && typeof conn.query === 'function' ? conn.query.bind(conn) : query;
      const { rows: inserted } = await q(
        `INSERT INTO pending_replies
          (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email,
           inbound_message, thread_context, classification, draft_reply, status, inbound_message_id)
         VALUES ($1, 'smartlead', $2, $3, $4, $5, $6, $7, $8, 'MEETING_PROPOSED', $9, 'pending', $10)
         RETURNING *`,
        [
          client.id,
          MARBELLA_CAMPAIGN_ID,
          null,
          MARBELLA_LEAD_ID,
          MARBELLA_LEAD_NAME,
          MARBELLA_LEAD_EMAIL,
          MARBELLA_INBOUND,
          JSON.stringify(threadContext),
          MARBELLA_DRAFT,
          messageId,
        ]
      );
      return inserted[0];
    });
    if (claimed.duplicate) {
      reply = claimed.existing;
      if (rowAlreadyHandled(reply)) return { action: 'already_posted', replyId: reply && reply.id };
    } else {
      reply = claimed.reply;
    }
  }

  if (!reply || !reply.id) return { action: 'skipped' };
  if (rowAlreadyHandled(reply)) return { action: 'already_posted', replyId: reply.id };

  if (reply.draft_reply !== MARBELLA_DRAFT || reply.classification !== 'MEETING_PROPOSED') {
    await query(
      `UPDATE pending_replies
          SET draft_reply = $1,
              classification = 'MEETING_PROPOSED',
              status = CASE WHEN status = 'suppressed' THEN 'pending' ELSE status END,
              updated_at = now()
        WHERE id = $2
          AND slack_message_ts IS NULL`,
      [MARBELLA_DRAFT, reply.id]
    );
    reply = { ...reply, draft_reply: MARBELLA_DRAFT, classification: 'MEETING_PROPOSED' };
  }

  const posted = await postCard({
    token: client.slack_bot_token,
    channelId: client.slack_channel_id,
    clientId: client.id,
    platform: 'smartlead',
    campaignId: MARBELLA_CAMPAIGN_ID,
    leadId: MARBELLA_LEAD_ID,
    threadContext: reply.thread_context,
    isDraft: true,
    replyId: reply.id,
    card: {
      replyId: reply.id,
      leadName: MARBELLA_LEAD_NAME,
      leadEmail: MARBELLA_LEAD_EMAIL,
      platform: 'smartlead',
      classification: 'MEETING_PROPOSED',
      draft: MARBELLA_DRAFT,
      reasoning: 'Accepted Wed, Oct 28 at 11:00 AM PDT. Fixed confirmation. Not sent.',
      inboundMessage: reply.inbound_message || MARBELLA_INBOUND,
      campaignDisplay: formatCampaignDisplay(null, MARBELLA_CAMPAIGN_ID),
    },
  });
  if (posted && posted.skipped) return { action: 'already_posted', replyId: reply.id };
  return { action: 'posted', replyId: reply.id };
}

module.exports = {
  MARBELLA_LEAD_EMAIL,
  MARBELLA_LEAD_NAME,
  MARBELLA_CAMPAIGN_ID,
  MARBELLA_LEAD_ID,
  MARBELLA_MESSAGE_ID,
  MARBELLA_INBOUND,
  MARBELLA_DRAFT,
  ensureMarbellaReplyCard,
};
