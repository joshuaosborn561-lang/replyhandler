const db = require('../db');
const slack = require('./slack');
const { followUpSlackChannelId } = require('./follow-up-runner');
const { extractThreadMessages } = require('../utils/thread-transcript');
const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');

function parseThreadContext(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return typeof raw === 'object' ? raw : null;
}

function lastOutboundFor(platform, threadContext) {
  if (!threadContext || typeof threadContext !== 'object') return '';
  if (platform === 'smartlead' && !Array.isArray(threadContext)) {
    return lastOutboundBodyFromSmartleadHistory(threadContext) || '';
  }
  const msgs = Array.isArray(threadContext.messages) ? threadContext.messages : [];
  let last = '';
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase();
    if (role !== 'us' && role !== 'me') continue;
    const t = (typeof m.message === 'string' && m.message)
      || (typeof m.text === 'string' && m.text)
      || (typeof m.body === 'string' && m.body)
      || '';
    if (t.trim()) last = t.trim();
  }
  return last;
}

function threadMessagesFor(reply, lastOutbound) {
  return extractThreadMessages(reply.platform, reply.thread_context, {
    maxMessages: 20,
    extraMessages: [
      ...(reply.inbound_message ? [{ role: 'them', body: reply.inbound_message }] : []),
      ...((reply.sent_reply || lastOutbound)
        ? [{ role: 'us', body: reply.sent_reply || lastOutbound }]
        : []),
    ],
  });
}

function actionKindFor(status) {
  switch (String(status || '')) {
    case 'rejected': return 'rejected';
    case 'disqualified': return 'disqualified';
    case 'meeting_booked': return 'meeting_booked';
    case 'flagged': return 'failed';
    case 'sent':
    case 'approved':
      return 'approved';
    default:
      return null;
  }
}

function uniqueChannels(reply, followUpChannel) {
  return [...new Set(
    [followUpChannel, reply.client_slack_channel_id].filter((id) => id && String(id).trim())
  )];
}

function isMissingMessageError(err) {
  const msg = String(err && err.message || '');
  return /channel_not_found|message_not_found|cant_update_message|not_in_channel/i.test(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rewrite already-posted FOLLOW_UP Slack cards to the compact layout
 * (lead → suggested send → last thread turn → buttons). Old cards from
 * before that layout still sit in #followups-ai-replies as the full dump.
 */
async function refreshFollowUpSlackCards({ days = 21, limit = 80 } = {}) {
  const lookback = Number.isFinite(Number(days)) ? Math.min(Math.max(Number(days), 1), 60) : 21;
  const cap = Number.isFinite(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 200) : 80;
  const { rows } = await db.query(
    `SELECT pr.id, pr.status, pr.classification, pr.draft_reply, pr.sent_reply,
            pr.inbound_message, pr.thread_context, pr.slack_message_ts,
            pr.lead_name, pr.lead_email, pr.lead_phone, pr.lead_phone_provider,
            pr.phone_enrichment_status, pr.platform, pr.campaign_id, pr.campaign_name,
            c.slack_bot_token,
            c.slack_channel_id AS client_slack_channel_id
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE upper(pr.classification) = 'FOLLOW_UP'
        AND pr.slack_message_ts IS NOT NULL
        AND pr.status NOT IN ('suppressed')
        AND c.slack_bot_token IS NOT NULL
        AND pr.created_at > now() - ($1::text || ' days')::interval
      ORDER BY pr.created_at DESC
      LIMIT $2`,
    [String(lookback), cap]
  );

  const followUpChannel = followUpSlackChannelId();
  const summary = { scanned: rows.length, updated: 0, failed: 0, errors: [] };

  for (const reply of rows) {
    const tc = parseThreadContext(reply.thread_context);
    const lastOutbound = lastOutboundFor(reply.platform, tc) || '';
    const threadMessages = threadMessagesFor(reply, lastOutbound);
    const campaignDisplay = formatCampaignDisplay(
      campaignNameFromReply(reply),
      reply.campaign_id,
    ) || undefined;
    const channels = uniqueChannels(reply, followUpChannel);
    const kind = actionKindFor(reply.status);
    const card = {
      replyId: reply.id,
      leadName: reply.lead_name,
      leadEmail: reply.lead_email,
      leadPhone: reply.lead_phone || undefined,
      phoneProvider: reply.lead_phone_provider || undefined,
      phoneEnrichmentStatus: reply.phone_enrichment_status || undefined,
      platform: reply.platform,
      classification: 'FOLLOW_UP',
      draft: reply.draft_reply,
      inboundMessage: reply.inbound_message,
      lastOutboundMessage: lastOutbound || undefined,
      campaignDisplay,
      threadMessages,
      contextLabel: 'You sent',
    };

    let updated = false;
    let lastErr = null;
    for (const channelId of channels) {
      try {
        if (!kind) {
          await slack.updateDraftApprovalCard(
            reply.slack_bot_token,
            channelId,
            reply.slack_message_ts,
            card,
          );
        } else {
          await slack.updateSentConfirmationCard(
            reply.slack_bot_token,
            channelId,
            reply.slack_message_ts,
            {
              ...card,
              sentReply: reply.sent_reply,
              actionKind: kind,
            },
          );
        }
        updated = true;
        break;
      } catch (err) {
        lastErr = err;
        if (isMissingMessageError(err)) continue;
        break;
      }
    }

    if (updated) {
      summary.updated += 1;
    } else {
      summary.failed += 1;
      summary.errors.push({
        id: reply.id,
        lead: reply.lead_name,
        err: lastErr ? lastErr.message : 'no channel accepted the update',
      });
    }
    await sleep(250);
  }

  return summary;
}

module.exports = {
  refreshFollowUpSlackCards,
  actionKindFor,
  uniqueChannels,
};
