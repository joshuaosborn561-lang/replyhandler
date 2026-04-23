const { Router } = require('express');
const db = require('../db');
const smartlead = require('../services/smartlead');
const heyreach = require('../services/heyreach');
const { classifyAndDraft, DRAFT_CLASSIFICATIONS } = require('../services/classifier');
const { profileToEmail } = require('../services/leadmagic');
const slack = require('../services/slack');
const { resolveVerifiedSchedulingSlots } = require('../services/scheduling-slots');
const { cancelForInboundReply } = require('../services/outbound-follow-up');
const {
  stripHtmlToText,
  stripEmailQuotePrefix,
  latestInboundFromSmartleadHistory,
  lastOutboundBodyFromSmartleadHistory,
  isLikelyDuplicateOfOutbound,
  parseInboundFromPayload,
  SMARTLEAD_NON_REPLY_EVENTS,
  looksLikeOutOfOffice,
  looksLikeWrongPerson,
  looksLikeNotInterested,
  smartleadWebhookEnhancementsEnabled,
} = require('../utils/smartlead-webhook-helpers');

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

function formatCampaignDisplay(campaignName, campaignId) {
  const id = campaignId != null ? String(campaignId).trim() : '';
  const name = campaignName != null ? String(campaignName).trim() : '';
  if (name && id) return `${name} (${id})`;
  if (name) return name;
  if (id) return `Campaign ${id}`;
  return 'Campaign (unknown)';
}

function smartleadCampaignName(payload) {
  const p = payload || {};
  return (
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
    p.campaign?.id ??
    campaign?.id ??
    campaign?.campaignId ??
    null;

  const campaignName =
    p.campaign_name ||
    p.campaignName ||
    campaign?.name ||
    null;

  const conversationId = p.conversation_id || p.conversationId || null;

  const leadId =
    p.leadId ??
    p.lead_id ??
    p.lead?.id ??
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

  const leadName =
    (typeof p.name === 'string' && p.name) ||
    (typeof p.lead_name === 'string' && p.lead_name) ||
    (typeof p.firstName === 'string' && p.firstName) ||
    [fromProspect?.first_name, fromProspect?.last_name].filter(Boolean).join(' ').trim() ||
    (typeof fromProspect?.full_name === 'string' && fromProspect.full_name) ||
    (typeof p.contact?.full_name === 'string' && p.contact.full_name) ||
    (typeof p.profile?.full_name === 'string' && p.profile.full_name) ||
    'LinkedIn prospect';

  const linkedinUrl =
    p.linkedinUrl ||
    p.linkedin_url ||
    p.profileUrl ||
    fromProspect?.linkedin_url ||
    fromProspect?.linkedinUrl ||
    fromProspect?.profile_url ||
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
  };
}

