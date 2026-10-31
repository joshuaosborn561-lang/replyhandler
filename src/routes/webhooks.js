const { withSmartleadKey, routeClientForCampaign } = require('../services/campaign-routing');
const { applyPositiveIntentGuard } = require('../utils/positive-intent');
const { shouldAlertOther, postOtherAlert } = require('../services/other-alert');
const { extractLeadPhone } = require('../utils/lead-phone');
const { Router } = require('express');
const db = require('../db');
const smartlead = require('../services/smartlead');
const heyreach = require('../services/heyreach');
const { classifyAndDraft, draftOnly } = require('../services/classifier');
const { withKnownOutbound } = require('../services/jev-classifier');
const slack = require('../services/slack');
const { enrichPendingReplyPhone } = require('../services/reply-phone-enrichment');
const { postProspectSlackCard, patchPostedCard } = require('../services/slack-reply-post');
const {
  inboundPrefix,
  inboundAlreadyRecorded,
  claimNewInbound,
  decodeInboundForStorage,
} = require('../services/reply-dedupe');
const { recordSuppressedReply } = require('../services/suppressed-replies');
const { classifyFromSmartlead, applySmartleadCategory } = require('../services/smartlead-category');
const { resolveVerifiedSchedulingSlots } = require('../services/scheduling-slots');
const { cancelForInboundReply } = require('../services/outbound-follow-up');
const { applyClientDraftPolicy } = require('../utils/client-draft-policy');
const { applyFactCheckToPolicy } = require('../utils/draft-fact-check');
const { formatCampaignDisplay } = require('../utils/campaign-display');
const {
  cleanInboundOrRaw,
  payloadInboundIsBlank,
  looksLikeHtml,
  latestInboundReplyIsBlank,
  latestInboundFromSmartleadHistory,
  lastOutboundBodyFromSmartleadHistory,
  isLikelyDuplicateOfOutbound,
  parseInboundFromPayload,
  preferFullerInbound,
  normalizeSmartleadLeadId,
  normalizeSmartleadCampaignId,
  SMARTLEAD_NON_REPLY_EVENTS,
  looksLikeUnsubscribe,
  looksLikeAutomatedNotice,
  slackSuppressionReason,
  smartleadWebhookEnhancementsEnabled,
} = require('../utils/smartlead-webhook-helpers');
const { slackChannelSuppressionReason } = require('../utils/slack-channel-policy');
const { leadSuppressionReason } = require('../services/lead-suppression');
const { maybeForwardInboundReply } = require('../services/inbound-forward');
const {
  acceptInboundDelivery,
  isLeadCategoryEvent,
  describeSmartleadInbound,
} = require('../services/smartlead-inbound');
const { isColdInbound } = require('../services/heyreach-poller');
const { buildReplyAll, ourIdentitiesFromThread, emailsFromValue } = require('../utils/reply-all');
const { promoteReferral } = require('../utils/referral-promotion');
const { referralCcCsv } = require('../utils/referred-contact');

/** Positive SmartLead classes: always drafted. */
const SMARTLEAD_DRAFT_ALWAYS = new Set(['INTERESTED', 'MEETING_PROPOSED', 'QUESTION']);

/**
 * Handler result straight from SmartLead's category. No LLM call. Mixed /
 * conditional bodies under a drop label still surface as a conversation.
 */
function smartleadCategoryResult(slCategory, inboundMessage) {
  const { promoteMixedIntent } = require('../utils/mixed-intent');
  const base = slCategory.classification;
  const classification = base === 'NOT_INTERESTED'
    ? (promoteMixedIntent(base, inboundMessage) || base)
    : base;
  return {
    classification,
    draft: '',
    proposed_time: null,
    reasoning: `SmartLead category "${slCategory.raw}" → ${classification}.`,
    source: 'smartlead_category',
  };
}

/**
 * Mailbox changes, departure bots, and ticket confirmations. Checked before
 * SmartLead's category and before referral promotion.
 */
function automatedNoticeResult(inboundMessage) {
  if (!looksLikeAutomatedNotice(inboundMessage)) return null;
  return {
    classification: 'AUTOMATED_NOTICE',
    draft: '',
    proposed_time: null,
    reasoning: 'Automated notice (mailbox change, departure, ticket confirmation, or disclaimer/scanner footer). No draft.',
    source: 'automated_notice',
  };
}

function referralOptsFromThread(threadContext, { prospectEmail, prospectName, extraEmails } = {}) {
  return {
    prospectEmail,
    prospectName,
    ourEmails: [
      ...ourIdentitiesFromThread(threadContext),
      ...emailsFromValue(extraEmails),
    ],
  };
}

async function storeReferralCc(replyId, contacts) {
  const csv = referralCcCsv(contacts);
  if (!replyId || !csv) return;
  console.log('[Referral] referred contact', { replyId, cc: csv });
  try {
    await db.query(
      `UPDATE pending_replies SET referral_cc = $1, updated_at = now() WHERE id = $2`,
      [csv, replyId]
    );
  } catch (err) {
    console.warn('[Referral] referral_cc not stored', { replyId, cc: csv, err: err.message });
  }
}

const router = Router();

function stripHtmlToTextLocal(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function smartleadLastOutboundFromPayload(payload) {
  const p = payload || {};
  const sent = p.sent_message && typeof p.sent_message === 'object' ? p.sent_message : null;
  const fromSent =
    (sent && typeof sent.text === 'string' && sent.text.trim()) ||
    (sent && stripHtmlToTextLocal(sent.html || sent.email_body || '')) ||
    '';
  const fromBody =
    (typeof p.sent_message_body === 'string' && stripHtmlToTextLocal(p.sent_message_body)) ||
    (typeof p.sent_message_text === 'string' && String(p.sent_message_text).trim()) ||
    '';
  return String(fromSent || fromBody || '').trim();
}

function heyreachLastOutboundFromThread(threadContext) {
  const list = Array.isArray(threadContext) ? threadContext : [];
  let last = '';
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase();
    const isUs = role === 'us' || role === 'me' || role === 'sender' || role === 'user';
    if (!isUs) continue;
    const txt =
      (typeof m.message === 'string' && m.message) ||
      (typeof m.text === 'string' && m.text) ||
      (typeof m.body === 'string' && m.body) ||
      '';
    if (txt && String(txt).trim()) last = String(txt).trim();
  }
  return last;
}

function smartleadCampaignName(payload) {
  const p = payload || {};
  return (
    p.email_campaign_name ||
    p.emailCampaignName ||
    p.campaign_name ||
    p.campaignName ||
    (p.campaign && typeof p.campaign === 'object' ? p.campaign.name : null) ||
    null
  );
}

/**
 * HeyReach webhook shapes vary by event. Reply webhooks often send:
 * campaign: { id, name }, recent_messages: [...], conversation_id, sender, etc.
 */
