const { Router } = require('express');
const db = require('../db');
const { postProspectSlackCard } = require('../services/slack-reply-post');
const { formatCampaignDisplay } = require('../utils/campaign-display');
const { cancelPendingForLead } = require('../services/outbound-follow-up');
const { suppressUnpostedFollowUpInboxRows } = require('../services/reply-dedupe');

const router = Router();

function webhookUrls(clientId) {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + (process.env.PORT || 3000);
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return {
    smartlead_webhook_url: `${protocol}://${domain}/webhook/smartlead/${clientId}`,
    heyreach_webhook_url: `${protocol}://${domain}/webhook/heyreach/${clientId}`,
  };
}

function formatClient(client) {
  return { ...client, ...webhookUrls(client.id) };
}

function normalizeCcListField(value) {
  if (value == null) return null;
  const parts = String(value)
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'));
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.length ? out.join(', ') : null;
}

// Create client
router.post('/admin/clients', async (req, res) => {
  try {
    const {
      name, smartlead_api_key, heyreach_api_key, slack_bot_token,
      slack_channel_id, booking_link, calendly_personal_access_token, voice_prompt, digest_timezone,
      cc_email, cc_emails, cc_round_robin_emails,
    } = req.body;

    if (!name || !slack_bot_token || !slack_channel_id) {
      return res.status(400).json({ error: 'name, slack_bot_token, and slack_channel_id are required' });
    }

    const alwaysCc = normalizeCcListField(cc_emails || cc_email);
    const rr = normalizeCcListField(cc_round_robin_emails);
    const legacyCc = alwaysCc ? alwaysCc.split(',')[0].trim() : null;

    const { rows: [client] } = await db.query(
      `INSERT INTO clients (
         name, smartlead_api_key, heyreach_api_key, slack_bot_token, slack_channel_id,
         booking_link, calendly_personal_access_token, voice_prompt, digest_timezone,
         cc_email, cc_emails, cc_round_robin_emails
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        name,
        smartlead_api_key || null,
        heyreach_api_key || null,
        slack_bot_token,
        slack_channel_id,
        booking_link || null,
        calendly_personal_access_token || null,
        voice_prompt || '',
        digest_timezone || null,
        legacyCc,
        alwaysCc,
        rr,
      ]
    );

    console.log('[Admin] Client created', { id: client.id, name: client.name });
    res.status(201).json(formatClient(client));
  } catch (err) {
    console.error('[Admin] Create client error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// List clients
router.get('/admin/clients', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(rows.map(formatClient));
  } catch (err) {
    console.error('[Admin] List clients error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Update client
router.patch('/admin/clients/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const fields = req.body;
    const allowedFields = [
      'name', 'smartlead_api_key', 'heyreach_api_key', 'slack_bot_token',
      'slack_channel_id', 'booking_link', 'calendly_personal_access_token', 'voice_prompt',
      'active', 'digest_timezone', 'cc_email', 'cc_emails', 'cc_round_robin_emails',
    ];

    const updates = [];
    const values = [];
    let idx = 1;

    // Normalize list fields + keep legacy cc_email in sync with first always-CC address.
    if (Object.prototype.hasOwnProperty.call(fields, 'cc_emails')
      || Object.prototype.hasOwnProperty.call(fields, 'cc_email')) {
      const alwaysCc = normalizeCcListField(fields.cc_emails != null ? fields.cc_emails : fields.cc_email);
      fields.cc_emails = alwaysCc;
      fields.cc_email = alwaysCc ? alwaysCc.split(',')[0].trim() : null;
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'cc_round_robin_emails')) {
      fields.cc_round_robin_emails = normalizeCcListField(fields.cc_round_robin_emails);
    }

    for (const [key, value] of Object.entries(fields)) {
      if (allowedFields.includes(key)) {
        updates.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push(`updated_at = now()`);
    values.push(clientId);

    const { rows: [client] } = await db.query(
      `UPDATE clients SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log('[Admin] Client updated', { id: client.id, name: client.name });
    res.json(formatClient(client));
  } catch (err) {
    console.error('[Admin] Update client error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Insert a pending reply and post the real Approve / Edit & send Slack card.
 * Used to recover a reply the interested-only gate silenced.
 */
router.post('/admin/post-approval-card', async (req, res) => {
  const {
    clientId,
    leadName,
    leadEmail,
    campaignId,
    campaignName,
    leadId,
    inboundMessage,
    draft,
    lastOutboundMessage,
    classification = 'INTERESTED',
    reasoning = 'Recovered for Slack approval.',
  } = req.body || {};

  if (!clientId || !leadName || !inboundMessage || !draft || !campaignId || !leadId) {
    return res.status(400).json({
      error: 'clientId, leadName, inboundMessage, draft, campaignId, and leadId are required',
    });
  }

  try {
    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client || !client.active) {
      return res.status(404).json({ error: 'client not found or inactive' });
    }

    const lastOut = String(lastOutboundMessage || '').trim();
    const threadContext = lastOut
      ? [
        { role: 'us', message: lastOut },
        { role: 'prospect', message: inboundMessage },
      ]
      : [{ role: 'prospect', message: inboundMessage }];
    const display = formatCampaignDisplay(campaignName, campaignId) || String(campaignId);

    const { rows: [reply] } = await db.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email,
         inbound_message, thread_context, classification, draft_reply, status)
       VALUES ($1, 'smartlead', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending') RETURNING *`,
      [
        clientId,
        String(campaignId),
        campaignName || null,
        String(leadId),
        leadName,
        leadEmail || null,
        inboundMessage,
        JSON.stringify(threadContext),
        classification,
        draft,
      ]
    );

    const slackResult = await postProspectSlackCard({
      token: client.slack_bot_token,
      channelId: client.slack_channel_id,
      clientId,
      platform: 'smartlead',
      campaignId: String(campaignId),
      leadId: String(leadId),
      threadContext,
      isDraft: true,
      replyId: reply.id,
      postInThread: false,
      card: {
        replyId: reply.id,
        leadName,
        leadEmail: leadEmail || null,
        platform: 'smartlead',
        classification,
        draft,
        reasoning,
        inboundMessage,
        campaignDisplay: display,
        lastOutboundMessage: lastOut || undefined,
      },
    });

    return res.status(201).json({
      ok: true,
      replyId: reply.id,
      slackMessageTs: slackResult.ts,
    });
  } catch (err) {
    console.error('[Admin] post-approval-card error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Cancel a follow-up cadence and stop poller recovery of FOLLOW_UP inbox rows.
 * POST { leadEmail } or { leadName }
 */
router.post('/admin/stop-follow-ups', async (req, res) => {
  const { leadEmail, leadName, clientId } = req.body || {};
  if (!leadEmail && !leadName) {
    return res.status(400).json({ error: 'leadEmail or leadName is required' });
  }
  try {
    const retired = await suppressUnpostedFollowUpInboxRows();
    const stopped = await cancelPendingForLead({ clientId: clientId || null, leadEmail, leadName });
    console.log('[Admin] stop-follow-ups', { leadEmail, leadName, retired, ...stopped });
    return res.json({ ok: true, retiredUnpostedFollowUps: retired, ...stopped });
  } catch (err) {
    console.error('[Admin] stop-follow-ups error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