// ─── SmartLead Webhook ───────────────────────────────────────────────
router.post('/webhook/smartlead/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const payload = req.body;

  console.log('[Webhook] SmartLead inbound', { clientId, payload: JSON.stringify(payload).slice(0, 4000) });

  try {
    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
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

    const campaignId =
      payload.campaign_id ||
      payload.campaignId ||
      payload.campaign?.id ||
      leadData.campaign_id ||
      leadData.campaignId;

    const leadId =
      payload.lead_id ||
      payload.leadId ||
      payload.lead?.id ||
      leadData.lead_id ||
      leadData.leadId ||
      leadData.id ||
      // SmartLead EMAIL_REPLY shape:
      payload.sl_email_lead_id ||
      payload.slEmailLeadId ||
      payload.sl_email_lead_map_id ||
      payload.slEmailLeadMapId;

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
      payload.name ||
      payload.lead_name ||
      payload.first_name ||
      payload.to_name ||
      payload.toName ||
      (leadData.first_name ? `${leadData.first_name} ${leadData.last_name || ''}`.trim() : null) ||
      leadData.name ||
      payload.lead?.first_name ||
      'Unknown';

    if (slEnhance) {
      const ev = String(
        payload.event_type || payload.eventType || payload.event || payload.webhook_event || payload.type || ''
      ).toUpperCase();
      if (ev && SMARTLEAD_NON_REPLY_EVENTS.has(ev)) {
        console.log('[Webhook] SmartLead skipped non-reply event', { clientId, event: ev });
        return res.status(200).json({ ok: true, skipped: true, reason: 'non_reply_event', event: ev });
      }
    }

    const inboundMessage = slEnhance
      ? parseInboundFromPayload(replyObj, payload)
      : (
          (replyObj && typeof replyObj === 'object' ? (replyObj.body || replyObj.message || replyObj.text) : replyObj) ||
          payload.reply_text ||
          payload.message ||
          payload.body ||
          ''
        );

    console.log('[Webhook] SmartLead extracted', {
      clientId,
      campaignId,
      leadId,
      hasLeadData: !!payload.lead_data,
      hasReplyObj: !!replyObj,
    });

    if (!campaignId || !leadId) {
      console.error('[Webhook] SmartLead payload missing campaign_id or lead_id', { clientId });
      return res.status(200).json({ ok: true, error: 'missing required fields' });
    }

    if (!client.smartlead_api_key) {
      console.warn('[Webhook] SmartLead skipped — no API key on client', { clientId, client: client.name });
      return res.status(200).json({ ok: true, skipped: true, reason: 'no_smartlead_api_key' });
    }

    const campaignOk = await smartlead.verifyCampaignAccess(client.smartlead_api_key, campaignId);
    if (!campaignOk) {
      console.warn('[Webhook] SmartLead campaign not accessible for this client (wrong URL or wrong account)', {
        clientId, client: client.name, campaignId,
      });
      return res.status(200).json({ ok: true, skipped: true, reason: 'campaign_not_in_client_account' });
    }

    await cancelForInboundReply({
      clientId,
      platform: 'smartlead',
      campaignId,
      leadId,
      conversationId: null,
    });

    // Fetch full thread history AND resolve the email_stats_id we'll need at send time.
    let threadContext;
    let smartleadEmailStatsId = null;
    try {
      threadContext = await smartlead.getThreadHistory(client.smartlead_api_key, campaignId, leadId);
      smartleadEmailStatsId = smartlead.extractStatsIdFromHistory(threadContext);
      console.log('[Webhook] SmartLead resolved stats_id', { clientId, campaignId, leadId, emailStatsId: smartleadEmailStatsId });
    } catch (err) {
      console.error('[Webhook] Failed to fetch SmartLead thread', { clientId, client: client.name, err: err.message });
      let fallbackMsg = String(inboundMessage || '').trim();
      if (slEnhance && fallbackMsg) {
        fallbackMsg = stripEmailQuotePrefix(fallbackMsg);
        fallbackMsg = stripHtmlToText(fallbackMsg) || fallbackMsg;
      }
      threadContext = [{ role: 'prospect', message: fallbackMsg || '(could not load thread from SmartLead)' }];
    }

    let inboundEffective = String(inboundMessage || '').trim();
    if (slEnhance && inboundEffective) {
      inboundEffective = stripEmailQuotePrefix(inboundEffective);
      inboundEffective = stripHtmlToText(inboundEffective) || inboundEffective;
    }

    if (slEnhance && threadContext && typeof threadContext === 'object' && !Array.isArray(threadContext)) {
      const fromHist = latestInboundFromSmartleadHistory(threadContext, leadEmail);
      const lastSentPlain = lastOutboundBodyFromSmartleadHistory(threadContext);
      if (fromHist) {
        const webhookLooksDup = lastSentPlain && isLikelyDuplicateOfOutbound(inboundEffective, lastSentPlain);
        if (!inboundEffective || webhookLooksDup) {
          inboundEffective = fromHist;
          console.log('[Webhook] SmartLead inbound from message-history', {
            clientId, campaignId, leadId, replacedWebhookDup: !!webhookLooksDup, len: inboundEffective.length,
          });
        }
      } else if (lastSentPlain && isLikelyDuplicateOfOutbound(inboundEffective, lastSentPlain)) {
        inboundEffective = '';
      }
    }

    if (!inboundEffective) {
      console.warn('[Webhook] SmartLead could not resolve prospect reply text', { clientId, campaignId, leadId, leadEmail });
      await slack.postError(client.slack_bot_token, client.slack_channel_id, {
        leadName: `${leadName} (SmartLead)`,
        platform: 'smartlead',
        error:
          'No usable reply body from webhook or message-history. Reply manually in SmartLead.',
      });
      return res.status(200).json({ ok: true, error: 'empty_inbound_after_history' });
    }

    const campaignDisplaySl = formatCampaignDisplay(smartleadCampaignName(payload), campaignId);
    const lastOutboundSl =
      smartleadLastOutboundFromPayload(payload) ||
      (threadContext && typeof threadContext === 'object' && !Array.isArray(threadContext)
        ? lastOutboundBodyFromSmartleadHistory(threadContext)
        : '');

    const { promptBlock: schedulingPromptBlock } = await resolveVerifiedSchedulingSlots(client);

    let result;
    try {
      result = await classifyAndDraft(
        threadContext,
        inboundEffective,
        client.voice_prompt,
        client.booking_link,
        schedulingPromptBlock
      );
    } catch (err) {
      console.error('[Classifier] Failed for SmartLead reply', { clientId, client: client.name, err: err.message });
      await slack.postError(client.slack_bot_token, client.slack_channel_id, {
        leadName, platform: 'smartlead', error: err.message,
      });
      return res.status(200).json({ ok: true, error: 'classifier failed' });
    }

    const { classification, draft, proposed_time, reasoning } = result;
    // Suppress out-of-office / auto-replies even if the classifier misses.
    if (classification === 'OOO' || looksLikeOutOfOffice(inboundEffective)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'ooo' });
    }
    // Suppress "wrong person / no longer employed" redirects (treat as WRONG_PERSON but no Slack noise).
    if (classification === 'WRONG_PERSON' || looksLikeWrongPerson(inboundEffective)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'wrong_person' });
    }
    // Suppress clear negative "not interested" replies (no Slack noise).
    if (classification === 'NOT_INTERESTED' || looksLikeNotInterested(inboundEffective)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'not_interested' });
    }
    if (classification === 'REMOVE_ME') {
      // Silently unsubscribe — do not post to Slack / channel.
      try {
        const unsubUrl = `https://server.smartlead.ai/api/v1/campaigns/${campaignId}/leads/${leadId}/unsubscribe?api_key=${encodeURIComponent(client.smartlead_api_key)}`;
        await fetch(unsubUrl, { method: 'POST' });
        console.log('[Webhook] Unsubscribed lead in SmartLead', { leadName, leadEmail, campaignId });
      } catch (err) {
        console.error('[Webhook] Failed to unsubscribe in SmartLead', { err: err.message });
      }
      return res.status(200).json({ ok: true, skipped: true, reason: 'remove_me' });
    }
    const isDraft = DRAFT_CLASSIFICATIONS.includes(classification);
    const status = isDraft ? 'pending' : 'alert_only';

    const { rows: [reply] } = await db.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, lead_id, lead_name, lead_email, inbound_message, thread_context, classification, draft_reply, status, smartlead_email_stats_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [clientId, 'smartlead', campaignId, leadId, leadName, leadEmail, inboundEffective, JSON.stringify(threadContext), classification, draft, status, smartleadEmailStatsId]
    );

    if (isDraft) {
      // Track meetings separately for reporting
      if (classification === 'MEETING_PROPOSED') {
        await db.query(
          `INSERT INTO meetings (client_id, pending_reply_id, lead_name, lead_email, proposed_time, status)
           VALUES ($1, $2, $3, $4, $5, 'proposed')`,
          [clientId, reply.id, leadName, leadEmail, proposed_time]
        );
      }

      const slackResult = await slack.postDraftApproval(client.slack_bot_token, client.slack_channel_id, {
        replyId: reply.id, leadName, leadEmail, platform: 'smartlead',
        classification, draft, reasoning, inboundMessage: inboundEffective,
        campaignDisplay: campaignDisplaySl,
        lastOutboundMessage: lastOutboundSl,
      });
      await db.query('UPDATE pending_replies SET slack_message_ts = $1 WHERE id = $2', [slackResult.ts, reply.id]);

    } else {
      await slack.postAlert(client.slack_bot_token, client.slack_channel_id, {
        leadName, platform: 'smartlead', classification, inboundMessage: inboundEffective, reasoning,
        campaignDisplay: campaignDisplaySl,
        lastOutboundMessage: lastOutboundSl,
      });
    }

    res.status(200).json({ ok: true, classification, replyId: reply.id });

  } catch (err) {
    console.error('[Webhook] SmartLead handler error', { clientId, err: err.message, stack: err.stack });
    res.status(200).json({ ok: true, error: 'internal error' });
  }
});

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
    const {
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

    console.log('[Webhook] HeyReach extracted', {
      clientId,
      client: client.name,
      campaignId,
      leadId,
      conversationId: hrConversationId,
      inboundLen: (inboundMessage || '').length,
      hasLinkedinUrl: !!linkedinUrl,
    });

    if (!client.heyreach_api_key) {
      console.warn('[Webhook] HeyReach skipped — no API key on client', { clientId, client: client.name });
      return res.status(200).json({ ok: true, skipped: true, reason: 'no_heyreach_api_key' });
    }

    if (!campaignId) {
      console.warn('[Webhook] HeyReach skipped — missing campaign id (cannot tie to client campaigns)', { clientId });
      return res.status(200).json({ ok: true, skipped: true, reason: 'missing_campaign_id' });
    }

    if (!leadId && !hrConversationId) {
      console.warn('[Webhook] HeyReach skipped — missing lead id and conversation_id', { clientId });
      return res.status(200).json({ ok: true, skipped: true, reason: 'missing_thread_ids' });
    }

    let heyreachCampaignOk = false;
    try {
      heyreachCampaignOk = await heyreach.verifyCampaignAccess(client.heyreach_api_key, campaignId);
    } catch (err) {
      console.error('[Webhook] HeyReach campaign verification failed', { clientId, err: err.message });
      return res.status(200).json({ ok: true, skipped: true, reason: 'heyreach_api_error' });
    }
    if (!heyreachCampaignOk) {
      console.warn('[Webhook] HeyReach campaign not in this workspace (wrong webhook URL or key)', {
        clientId, client: client.name, campaignId,
      });
      return res.status(200).json({ ok: true, skipped: true, reason: 'campaign_not_in_client_workspace' });
    }

    await cancelForInboundReply({
      clientId,
      platform: 'heyreach',
      campaignId,
      leadId,
      conversationId: hrConversationId,
    });

    const threadContext =
      (Array.isArray(normalizedThread) && normalizedThread.length
        ? normalizedThread
        : null) ||
      payload.conversationHistory ||
      payload.thread ||
      [{ role: 'prospect', message: inboundMessage || '(no message body)' }];

    const campaignDisplayHr = formatCampaignDisplay(
      hrCampaignName || (payload.campaign && payload.campaign.name),
      campaignId
    );
    const lastOutboundHr = heyreachLastOutboundFromThread(threadContext);

    const { promptBlock: schedulingPromptBlock } = await resolveVerifiedSchedulingSlots(client);

    let result;
    try {
      result = await classifyAndDraft(
        threadContext,
        inboundMessage,
        client.voice_prompt,
        client.booking_link,
        schedulingPromptBlock
      );
    } catch (err) {
      console.error('[Classifier] Failed for HeyReach reply', { clientId, client: client.name, err: err.message });
      await slack.postError(client.slack_bot_token, client.slack_channel_id, {
        leadName, platform: 'heyreach', error: err.message,
      });
      return res.status(200).json({ ok: true, error: 'classifier failed' });
    }

    const { classification, draft, proposed_time, reasoning } = result;
    // Suppress out-of-office / auto-replies even if the classifier misses.
    if (classification === 'OOO' || looksLikeOutOfOffice(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'ooo' });
    }
    if (classification === 'WRONG_PERSON' || looksLikeWrongPerson(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'wrong_person' });
    }
    if (classification === 'NOT_INTERESTED' || looksLikeNotInterested(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'not_interested' });
    }
    if (classification === 'REMOVE_ME') {
      // Do not post unsubscribe notifications to Slack.
      return res.status(200).json({ ok: true, skipped: true, reason: 'remove_me' });
    }
    const isDraft = DRAFT_CLASSIFICATIONS.includes(classification);
    const status = isDraft ? 'pending' : 'alert_only';

    const contextWithMeta = {
      messages: threadContext,
      heyreach: {
        listId,
        linkedinAccountId,
        linkedinUrl,
        conversationId: hrConversationId,
        senderId: hrSenderId,
        campaignName: hrCampaignName || (payload.campaign && payload.campaign.name) || null,
      },
    };

    const leadIdForRow = leadId || hrConversationId;

    const { rows: [reply] } = await db.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, lead_id, lead_name, linkedin_url, inbound_message, thread_context, classification, draft_reply, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [clientId, 'heyreach', campaignId, leadIdForRow, leadName, linkedinUrl, inboundMessage, JSON.stringify(contextWithMeta), classification, draft, status]
    );

    if (isDraft) {
      // For MEETING_PROPOSED on LinkedIn, look up email for meeting tracking
      let leadEmail = null;
      if (classification === 'MEETING_PROPOSED' && linkedinUrl) {
        try {
          leadEmail = await profileToEmail(linkedinUrl);
          console.log('[LeadMagic] Email lookup result', { linkedinUrl, email: leadEmail });
          if (leadEmail) {
            await db.query('UPDATE pending_replies SET lead_email = $1 WHERE id = $2', [leadEmail, reply.id]);
          }
        } catch (err) {
          console.error('[LeadMagic] profileToEmail failed', { linkedinUrl, err: err.message });
        }

        await db.query(
          `INSERT INTO meetings (client_id, pending_reply_id, lead_name, lead_email, linkedin_url, proposed_time, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'proposed')`,
          [clientId, reply.id, leadName, leadEmail, linkedinUrl, proposed_time]
        );
      }

      const slackResult = await slack.postDraftApproval(client.slack_bot_token, client.slack_channel_id, {
        replyId: reply.id, leadName, leadEmail, platform: 'heyreach',
        classification, draft, reasoning, inboundMessage,
        campaignDisplay: campaignDisplayHr,
        lastOutboundMessage: lastOutboundHr,
      });
      await db.query('UPDATE pending_replies SET slack_message_ts = $1 WHERE id = $2', [slackResult.ts, reply.id]);

    } else {
      await slack.postAlert(client.slack_bot_token, client.slack_channel_id, {
        leadName, platform: 'heyreach', classification, inboundMessage, reasoning,
        campaignDisplay: campaignDisplayHr,
        lastOutboundMessage: lastOutboundHr,
      });
    }

    res.status(200).json({ ok: true, classification, replyId: reply.id });

  } catch (err) {
    console.error('[Webhook] HeyReach handler error', { clientId, err: err.message, stack: err.stack });
    res.status(200).json({ ok: true, error: 'internal error' });
  }
});

module.exports = router;