function normalizeHeyreachPayload(payload) {
  const p = payload || {};
  const campaign = p.campaign && typeof p.campaign === 'object' ? p.campaign : null;

  const campaignId =
    p.campaignId ??
    p.campaign_id ??
    p.campaignID ??
    p.CampaignId ??
    p.listCampaignId ??
    p.list_campaign_id ??
    p.campaign?.id ??
    campaign?.id ??
    campaign?.campaignId ??
    p.data?.campaignId ??
    p.data?.campaign_id ??
    null;

  const campaignName =
    p.campaign_name ||
    p.campaignName ||
    campaign?.name ||
    null;

  const conversationId = p.conversation_id || p.conversationId || p.thread_id || p.threadId || p.chat_id || p.chatId || null;

  const leadId =
    p.leadId ??
    p.lead_id ??
    p.lead?.id ??
    p.data?.leadId ??
    p.data?.lead_id ??
    null;

  const recent = Array.isArray(p.recent_messages) ? p.recent_messages : [];
  const lastMsg = recent.length ? recent[recent.length - 1] : null;
  function msgTextFromRecentRow(m) {
    if (!m || typeof m !== 'object') return '';
    return (
      (typeof m.message === 'string' && m.message) ||
      (typeof m.text === 'string' && m.text) ||
      (typeof m.body === 'string' && m.body) ||
      (typeof m.content === 'string' && m.content) ||
      ''
    );
  }
  const inboundMessage =
    (typeof p.message === 'string' && p.message) ||
    (typeof p.reply === 'string' && p.reply) ||
    (typeof p.body === 'string' && p.body) ||
    (lastMsg ? msgTextFromRecentRow(lastMsg) : '') ||
    '';

  const lead = p.lead && typeof p.lead === 'object' ? p.lead : null;
  const recipient = p.recipient && typeof p.recipient === 'object' ? p.recipient : null;
  const prospect = p.prospect && typeof p.prospect === 'object' ? p.prospect : null;
  const fromProspect = recipient || prospect || lead;

  const leadName = heyreach.extractHeyreachLeadName({
    ...p,
    lead,
    profile: p.profile,
    prospect,
    recipient,
  });

  const linkedinUrl =
    heyreach.extractHeyreachLinkedinUrl(p) ||
    heyreach.extractHeyreachLinkedinUrl(fromProspect) ||
    null;

  const listId = p.listId ?? p.list_id ?? p.list?.id ?? null;
  // linkedInAccountId: the HeyReach LinkedIn account that received the DM.
  // Typical reply webhook exposes this via p.sender.id (confirmed from live logs).
  const linkedinAccountId =
    p.linkedinAccountId ??
    p.linkedin_account_id ??
    p.linkedInAccountId ??
    p.linked_in_account_id ??
    p.accountId ??
    p.linkedin_account?.id ??
    p.sender?.id ??
    null;
  const senderId =
    p.senderId ??
    p.sender_id ??
    p.sender?.senderId ??
    p.sender?.sender_id ??
    null;

  let threadContext = p.conversationHistory || p.thread;
  if (!threadContext && recent.length) {
    threadContext = recent.map((m) => ({
      role: m.is_reply ? 'prospect' : 'us',
      message: msgTextFromRecentRow(m),
      at: m.creation_time,
    }));
  }

  return {
    campaignId,
    campaignName,
    leadId,
    conversationId,
    linkedinUrl,
    leadName,
    inboundMessage,
    listId,
    linkedinAccountId,
    senderId,
    threadContext,
    company: fromProspect?.company_name || fromProspect?.company || p.company_name || p.company || null,
  };
}

const heyreachDedupe = new Map();

/**
 * Thread key for a LinkedIn reply whose payload carries neither a lead id nor a
 * conversation id. Stable for the same person and the same text, so a redelivery
 * still dedupes. Never empty, so the reply is never dropped for want of an id.
 */
function heyreachFallbackThreadKey({ linkedinUrl, leadName, inboundMessage } = {}) {
  const who = String(linkedinUrl || leadName || '').trim().toLowerCase();
  const digest = require('crypto').createHash('sha1')
    .update(`${who}|${inboundPrefix(inboundMessage)}`).digest('hex').slice(0, 16);
  return `hr-derived:${digest}`;
}

function heyreachDedupeKey({
  clientId, campaignId, leadId, conversationId, inboundMessage, linkedinUrl, listId, linkedinAccountId,
}) {
  // Same 120-char key as the DB check, so the two never disagree about
  // whether a redelivery is a duplicate.
  const msg = inboundPrefix(inboundMessage);
  const threadKey = String(conversationId || '').trim() || String(leadId || '');
  return [
    clientId,
    'heyreach',
    String(campaignId || ''),
    threadKey,
    String(linkedinUrl || ''),
    String(listId || ''),
    String(linkedinAccountId || ''),
    msg,
  ].join('|');
}

function isHeyreachDuplicate(key) {
  const now = Date.now();
  const ttlMs = 5 * 60 * 1000;
  const last = heyreachDedupe.get(key);
  if (heyreachDedupe.size > 2000) {
    for (const [k, ts] of heyreachDedupe.entries()) {
      if (now - ts > ttlMs) heyreachDedupe.delete(k);
    }
  }
  if (last && now - last < ttlMs) return true;
  heyreachDedupe.set(key, now);
  return false;
}

async function heyreachDuplicateInDb({ clientId, campaignId, leadId, conversationId, inboundMessage }) {
  void campaignId;
  const ids = [...new Set([
    conversationId != null && String(conversationId).trim() !== '' ? String(conversationId).trim() : null,
    leadId == null ? null : String(leadId),
  ].filter(Boolean))];
  if (!ids.length) {
    return Boolean(await inboundAlreadyRecorded(db, {
      clientId, platform: 'heyreach', leadId: '', leadEmail: '', inboundMessage,
    }));
  }
  for (const id of ids) {
    if (await inboundAlreadyRecorded(db, {
      clientId, platform: 'heyreach', leadId: id, leadEmail: '', inboundMessage,
    })) {
      return true;
    }
  }
  return false;
}

/**
 * SmartLead redelivers the same EMAIL_REPLY event on retry. Without this, each
 * redelivery burned a fresh Gemini classification and posted a duplicate Slack
 * card. Unbounded window on purpose: an identical body from the same lead in the
 * same campaign is a redelivery, not a new reply.
 * Originally by cayden-design (e23f6b5); reworked onto the current handler.
 *
 * Text only — never smartlead_email_stats_id. That id is the most recent
 * outbound SENT message and stays the same across different replies to that
 * send. Matching on it dropped a genuinely new reply with zero trace
 * (2026-08-03, Doug Baden/Parlay Tech). Same text is a duplicate. Different
 * text always shows, even when that means a second card.
 */
async function smartleadDuplicateInDb({ clientId, campaignId, leadId, inboundMessage, leadEmail, messageId }) {
  void campaignId;
  return Boolean(await inboundAlreadyRecorded(db, {
    clientId,
    platform: 'smartlead',
    leadId,
    leadEmail,
    inboundMessage,
    messageId,
  }));
}

