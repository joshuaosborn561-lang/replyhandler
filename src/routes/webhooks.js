const { Router } = require('express');
const db = require('../db');
const smartlead = require('../services/smartlead');
const heyreach = require('../services/heyreach');
const { classifyAndDraft, DRAFT_CLASSIFICATIONS } = require('../services/classifier');
const { profileToEmail } = require('../services/leadmagic');
const slack = require('../services/slack');
const { resolveVerifiedSchedulingSlots } = require('../services/scheduling-slots');

const router = Router();

// ─── SmartLead Webhook ───────────────────────────────────────────────
router.post('/webhook/smartlead/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const payload = req.body;

  console.log('[Webhook] SmartLead inbound', { clientId, payload: JSON.stringify(payload).slice(0, 500) });

  try {
    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client || !client.active) {
      console.warn('[Webhook] Unknown or inactive client', { clientId });
      return res.status(200).json({ ok: true, skipped: true });
    }

    const campaignId = payload.campaign_id || payload.campaignId;
    const leadId = payload.lead_id || payload.leadId;
    const leadEmail = payload.email || payload.lead_email || payload.to_email;
    const leadName = payload.name || payload.lead_name || payload.first_name || 'Unknown';
    const inboundMessage = payload.reply || payload.message || payload.body || '';

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

    // Fetch full thread history
    let threadContext;
    try {
      threadContext = await smartlead.getThreadHistory(client.smartlead_api_key, campaignId, leadId);
    } catch (err) {
      console.error('[Webhook] Failed to fetch SmartLead thread', { clientId, client: client.name, err: err.message });
      threadContext = [{ role: 'prospect', message: inboundMessage }];
    }

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
      console.error('[Classifier] Failed for SmartLead reply', { clientId, client: client.name, err: err.message });
      await slack.postError(client.slack_bot_token, client.slack_channel_id, {
        leadName, platform: 'smartlead', error: err.message,
      });
      return res.status(200).json({ ok: true, error: 'classifier failed' });
    }

    const { classification, draft, proposed_time, reasoning } = result;
    const isDraft = DRAFT_CLASSIFICATIONS.includes(classification);
    const status = isDraft ? 'pending' : 'alert_only';

    const { rows: [reply] } = await db.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, lead_id, lead_name, lead_email, inbound_message, thread_context, classification, draft_reply, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [clientId, 'smartlead', campaignId, leadId, leadName, leadEmail, inboundMessage, JSON.stringify(threadContext), classification, draft, status]
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
        classification, draft, reasoning, inboundMessage,
      });
      await db.query('UPDATE pending_replies SET slack_message_ts = $1 WHERE id = $2', [slackResult.ts, reply.id]);

    } else if (classification === 'REMOVE_ME') {
      try {
        const unsubUrl = `https://server.smartlead.ai/api/v1/campaigns/${campaignId}/leads/${leadId}/unsubscribe?api_key=${encodeURIComponent(client.smartlead_api_key)}`;
        await fetch(unsubUrl, { method: 'POST' });
        console.log('[Webhook] Unsubscribed lead in SmartLead', { leadName, leadEmail, campaignId });
      } catch (err) {
        console.error('[Webhook] Failed to unsubscribe in SmartLead', { err: err.message });
      }

      await slack.postAlert(client.slack_bot_token, client.slack_channel_id, {
        leadName, platform: 'smartlead', classification, inboundMessage, reasoning,
      });

    } else {
      await slack.postAlert(client.slack_bot_token, client.slack_channel_id, {
        leadName, platform: 'smartlead', classification, inboundMessage, reasoning,
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

  console.log('[Webhook] HeyReach inbound', { clientId, payload: JSON.stringify(payload).slice(0, 500) });

  try {
    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client || !client.active) {
      console.warn('[Webhook] Unknown or inactive client', { clientId });
      return res.status(200).json({ ok: true, skipped: true });
    }

    const campaignId = payload.campaignId || payload.campaign_id;
    const leadId = payload.leadId || payload.lead_id;
    const linkedinUrl = payload.linkedinUrl || payload.linkedin_url || payload.profileUrl;
    const leadName = payload.name || payload.lead_name || payload.firstName || 'Unknown';
    const inboundMessage = payload.message || payload.reply || payload.body || '';
    const listId = payload.listId || payload.list_id;
    const linkedinAccountId = payload.linkedinAccountId || payload.linkedin_account_id;

    if (!client.heyreach_api_key) {
      console.warn('[Webhook] HeyReach skipped — no API key on client', { clientId, client: client.name });
      return res.status(200).json({ ok: true, skipped: true, reason: 'no_heyreach_api_key' });
    }

    if (!campaignId) {
      console.warn('[Webhook] HeyReach skipped — missing campaign id (cannot tie to client campaigns)', { clientId });
      return res.status(200).json({ ok: true, skipped: true, reason: 'missing_campaign_id' });
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

    const threadContext = payload.conversationHistory || payload.thread || [{ role: 'prospect', message: inboundMessage }];

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
    const isDraft = DRAFT_CLASSIFICATIONS.includes(classification);
    const status = isDraft ? 'pending' : 'alert_only';

    const contextWithMeta = {
      messages: threadContext,
      heyreach: { listId, linkedinAccountId, linkedinUrl },
    };

    const { rows: [reply] } = await db.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, lead_id, lead_name, linkedin_url, inbound_message, thread_context, classification, draft_reply, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [clientId, 'heyreach', campaignId, leadId, leadName, linkedinUrl, inboundMessage, JSON.stringify(contextWithMeta), classification, draft, status]
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
      });
      await db.query('UPDATE pending_replies SET slack_message_ts = $1 WHERE id = $2', [slackResult.ts, reply.id]);

    } else if (classification === 'REMOVE_ME') {
      await slack.postAlert(client.slack_bot_token, client.slack_channel_id, {
        leadName, platform: 'heyreach', classification, inboundMessage, reasoning,
      });

    } else {
      await slack.postAlert(client.slack_bot_token, client.slack_channel_id, {
        leadName, platform: 'heyreach', classification, inboundMessage, reasoning,
      });
    }

    res.status(200).json({ ok: true, classification, replyId: reply.id });

  } catch (err) {
    console.error('[Webhook] HeyReach handler error', { clientId, err: err.message, stack: err.stack });
    res.status(200).json({ ok: true, error: 'internal error' });
  }
});

module.exports = router;
