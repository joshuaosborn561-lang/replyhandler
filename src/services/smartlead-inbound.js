/**
 * One SmartLead delivery of one prospect email.
 *
 * Reply webhook, category webhook, and the inbox poller all enter through
 * acceptInboundDelivery. A matching Message-ID is the same email. Text is
 * only the fallback, and it uses normalizeInboundText. A duplicate never
 * posts a second card or forwards again. A category event updates the row
 * that is already stored.
 */

const db = require('../db');
const { classifyFromSmartlead } = require('./smartlead-category');
const {
  claimNewInbound,
  decodeInboundForStorage,
  canonicalInboundMessageId,
  isPostedSlackTs,
} = require('./reply-dedupe');
const { messageIdOfMessage } = require('../utils/inbound-message-id');
const {
  parseInboundFromPayload,
  cleanInboundOrRaw,
  looksLikeAutomatedNotice,
  preferFullerInbound,
  latestInboundReplyMeta,
  normalizeSmartleadLeadId,
  normalizeSmartleadCampaignId,
} = require('../utils/smartlead-webhook-helpers');

function eventName(payload) {
  return String(
    payload?.event_type || payload?.eventType || payload?.event
    || payload?.webhook_event || payload?.type || ''
  ).toUpperCase().replace(/[\s-]+/g, '_');
}

function isLeadCategoryEvent(payload) {
  const ev = eventName(payload);
  return ev === 'LEAD_CATEGORY_UPDATED'
    || ev === 'LEAD_CATEGORY_CHANGED'
    || ev === 'CATEGORY_UPDATED';
}

function historyListFrom(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const lead = payload.lead_data || payload.lead || {};
  const lists = [
    payload.history,
    payload.email_history,
    payload.emailHistory,
    payload.message_history,
    payload.messages,
    lead.history,
    lead.email_history,
  ];
  for (const list of lists) {
    if (Array.isArray(list) && list.length) return list;
  }
  return [];
}

function replyObject(payload) {
  return payload?.reply_message
    || payload?.replyMessage
    || payload?.reply
    || payload?.latest_reply
    || payload?.last_reply
    || null;
}

function leadEmailFrom(payload, leadData) {
  return payload?.email
    || payload?.lead_email
    || payload?.to_email
    || payload?.sl_lead_email
    || payload?.slLeadEmail
    || leadData?.email
    || leadData?.lead_email
    || payload?.lead?.email
    || null;
}

function leadNameFrom(payload, leadData) {
  return (payload?.lead_first_name
    ? `${payload.lead_first_name} ${payload.lead_last_name || ''}`.trim()
    : null)
    || payload?.name
    || payload?.lead_name
    || payload?.first_name
    || payload?.to_name
    || payload?.toName
    || (leadData?.first_name ? `${leadData.first_name} ${leadData.last_name || ''}`.trim() : null)
    || leadData?.name
    || payload?.lead?.first_name
    || 'Unknown';
}

function campaignNameFrom(payload) {
  return payload?.email_campaign_name
    || payload?.emailCampaignName
    || payload?.campaign_name
    || payload?.campaignName
    || (payload?.campaign && typeof payload.campaign === 'object' ? payload.campaign.name : null)
    || null;
}

/**
 * Body + Message-ID for a webhook payload or a master-inbox poller row.
 * History is read off the payload when SmartLead included it, so the
 * category event can be identified before any API call.
 */
function describeSmartleadInbound(payload = {}) {
  const leadData = payload.lead_data || payload.lead || {};
  const replyObj = replyObject(payload);
  const leadEmail = leadEmailFrom(payload, leadData);
  const hist = { history: historyListFrom(payload) };
  const meta = latestInboundReplyMeta(hist, leadEmail);
  let text = '';
  if (replyObj && typeof replyObj === 'object') {
    text = parseInboundFromPayload(replyObj, payload);
  } else if (replyObj) {
    text = parseInboundFromPayload(replyObj, payload);
  } else {
    text = parseInboundFromPayload(null, payload);
  }
  if (meta.body) text = preferFullerInbound(text, meta.body);
  text = cleanInboundOrRaw(text);
  text = decodeInboundForStorage(text);

  const fromReply = replyObj && typeof replyObj === 'object' ? messageIdOfMessage(replyObj) : '';
  const fromPayload = messageIdOfMessage(payload);
  const messageId = fromReply || meta.messageId || fromPayload || '';

  return {
    campaignId: normalizeSmartleadCampaignId(payload, leadData),
    campaignName: campaignNameFrom(payload),
    leadId: normalizeSmartleadLeadId(payload, leadData),
    leadEmail,
    leadName: leadNameFrom(payload, leadData),
    text,
    messageId,
    isCategoryEvent: isLeadCategoryEvent(payload),
    statsId: payload.stats_id || payload.statsId || payload.email_stats_id || null,
  };
}