// ─── SmartLead Webhook ───────────────────────────────────────────────
router.post('/webhook/smartlead/:clientId', async (req, res) => {
  let { clientId } = req.params;
  const payload = req.body;

  console.log('[Webhook] SmartLead inbound', { clientId, payload: JSON.stringify(payload).slice(0, 4000) });

  try {
    let { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client || !client.active) {
      console.warn('[Webhook] Unknown or inactive client', { clientId });
      return res.status(200).json({ ok: true, skipped: true });
    }

    const slEnhance = smartleadWebhookEnhancementsEnabled();

    // SmartLead webhook payloads vary by event + test button; support common shapes.
    const leadData = payload.lead_data || payload.lead || {};
    // SmartLead EMAIL_REPLY payloads often use reply_message/sent_message (not "reply").
    const replyObj =
      payload.reply_message ||
      payload.replyMessage ||
      payload.reply ||
      payload.latest_reply ||
      payload.last_reply ||
      null;

    const campaignId = normalizeSmartleadCampaignId(payload, leadData);

    client = withSmartleadKey(client);
    const routedClient = await routeClientForCampaign(client, campaignId);
    if (routedClient !== client) {
      console.log('[Webhook] SmartLead campaign routed', { from: clientId, to: routedClient.id, campaignId });
      client = routedClient;
      clientId = routedClient.id;
    }

    let leadId = normalizeSmartleadLeadId(payload, leadData);

    const leadEmail =
      payload.email ||
      payload.lead_email ||
      payload.to_email ||
      payload.sl_lead_email ||
      payload.slLeadEmail ||
      leadData.email ||
      leadData.lead_email ||
      payload.lead?.email;

    const leadName =
      (payload.lead_first_name
        ? `${payload.lead_first_name} ${payload.lead_last_name || ''}`.trim()
        : null) ||
      payload.name ||
      payload.lead_name ||
      payload.first_name ||
      payload.to_name ||
      payload.toName ||
      (leadData.first_name ? `${leadData.first_name} ${leadData.last_name || ''}`.trim() : null) ||
      leadData.name ||
      payload.lead?.first_name ||
      'Unknown';

    const resolvedCampaignId = campaignId;

    if (slEnhance) {
      const ev = String(
        payload.event_type || payload.eventType || payload.event || payload.webhook_event || payload.type || ''
      ).toUpperCase();
      if (ev && SMARTLEAD_NON_REPLY_EVENTS.has(ev)) {
        console.log('[Webhook] SmartLead skipped non-reply event', { clientId, event: ev });
        return res.status(200).json({ ok: true, skipped: true, reason: 'non_reply_event', event: ev });
      }
    }

    // HTML-converted text over the webhook `text` preview, enhancements on or off.
    const inboundMessage = parseInboundFromPayload(replyObj, payload);

    console.log('[Webhook] SmartLead extracted', {
      clientId,
      campaignId: resolvedCampaignId,
      leadId,
      hasLeadData: !!payload.lead_data,
      hasReplyObj: !!replyObj,
    });

    if (!client.smartlead_api_key) {
      console.warn('[Webhook] SmartLead skipped — no API key on client', { clientId, client: client.name });
      return res.status(200).json({ ok: true, skipped: true, reason: 'no_smartlead_api_key' });
    }

    let inboundForPersist = String(inboundMessage || '').trim();
    if (slEnhance && inboundForPersist) {
      inboundForPersist = cleanInboundOrRaw(inboundForPersist);
    }
    // After tag stripping. Decoding first would turn `&lt;...&gt;` into a tag
    // and the stripper would eat it.
    inboundForPersist = decodeInboundForStorage(inboundForPersist);
    const earlyStatsId = payload.stats_id || payload.statsId || null;
    const slEarly = classifyFromSmartlead(payload);
    void slEarly;

    const accepted = await acceptInboundDelivery({
      clientId,
      payload,
      inboundMessage: inboundForPersist,
      leadId,
      leadEmail,
      leadName,
      campaignId: resolvedCampaignId,
      campaignName: smartleadCampaignName(payload) || null,
      statsId: earlyStatsId,
      patchCard: async (row) => {
        const { patchPostedCard, loadLatestCard } = require('../services/slack-reply-post');
        if (!await loadLatestCard(row.id) || !client.slack_bot_token || !client.slack_channel_id) return;
        await patchPostedCard({
          token: client.slack_bot_token,
          channelId: client.slack_channel_id,
          ts: row.slack_message_ts,
          replyId: row.id,
          isDraft: true,
          patch: {
            classification: row.classification,
            inboundMessage: row.inbound_message,
            leadName: row.lead_name,
            leadEmail: row.lead_email,
            platform: 'smartlead',
            replyId: row.id,
          },
        });
      },
    });
    if (accepted.duplicate) {
      console.log('[Webhook] SmartLead duplicate suppressed (db)', {
        clientId,
        campaignId: resolvedCampaignId,
        leadId,
        existingId: accepted.existing?.id,
        category: isLeadCategoryEvent(payload),
      });
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'duplicate_db',
        replyId: accepted.existing?.id || null,
      });
    }
    let replyRow = accepted.reply || null;

    res.status(200).json({ ok: true, accepted: true, replyId: replyRow?.id || null });

    setImmediate(() => {
      processSmartleadWebhookAsync({
        client,
        clientId,
        payload,
        leadData,
        campaignId: resolvedCampaignId,
        leadId,
        leadEmail,
        leadName,
        inboundMessage,
        slEnhance,
        replyRow,
        smartleadEmailStatsId: payload.stats_id || payload.statsId || null,
      }).catch((err) => {
        console.error('[Webhook] SmartLead async handler error', {
          clientId, err: err.message, stack: err.stack,
        });
      });
    });
    return;
  } catch (err) {
    console.error('[Webhook] SmartLead handler error', { clientId, err: err.message, stack: err.stack });
    if (!res.headersSent) {
      res.status(200).json({ ok: true, error: 'internal error' });
    }
    return;
  }
});

async function processSmartleadWebhookAsync({
  client,
  clientId,
  payload,
  leadData,
  campaignId,
  leadId,
  leadEmail,
  leadName,
  inboundMessage,
  slEnhance,
  replyRow,
  smartleadEmailStatsId,
}) {
  let resolvedCampaignId = campaignId;
  let resolvedLeadId = leadId;
  let smartleadLead = null;
  // No real lead id in the payload: look the lead up by email and trust
  // Smartlead's own campaign membership over whatever the payload implied.
  if (!resolvedLeadId && leadEmail && client.smartlead_api_key) {
    try {
      const found = await smartlead.lookupLeadByEmail(client.smartlead_api_key, leadEmail);
      if (found) {
        smartleadLead = found.lead;
        resolvedLeadId = found.leadId;
        const picked = smartlead.pickLeadCampaign(resolvedCampaignId, found.campaignIds);
        if (picked !== resolvedCampaignId) {
          console.log('[Webhook] SmartLead campaign corrected from lead lookup', {
            clientId, from: resolvedCampaignId, to: picked,
          });
        }
        resolvedCampaignId = picked;
      }
    } catch (err) {
      console.warn('[Webhook] SmartLead lead lookup by email failed', { clientId, err: err.message });
    }
  }
  if ((!resolvedCampaignId || !resolvedLeadId) && client.smartlead_api_key) {
    try {
      const resolved = await smartlead.resolveIdsFromMasterInbox(client.smartlead_api_key, {
        leadId: resolvedLeadId,
        leadEmail,
        statsId: payload.stats_id || payload.statsId || payload.email_stats_id,
      });
      if (resolved) {
        resolvedCampaignId = resolvedCampaignId || resolved.campaignId;
        resolvedLeadId = resolvedLeadId || resolved.leadId;
      }
    } catch (err) {
      console.warn('[Webhook] SmartLead master inbox id resolution failed', { clientId, err: err.message });
    }
  }

  if (!resolvedCampaignId || !resolvedLeadId) {
    console.error('[Webhook] SmartLead payload missing campaign_id or lead_id', { clientId, hasEmail: !!leadEmail });
    return;
  }

  const campaignOk = await smartlead.verifyCampaignAccess(client.smartlead_api_key, resolvedCampaignId);
  if (!campaignOk) {
    console.warn('[Webhook] SmartLead campaign not accessible for this client (wrong URL or wrong account)', {
      clientId, campaignId: resolvedCampaignId,
    });
    return;
  }

  await cancelForInboundReply({
    clientId,
    platform: 'smartlead',
    campaignId: resolvedCampaignId,
    leadId: resolvedLeadId,
    conversationId: null,
  });

  let threadContext;
  let statsId = smartleadEmailStatsId || null;
  let resolvedCampaignName = smartleadCampaignName(payload);
  try {
    const [hist, campName] = await Promise.all([
      smartlead.getThreadHistory(client.smartlead_api_key, resolvedCampaignId, resolvedLeadId).catch((err) => {
        console.error('[Webhook] Failed to fetch SmartLead thread', { clientId, err: err.message });
        return null;
      }),
      resolvedCampaignName
        ? Promise.resolve(resolvedCampaignName)
        : smartlead.resolveCampaignName(client.smartlead_api_key, resolvedCampaignId),
    ]);
    if (hist) {
      threadContext = hist;
      statsId = smartlead.extractStatsIdFromHistory(hist) || statsId;
    }
    if (campName) resolvedCampaignName = campName;
  } catch (err) {
    console.error('[Webhook] SmartLead parallel fetch failed', { clientId, err: err.message });
  }
  if (!threadContext) {
    let fallbackMsg = String(inboundMessage || '').trim();
    if (slEnhance && fallbackMsg) {
      fallbackMsg = cleanInboundOrRaw(fallbackMsg);
    }
    threadContext = [{ role: 'prospect', message: fallbackMsg || '(could not load thread from SmartLead)' }];
  }

  let inboundEffective = String(inboundMessage || '').trim();
  if (slEnhance && inboundEffective) {
    inboundEffective = cleanInboundOrRaw(inboundEffective);
  }
  if (looksLikeHtml(inboundEffective)) {
    inboundEffective = cleanInboundOrRaw(inboundEffective);
  }

  // The newest reply has no text at all (empty Outlook HTML shell, typically an
  // auto-response or a "report phishing" click a few seconds after we send).
  // There is nothing to draft and nothing a person could answer, so this is not
  // a draft failure: no Slack error card. Older replies with text must not be
  // drafted in its place, so check before history expands the inbound.
  if (!inboundEffective && latestInboundReplyIsBlank(threadContext)) {
    console.log('[Webhook] SmartLead blank inbound reply, skipped (no text to draft)', {
      clientId, campaignId: resolvedCampaignId, leadId: resolvedLeadId, hasEmail: !!leadEmail,
    });
    if (replyRow && replyRow.id) {
      await db.query(
        `UPDATE pending_replies
            SET status = 'suppressed', suppression_reason = 'empty_inbound', updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [replyRow.id],
      ).catch((err) => console.warn('[Webhook] could not mark blank reply suppressed', { err: err.message }));
    }
    return;
  }

  if (threadContext && typeof threadContext === 'object' && !Array.isArray(threadContext)) {
    const fromHist = latestInboundFromSmartleadHistory(threadContext, leadEmail);
    const lastSentPlain = lastOutboundBodyFromSmartleadHistory(threadContext);
    if (fromHist) {
      const before = inboundEffective;
      const webhookLooksDup = lastSentPlain && isLikelyDuplicateOfOutbound(inboundEffective, lastSentPlain);
      if (slEnhance && (!inboundEffective || webhookLooksDup)) {
        inboundEffective = fromHist;
      } else {
        // History is the full reply when the webhook `text` was only a preview.
        inboundEffective = preferFullerInbound(inboundEffective, fromHist);
      }
      if (inboundEffective !== before) {
        console.log('[Webhook] SmartLead inbound expanded from message history', {
          clientId,
          before: before.length,
          after: inboundEffective.length,
        });
      }
    } else if (slEnhance && lastSentPlain && isLikelyDuplicateOfOutbound(inboundEffective, lastSentPlain)) {
      inboundEffective = '';
    }
  }

  inboundEffective = decodeInboundForStorage(inboundEffective);
  const inboundDescribed = describeSmartleadInbound(payload);
  let inboundMessageId = inboundDescribed.messageId || '';
  if (threadContext && typeof threadContext === 'object') {
    const { latestInboundReplyMeta } = require('../utils/smartlead-webhook-helpers');
    const meta = latestInboundReplyMeta(threadContext, leadEmail);
    if (meta.messageId) inboundMessageId = inboundMessageId || meta.messageId;
    if (meta.body) inboundEffective = preferFullerInbound(inboundEffective, meta.body);
    inboundEffective = decodeInboundForStorage(inboundEffective);
  }

  if (!inboundEffective) {
    if (latestInboundReplyIsBlank(threadContext) || payloadInboundIsBlank(payload)) {
      console.log('[Webhook] SmartLead blank inbound reply, skipped (no text to draft)', {
        clientId, campaignId: resolvedCampaignId, leadId: resolvedLeadId, hasEmail: !!leadEmail,
      });
      if (replyRow && replyRow.id) {
        await db.query(
          `UPDATE pending_replies
              SET status = 'suppressed', suppression_reason = 'empty_inbound', updated_at = now()
            WHERE id = $1 AND status = 'pending'`,
          [replyRow.id],
        ).catch((err) => console.warn('[Webhook] could not mark blank reply suppressed', { err: err.message }));
      }
      return;
    }
    console.warn('[Webhook] SmartLead could not resolve prospect reply text', { clientId, campaignId: resolvedCampaignId });
    await slack.postError(client.slack_bot_token, client.slack_channel_id, {
      leadName: `${leadName} (SmartLead)`,
      platform: 'smartlead',
      error: 'No usable reply body from webhook or message-history. Reply manually in SmartLead.',
    });
    return;
  }

  const replyAll = buildReplyAll({
    history: threadContext,
    originalLeadEmail: leadEmail,
    fallbackName: leadName,
  });
  const senderName = replyAll.senderDisplayName || leadName;
  const greetName = replyAll.senderFirstName && replyAll.senderFirstName !== 'there'
    ? replyAll.senderFirstName
    : senderName;

  const campaignDisplaySl =
    formatCampaignDisplay(resolvedCampaignName, resolvedCampaignId) || 'Campaign (unknown)';
  const lastOutboundSl =
    smartleadLastOutboundFromPayload(payload) ||
    (threadContext && typeof threadContext === 'object' && !Array.isArray(threadContext)
      ? lastOutboundBodyFromSmartleadHistory(threadContext)
      : '');

  if (!replyRow && await smartleadDuplicateInDb({
    clientId,
    campaignId: resolvedCampaignId,
    leadId: resolvedLeadId,
    leadEmail,
    inboundMessage: inboundEffective,
    messageId: inboundMessageId,
  })) {
    console.log('[Webhook] SmartLead duplicate suppressed (db, async)', { clientId, campaignId: resolvedCampaignId });
    return;
  }

  // Automated notices are suppressed before SmartLead's category. Otherwise
  // the category is the source of truth for email. Only when SmartLead has
  // not labelled the reply do we ask Jev / Gemini to classify.
  // draftOnly writes the draft. A referral handoff is the fixed template,
  // not a freewritten model draft.
  const slCategory = classifyFromSmartlead(payload, threadContext);
  const notice = automatedNoticeResult(inboundEffective);
  let result;
  if (notice) {
    result = notice;
  } else if (slCategory) {
    result = smartleadCategoryResult(slCategory, inboundEffective);
  } else {
    try {
      result = await classifyAndDraft(
        withKnownOutbound(threadContext, lastOutboundSl),
        inboundEffective,
        client.voice_prompt,
        client.booking_link,
        '',
        {
          leadName: greetName,
          digestTimezone: client.digest_timezone,
          platform: 'smartlead',
          clientId,
          leadId: resolvedLeadId,
          leadEmail,
          clientName: client.name,
          draftMode: 'realtime',
          deferDraft: true,
        },
      );
    } catch (err) {
      console.error('[Classifier] Failed for SmartLead reply', { clientId, err: err.message });
      await slack.postError(client.slack_bot_token, client.slack_channel_id, {
        leadName: greetName, platform: 'smartlead', error: err.message,
      });
      return;
    }
  }

  let { classification, draft, proposed_time, reasoning } = result;

  if (!slCategory && !notice) {
    const applied = applySmartleadCategory({
      slCategory: null, classification, inboundMessage: inboundEffective, reasoning,
    });
    classification = applied.classification;
    reasoning = applied.reasoning;
    {
      const guard = applyPositiveIntentGuard(classification, inboundEffective);
      if (guard.overridden) {
        console.log('[Webhook] SmartLead positive-intent guard upgraded classification', { clientId, from: guard.from, to: guard.classification });
        classification = guard.classification;
      }
    }
  }
  let referredContacts = [];
  {
    promoteReferral.opts = referralOptsFromThread(threadContext, {
      prospectEmail: leadEmail,
      prospectName: senderName,
      extraEmails: [payload.from_email, payload.sl_senders_mailbox, payload.sender_email],
    });
    let ref;
    try {
      ref = promoteReferral(classification, inboundEffective);
    } finally {
      promoteReferral.opts = null;
    }
    referredContacts = ref.referredContacts || [];
    if (ref.promoted) {
      console.log('[Webhook] SmartLead referral reply promoted for draft', {
        clientId, from: classification, to: ref.classification, cc: referralCcCsv(referredContacts),
      });
      classification = ref.classification;
      const who = referralCcCsv(referredContacts);
      reasoning = who
        ? `Referral reply (CC ${who}). ${reasoning || ''}`.trim()
        : `Referral reply (prospect looped in a colleague); drafted reply-all. ${reasoning || ''}`.trim();
    }
  }

  if (classification === 'REMOVE_ME' || looksLikeUnsubscribe(inboundEffective)) {
    try {
      const unsubUrl = `https://server.smartlead.ai/api/v1/campaigns/${resolvedCampaignId}/leads/${resolvedLeadId}/unsubscribe?api_key=${encodeURIComponent(client.smartlead_api_key)}`;
      await fetch(unsubUrl, { method: 'POST' });
    } catch (err) {
      console.error('[Webhook] Failed to unsubscribe in SmartLead', { err: err.message });
    }
  }
  let suppressedReason = slackChannelSuppressionReason({
    classification,
    inboundMessage: inboundEffective,
    isColdInbound: false,
    pitchToUsProb: result.pitchToUsProb,
  });
  // Josh, Oct 29 2026: no card for a lead we DQ'd (or that is unsubscribed / Do Not Contact).
  if (!suppressedReason) {
    const leadSuppressed = await leadSuppressionReason(client, {
      platform: 'smartlead',
      campaignId: resolvedCampaignId,
      leadId: resolvedLeadId,
      leadEmail,
    });
    if (leadSuppressed) suppressedReason = leadSuppressed;
  }

  if (!replyRow) {
    const claimed = await claimNewInbound({
      clientId,
      platform: 'smartlead',
      leadId: resolvedLeadId,
      leadEmail,
      inboundMessage: inboundEffective,
      messageId: inboundMessageId,
    }, async (conn) => {
      const { rows: [inserted] } = await conn.query(
        `INSERT INTO pending_replies
          (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email, inbound_message, thread_context, classification, draft_reply, status, smartlead_email_stats_id, inbound_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [
          clientId, 'smartlead', resolvedCampaignId, resolvedCampaignName || null,
          resolvedLeadId, senderName, leadEmail, inboundEffective, JSON.stringify(threadContext),
          classification, '', suppressedReason ? 'suppressed' : 'pending', statsId,
          inboundMessageId || null,
        ]
      );
      return inserted;
    });
    if (claimed.duplicate) {
      console.log('[Webhook] SmartLead duplicate suppressed (insert race, async)', {
        clientId, existingId: claimed.existing?.id,
      });
      return;
    }
    replyRow = claimed.reply;
    if (referredContacts.length) await storeReferralCc(replyRow.id, referredContacts);
  } else {
    const { rows: [fresh] } = await db.query(
      'SELECT classification FROM pending_replies WHERE id = $1',
      [replyRow.id]
    );
    if (
      fresh
      && fresh.classification
      && fresh.classification !== classification
      && !classifyFromSmartlead(payload)
      && ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION', 'NOT_INTERESTED', 'OOO', 'WRONG_PERSON', 'REMOVE_ME'].includes(fresh.classification)
    ) {
      classification = fresh.classification;
    }
    await db.query(
      `UPDATE pending_replies
          SET campaign_id = $1, campaign_name = $2, lead_id = $3, lead_name = $4,
              inbound_message = $5, thread_context = $6, classification = $7,
              smartlead_email_stats_id = COALESCE($8, smartlead_email_stats_id),
              inbound_message_id = COALESCE(NULLIF(inbound_message_id, ''), $9),
              updated_at = now()
        WHERE id = $10`,
      [
        String(resolvedCampaignId), resolvedCampaignName || null, String(resolvedLeadId),
        senderName, inboundEffective, JSON.stringify(threadContext), classification,
        statsId, inboundMessageId || null, replyRow.id,
      ]
    );
    if (referredContacts.length) await storeReferralCc(replyRow.id, referredContacts);
  }

  await maybeForwardInboundReply({
    campaignId: resolvedCampaignId,
    campaignName: resolvedCampaignName,
    leadId: resolvedLeadId,
    leadEmail,
    leadName: senderName,
    inboundMessage: inboundEffective,
    messageId: inboundMessageId,
    threadContext,
  });

  if (suppressedReason) {
    console.log('[Webhook] SmartLead reply suppressed from Slack', { classification, reason: suppressedReason });
    await db.query(
      `UPDATE pending_replies
          SET status = 'suppressed', suppression_reason = $1, classification = $2, updated_at = now()
        WHERE id = $3`,
      [suppressedReason, classification, replyRow.id]
    );
    if (shouldAlertOther(suppressedReason, classification)) {
      await postOtherAlert({
        client, clientId, platform: 'smartlead', leadName: senderName, inboundMessage: inboundEffective,
        leadPhone: extractLeadPhone(smartleadLead, leadData, payload),
      });
    }
    return;
  }

  let policy = applyFactCheckToPolicy(
    applyClientDraftPolicy(client, leadEmail, { classification, draft: '', reasoning }),
    null,
  );
  let isDraft = policy.isDraft;
  let status = policy.status;

  if (!smartleadLead && !extractLeadPhone(leadData, payload) && leadEmail && client.smartlead_api_key) {
    smartleadLead = await smartlead.lookupLeadByEmail(client.smartlead_api_key, leadEmail)
      .then((f) => f && f.lead)
      .catch(() => null);
  }

  const slackCard = {
    replyId: replyRow.id,
    leadName: senderName,
    leadEmail,
    leadCompany: leadData.company_name || leadData.company || payload.company_name || payload.company || null,
    leadPhone: extractLeadPhone(smartleadLead, leadData, payload) || undefined,
    platform: 'smartlead',
    classification,
    draft: '',
    reasoning,
    needsReview: false,
    inboundMessage: inboundEffective,
    campaignDisplay: campaignDisplaySl,
    lastOutboundMessage: lastOutboundSl,
    repliedAt: replyRow.created_at,
    leadData,
    payload,
    linkedinUrl: leadData.linkedin_url || leadData.linkedinUrl || payload.linkedin_url || undefined,
    leadWebsite: leadData.website || leadData.company_website || leadData.company_url || undefined,
    replyAllCc: replyAll.cc,
    referredContacts,
  };

  const posted = await postProspectSlackCard({
    token: client.slack_bot_token,
    channelId: client.slack_channel_id,
    clientId,
    platform: 'smartlead',
    campaignId: resolvedCampaignId,
    leadId: resolvedLeadId,
    threadContext,
    isDraft,
    replyId: replyRow.id,
    card: slackCard,
  });

  if (!isDraft) {
    await db.query(
      `UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2`,
      [status, replyRow.id]
    );
    return;
  }

  const { promptBlock, slots } = await resolveVerifiedSchedulingSlots(client);
  let drafted = '';
  try {
    drafted = await draftOnly({
      classification,
      threadContext,
      inboundMessage: inboundEffective,
      leadName: greetName,
      voicePrompt: client.voice_prompt,
      bookingLink: client.booking_link,
      schedulingPromptBlock: promptBlock,
      digestTimezone: client.digest_timezone,
      platform: 'smartlead',
      clientName: client.name,
      clientId,
      draftMode: 'realtime',
      slots,
      referredContacts,
    });
  } catch (err) {
    console.error('[Webhook] SmartLead draft failed after card', { clientId, err: err.message });
  }
  if (!drafted && SMARTLEAD_DRAFT_ALWAYS.has(classification)) {
    // Every positive SmartLead reply gets a draft: one retry before giving up.
    try {
      drafted = await draftOnly({
        classification,
        threadContext,
        inboundMessage: inboundEffective,
        leadName: greetName,
        voicePrompt: client.voice_prompt,
        bookingLink: client.booking_link,
        schedulingPromptBlock: promptBlock,
        digestTimezone: client.digest_timezone,
        platform: 'smartlead',
        clientName: client.name,
        clientId,
        draftMode: 'realtime',
        referredContacts,
      });
    } catch (err) {
      console.error('[Webhook] SmartLead draft retry failed', { clientId, err: err.message });
    }
  }

  const { applyFactCheckToPolicy: applyFc, enforceDraftGrounding, factSourceText } = require('../utils/draft-fact-check');
  void applyFc;
  policy = applyFactCheckToPolicy(
    applyClientDraftPolicy(client, leadEmail, { classification, draft: drafted || '', reasoning }),
    result.factCheck,
  );
  if (drafted) {
    const sourceText = factSourceText({
      inboundMessage: inboundEffective,
      threadContext,
      leadName: greetName,
      clientName: client.name,
      schedulingPromptBlock: promptBlock,
      voicePrompt: client.voice_prompt,
    });
    const factCheck = await enforceDraftGrounding({
      draft: drafted,
      sourceText,
      regenerate: (claims) => draftOnly({
        classification,
        threadContext,
        inboundMessage: inboundEffective,
        leadName: greetName,
        voicePrompt: client.voice_prompt,
        bookingLink: client.booking_link,
        schedulingPromptBlock: promptBlock,
        digestTimezone: client.digest_timezone,
        platform: 'smartlead',
        clientName: client.name,
        clientId,
        draftMode: 'realtime',
        slots,
        factCheckRetryClaims: claims,
        referredContacts,
      }),
    });
    policy = applyFactCheckToPolicy(policy, factCheck);
    drafted = policy.draft;
    reasoning = policy.reasoning;
  }

  await db.query(
    `UPDATE pending_replies
        SET draft_reply = $1, classification = $2, status = $3, updated_at = now()
      WHERE id = $4`,
    [drafted || '', classification, policy.status, replyRow.id]
  );

  if (posted?.ts && drafted) {
    try {
      // Merge into the card's latest state: the late enrichment update may
      // already have filled LinkedIn / website / phone / ICP / location.
      await patchPostedCard({
        slackApi: slack,
        token: client.slack_bot_token,
        channelId: client.slack_channel_id,
        ts: posted.ts,
        isDraft: true,
        replyId: replyRow.id,
        base: { ...slackCard, ...(posted.identity ? {
          leadLinkedinUrl: posted.identity.linkedinUrl || undefined,
          leadWebsite: posted.identity.website || undefined,
        } : {}) },
        patch: { draft: drafted, reasoning, needsReview: policy.needsReview },
      });
    } catch (err) {
      console.warn('[Webhook] Slack draft update failed', { replyId: replyRow.id, err: err.message });
    }
  }

  if (policy.isDraft && classification === 'MEETING_PROPOSED') {
    await db.query(
      `INSERT INTO meetings (client_id, pending_reply_id, lead_name, lead_email, proposed_time, status)
       VALUES ($1, $2, $3, $4, $5, 'proposed')`,
      [clientId, replyRow.id, senderName, leadEmail, proposed_time]
    );
  }

  console.log('[Webhook] SmartLead processed async', { clientId, classification, replyId: replyRow.id });
}


// ─── HeyReach Webhook ────────────────────────────────────────────────
router.post('/webhook/heyreach/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const payload = req.body;

  console.log('[Webhook] HeyReach inbound', { clientId, payload: JSON.stringify(payload).slice(0, 4000) });

  try {
    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client || !client.active) {
      console.warn('[Webhook] Unknown or inactive client', { clientId });
      return res.status(200).json({ ok: true, skipped: true });
    }

    const hr = normalizeHeyreachPayload(payload);
    let {
      campaignId,
      campaignName: hrCampaignName,
      leadId,
      conversationId: hrConversationId,
      linkedinUrl,
      leadName,
      inboundMessage,
      listId,
      linkedinAccountId,
      senderId: hrSenderId,
      threadContext: normalizedThread,
    } = hr;
    if (looksLikeHtml(inboundMessage)) {
      inboundMessage = cleanInboundOrRaw(inboundMessage);
      if (!inboundMessage) {
        console.log('[Webhook] HeyReach blank inbound reply, skipped (no text to draft)', {
          clientId, campaignId, leadId, conversationId: hrConversationId, reason: 'empty_inbound',
        });
        return res.status(200).json({ ok: true, skipped: true, reason: 'empty_inbound' });
      }
    }

    console.log('[Webhook] HeyReach extracted', {
      clientId,
      client: client.name,
      campaignId,
      leadId,
      conversationId: hrConversationId,
      inboundLen: (inboundMessage || '').length,
      hasLinkedinUrl: !!linkedinUrl,
    });

    // Oct 30 2026: every LinkedIn reply posts a card. A missing API key or missing
    // ids used to drop the reply with a 200. Neither stops us from showing it:
    // the key only powers enrichment and sending, and a thread key can be
    // derived from the profile URL. No key just means no inbox enrichment.
    if (!client.heyreach_api_key) {
      console.warn('[Webhook] HeyReach client has no API key — posting without inbox enrichment', { clientId, client: client.name });
    }
    if (!leadId && !hrConversationId) {
      leadId = heyreachFallbackThreadKey({ linkedinUrl, leadName, inboundMessage });
      console.warn('[Webhook] HeyReach payload has no lead id or conversation id — using a derived thread key', {
        clientId, derived: true, hasLinkedinUrl: !!linkedinUrl,
      });
    }

    const dedupeKey = heyreachDedupeKey({
      clientId,
      campaignId,
      leadId,
      conversationId: hrConversationId,
      inboundMessage,
      linkedinUrl,
      listId,
      linkedinAccountId,
    });
    if (isHeyreachDuplicate(dedupeKey)) {
      console.log('[Webhook] HeyReach duplicate suppressed', { clientId, campaignId, leadId, conversationId: hrConversationId });
      return res.status(200).json({ ok: true, skipped: true, reason: 'duplicate' });
    }
    if (await heyreachDuplicateInDb({ clientId, campaignId, leadId, conversationId: hrConversationId, inboundMessage })) {
      console.log('[Webhook] HeyReach duplicate suppressed (db)', { clientId, campaignId, leadId, conversationId: hrConversationId });
      return res.status(200).json({ ok: true, skipped: true, reason: 'duplicate_db' });
    }

    let heyreachCampaignOk = true;
    if (campaignId && client.heyreach_api_key) {
      try {
        heyreachCampaignOk = await heyreach.verifyCampaignAccess(client.heyreach_api_key, campaignId);
      } catch (err) {
        // Cannot verify. A HeyReach API blip used to drop the reply. Show it.
        console.error('[Webhook] HeyReach campaign verification failed — posting anyway', { clientId, err: err.message });
        heyreachCampaignOk = true;
      }
      if (!heyreachCampaignOk) {
        // The campaign belongs to another client's workspace (wrong webhook URL),
        // so a card here would land in the wrong client's channel. Keep an audit row.
        console.warn('[Webhook] HeyReach campaign not in this workspace (wrong webhook URL or key)', {
          clientId, client: client.name, campaignId,
        });
        await recordSuppressedReply({
          clientId, platform: 'heyreach', campaignId, campaignName: hrCampaignName,
          leadId: leadId || hrConversationId, leadName, linkedinUrl,
          inboundMessage, threadContext: payload,
          classification: null, reason: 'campaign_not_in_client_workspace',
        });
        return res.status(200).json({ ok: true, skipped: true, reason: 'campaign_not_in_client_workspace' });
      }
    } else {
      console.log('[Webhook] HeyReach proceeding without campaign id (conversation_id present)', {
        clientId, conversationId: hrConversationId,
      });
    }

    let threadContext =
      (Array.isArray(normalizedThread) && normalizedThread.length
        ? normalizedThread
        : null) ||
      payload.conversationHistory ||
      payload.thread ||
      [{ role: 'prospect', message: inboundMessage || '(no message body)' }];

    const resolvedHrCampaignName =
      hrCampaignName || (payload.campaign && payload.campaign.name) || null;
    const campaignDisplayHr = formatCampaignDisplay(resolvedHrCampaignName, campaignId);
    let lastOutboundHr = heyreachLastOutboundFromThread(threadContext);

    await cancelForInboundReply({
      clientId,
      platform: 'heyreach',
      campaignId,
      leadId,
      conversationId: hrConversationId,
    });

    // Acknowledge quickly so HeyReach does not queue retries while we classify/Slack.
    res.status(200).json({ ok: true, accepted: true });

    setImmediate(async () => {
      try {
        // Webhook payloads can include only the latest reply. Enrich from inbox API so Slack
        // shows "Your last message" and the classifier sees the full context. The full
        // conversation is also what isColdInbound needs (campaign tags + who wrote first).
        let resolvedLeadName = leadName;
        let resolvedLinkedinUrl = linkedinUrl;
        let fullConv = null;

        if (hrConversationId && client.heyreach_api_key) {
          try {
            const full = await heyreach.findConversation(client.heyreach_api_key, {
              conversationId: hrConversationId,
              leadId,
              linkedinUrl,
            });
            if (full) {
              fullConv = full;
              const fromApi = heyreach.extractHeyreachLeadName(full);
              if (fromApi && fromApi !== heyreach.HEYREACH_LEAD_FALLBACK) {
                resolvedLeadName = fromApi;
              }
              resolvedLinkedinUrl = heyreach.extractHeyreachLinkedinUrl(full) || resolvedLinkedinUrl;
            }
            const fullMessages = Array.isArray(full?.messages) ? full.messages : [];
            if (fullMessages.length) {
              threadContext = fullMessages.map((m) => ({
                role: String(m.sender || '').toUpperCase() === 'ME' || m.is_reply === false ? 'us' : 'prospect',
                message: m.body || m.message || m.text || m.content || '',
                at: m.createdAt || m.creation_time || m.created_at || null,
              })).filter((m) => m.message);
              lastOutboundHr = heyreachLastOutboundFromThread(threadContext) || lastOutboundHr;
            }
          } catch (err) {
            console.warn('[Webhook] HeyReach conversation enrichment failed', {
              clientId, conversationId: hrConversationId, err: err.message,
            });
          }
        }

        // Skip slow Calendly/calendar network calls on the LinkedIn webhook path; include booking link guidance.
        const { promptBlock: schedulingPromptBlock } = await resolveVerifiedSchedulingSlots(client, { skipExternalFetch: true });

        let result;
        try {
          result = await classifyAndDraft(
            withKnownOutbound(threadContext, lastOutboundHr),
            inboundMessage,
            client.voice_prompt,
            client.booking_link,
            schedulingPromptBlock,
            {
              leadName: resolvedLeadName,
              digestTimezone: client.digest_timezone,
              platform: 'heyreach',
              clientId,
              leadId: leadId || hrConversationId,
              clientName: client.name,
              draftMode: 'realtime',
            },
          );
        } catch (err) {
          // classifyAndDraft is meant never to throw. If it does, the LinkedIn reply
          // still gets a card (no draft) instead of an error line and nothing else.
          console.error('[Classifier] Failed for HeyReach reply — posting as OTHER', { clientId, client: client.name, err: err.message });
          result = {
            classification: 'OTHER',
            draft: '',
            proposed_time: null,
            reasoning: `Classifier failed: ${err.message}`,
          };
        }

        let { classification, draft, proposed_time, reasoning } = result;
        const convForCold = fullConv
          ? { ...fullConv, campaignId: campaignId || fullConv.campaignId, campaign_id: campaignId || fullConv.campaign_id }
          : { campaignId, campaign_id: campaignId, campaign: payload.campaign };
        const coldInbound = isColdInbound(convForCold, threadContext);
        classification = applyPositiveIntentGuard(classification, inboundMessage).classification;
        // platform: 'heyreach' means this never suppresses (every LinkedIn reply gets a card).
        const hrSuppressed = slackChannelSuppressionReason({
          classification,
          inboundMessage,
          isColdInbound: coldInbound,
          pitchToUsProb: result.pitchToUsProb,
          platform: 'heyreach',
        });
        const contextWithMeta = {
          messages: threadContext,
          heyreach: {
            listId,
            linkedinAccountId,
            linkedinUrl: resolvedLinkedinUrl,
            conversationId: hrConversationId,
            senderId: hrSenderId,
            campaignName: resolvedHrCampaignName,
          },
        };

        if (hrSuppressed) {
          console.log('[Webhook] HeyReach reply suppressed from Slack', { leadName: resolvedLeadName, classification, reason: hrSuppressed });
          await recordSuppressedReply({
            clientId, platform: 'heyreach', campaignId, campaignName: resolvedHrCampaignName,
            leadId: leadId || hrConversationId,
            leadName: resolvedLeadName, linkedinUrl: resolvedLinkedinUrl,
            inboundMessage, threadContext: contextWithMeta,
            classification, reason: hrSuppressed,
          });
          return;
        }

        // HeyReach often has no email at ingest; policy applies when email is known.
        const policy = applyFactCheckToPolicy(
          applyClientDraftPolicy(client, null, { classification, draft, reasoning }),
          result.factCheck,
        );
        draft = policy.draft;
        reasoning = policy.reasoning;
        let isDraft = policy.isDraft;
        const status = policy.status;

        const leadIdForRow = leadId || hrConversationId;

        const claimed = await claimNewInbound({
          clientId,
          platform: 'heyreach',
          leadId: leadIdForRow,
          leadEmail: null,
          inboundMessage,
        }, async (conn) => {
          const { rows: [inserted] } = await conn.query(
            `INSERT INTO pending_replies
              (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, linkedin_url, inbound_message, thread_context, classification, draft_reply, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [clientId, 'heyreach', campaignId, resolvedHrCampaignName || null, leadIdForRow, resolvedLeadName, resolvedLinkedinUrl, inboundMessage, JSON.stringify(contextWithMeta), classification, draft, status]
          );
          return inserted;
        });
        if (claimed.duplicate) {
          console.log('[Webhook] HeyReach duplicate suppressed (insert race)', {
            clientId, leadId: leadIdForRow, existingId: claimed.existing?.id,
          });
          return;
        }
        const reply = claimed.reply;

        // Claimed once on phone_enrichment_status. Slack-card path is a no-op if
        // this already finished — webhook retries never pay twice.
        const enrichment = await enrichPendingReplyPhone(reply.id);
        const leadEmail = enrichment.email || null;
        if (enrichment.draftVariant === 'call_now_v1' && enrichment.draftReply && isDraft) {
          draft = enrichment.draftReply;
        }
        if (leadEmail) {
          const latePolicy = applyClientDraftPolicy(client, leadEmail, { classification, draft, reasoning });
          if (latePolicy.skippedDraft) {
            draft = latePolicy.draft;
            reasoning = latePolicy.reasoning;
            isDraft = false;
            console.log('[Webhook] HeyReach draft revoked by client policy after enrichment', {
              replyId: reply.id, reason: latePolicy.skipReason,
            });
          }
        }

        const slackCard = {
          replyId: reply.id,
          leadName: resolvedLeadName,
          leadEmail,
          linkedinUrl: resolvedLinkedinUrl || enrichment.linkedinUrl || undefined,
          leadWebsite: enrichment.website || hr.website || hr.company_website || undefined,
          leadCompany: hr.company || payload.company_name || payload.company || null,
          platform: 'heyreach',
          classification,
          draft,
          reasoning,
          needsReview: policy.needsReview,
          inboundMessage,
          campaignDisplay: campaignDisplayHr,
          lastOutboundMessage: lastOutboundHr,
          repliedAt: reply.created_at,
          leadData: hr,
          payload,
        };

        await postProspectSlackCard({
          token: client.slack_bot_token,
          channelId: client.slack_channel_id,
          clientId,
          platform: 'heyreach',
          campaignId,
          leadId: leadIdForRow,
          threadContext: contextWithMeta,
          isDraft,
          replyId: reply.id,
          card: slackCard,
        });

        if (classification === 'MEETING_PROPOSED') {
          await db.query(
            `INSERT INTO meetings (client_id, pending_reply_id, lead_name, lead_email, linkedin_url, proposed_time, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'proposed')`,
            [clientId, reply.id, resolvedLeadName, leadEmail, resolvedLinkedinUrl, proposed_time]
          );
        }

        console.log('[Webhook] HeyReach processed async', { clientId, classification, replyId: reply.id });
      } catch (bgErr) {
        console.error('[Webhook] HeyReach async handler error', { clientId, err: bgErr.message, stack: bgErr.stack });
      }
    });

  } catch (err) {
    console.error('[Webhook] HeyReach handler error', { clientId, err: err.message, stack: err.stack });
    res.status(200).json({ ok: true, error: 'internal error' });
  }
});