async function applyInboundCategory(existing, payload, database, patchCard) {
  if (!existing?.id || !isLeadCategoryEvent(payload)) return existing;
  const sl = classifyFromSmartlead(payload);
  if (!sl?.classification) return existing;
  if (String(existing.classification || '').toUpperCase() === sl.classification) return existing;
  // A later Interested category must not relabel a disclaimer-only reply
  // or patch an approval card onto it. A real human reply still updates.
  if (
    String(existing.classification || '').toUpperCase() === 'AUTOMATED_NOTICE'
    || looksLikeAutomatedNotice(existing.inbound_message)
  ) {
    return existing;
  }
  const query = database.query.bind(database);
  const { rows } = await query(
    `UPDATE pending_replies
        SET classification = $1, updated_at = now()
      WHERE /* inbound-category */ id = $2
      RETURNING *`,
    [sl.classification, existing.id]
  );
  const updated = rows[0] || { ...existing, classification: sl.classification };
  if (isPostedSlackTs(existing.slack_message_ts) && typeof patchCard === 'function') {
    await patchCard(updated);
  }
  return updated;
}

/**
 * Claim this delivery. Duplicate → no card, no forward.
 * Category-changed on a stored email updates that row.
 * First arrival of either event still produces the single card.
 */
async function acceptInboundDelivery({
  clientId,
  payload,
  inboundMessage,
  leadId,
  leadEmail,
  leadName,
  campaignId,
  campaignName,
  messageId,
  statsId,
  patchCard,
  db: dbOverride,
} = {}) {
  const described = describeSmartleadInbound(payload || {});
  const provided = inboundMessage ? decodeInboundForStorage(inboundMessage) : '';
  const text = preferFullerInbound(provided, described.text || '') || provided || described.text || '';
  const mid = canonicalInboundMessageId(messageId || described.messageId);
  const resolvedLeadId = leadId || described.leadId;
  const resolvedEmail = leadEmail || described.leadEmail;
  const resolvedCampaign = campaignId || described.campaignId;
  const resolvedName = leadName || described.leadName;
  const resolvedCampaignName = campaignName || described.campaignName;
  const resolvedStats = statsId || described.statsId || null;

  if (!clientId || !resolvedCampaign || !resolvedLeadId || !text) {
    return {
      duplicate: false,
      postCard: false,
      forward: false,
      reason: 'incomplete',
      described: { ...described, text, messageId: mid },
      reply: null,
      existing: null,
    };
  }

  const sl = classifyFromSmartlead(payload);
  const placeholder = sl?.classification || 'OTHER';
  const database = dbOverride || db;
  const claimed = await claimNewInbound({
    clientId,
    platform: 'smartlead',
    leadId: resolvedLeadId,
    leadEmail: resolvedEmail,
    inboundMessage: text,
    messageId: mid,
  }, async (conn) => {
    const { rows: [inserted] } = await conn.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email, inbound_message, thread_context, classification, draft_reply, status, smartlead_email_stats_id, inbound_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        clientId,
        'smartlead',
        String(resolvedCampaign),
        resolvedCampaignName || null,
        String(resolvedLeadId),
        resolvedName,
        resolvedEmail || null,
        text,
        JSON.stringify([]),
        placeholder,
        '',
        'pending',
        resolvedStats,
        mid || null,
      ]
    );
    return inserted;
  }, database);

  if (claimed.duplicate) {
    let existing = claimed.existing;
    if (described.isCategoryEvent || isLeadCategoryEvent(payload)) {
      existing = await applyInboundCategory(existing, payload, database, patchCard);
    }
    return {
      duplicate: true,
      postCard: false,
      forward: false,
      reason: 'duplicate',
      described: { ...described, text, messageId: mid },
      reply: null,
      existing,
    };
  }

  return {
    duplicate: false,
    postCard: true,
    forward: true,
    reason: 'created',
    described: { ...described, text, messageId: mid },
    reply: claimed.reply,
    existing: null,
  };
}

module.exports = {
  eventName,
  isLeadCategoryEvent,
  describeSmartleadInbound,
  acceptInboundDelivery,
  applyInboundCategory,
};