/**
 * Campaignintelligence booking page → stop ReplyHandler follow-ups.
 *
 * POST /webhook/booking-bridge
 * Authorization: Bearer <BOOKING_BRIDGE_WEBHOOK_SECRET>
 * Body: { event, treat_as_booked, email, name?, client_slug?, client_name?, campaign? }
 */
router.post('/webhook/booking-bridge', async (req, res) => {
  const {
    assertBookingBridgeSecret,
    handleBookingBridgeEvent,
  } = require('../services/booking-bridge');

  const auth = assertBookingBridgeSecret(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.error });
  }

  try {
    // Attendance tracking: a booking that carries its meeting link and time is recorded for the
    // Attendance bot. Best effort, never blocks or changes the follow-up stop below.
    try {
      await require('../services/meetstream-attendance').registerFromBridgePayload(req.body || {});
    } catch (attErr) {
      console.error('[Meetstream] register from bridge failed', { err: attErr.message });
    }
    const result = await handleBookingBridgeEvent(req.body || {});
    if (!result.ok) {
      return res.status(result.status || 400).json(result);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('[BookingBridge] handler error', { err: err.message, stack: err.stack });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.post('/webhook/inbound-forward', async (req, res) => {
  try {
    const { handleInboundForwardWebhook } = require('../services/inbound-forward');
    const result = await handleInboundForwardWebhook(req);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[InboundForward] webhook handler error', { err: err.message, stack: err.stack });
    return res.status(200).json({ ok: true, error: 'inbound_forward_failed' });
  }
});

module.exports = router;
module.exports.smartleadCategoryResult = smartleadCategoryResult;
module.exports.automatedNoticeResult = automatedNoticeResult;
module.exports.promoteReferral = promoteReferral;
module.exports.SMARTLEAD_DRAFT_ALWAYS = SMARTLEAD_DRAFT_ALWAYS;
module.exports.heyreachFallbackThreadKey = heyreachFallbackThreadKey;
