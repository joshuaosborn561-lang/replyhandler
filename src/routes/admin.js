const { Router } = require('express');
const db = require('../db');
const { postProspectSlackCard } = require('../services/slack-reply-post');
const { formatCampaignDisplay } = require('../utils/campaign-display');
const {
  portalContactEmail,
  provisionClientToPortal,
  provisionAllClients,
} = require('../services/portal-provision');
const { normalizeClientBooking } = require('../utils/booking-bridge-destinations');
const {
  ensureClientIcp,
  backfillMissingClientIcp,
  summarizeIcpResult,
} = require('../services/client-icp-profile');
const { regradeNoIcpCards } = require('../services/regrade-no-icp-cards');
const { resurfaceSuppressedReplies, parseDays, parseDryRun } = require('../services/resurface-suppressed');

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
      name, smartlead_api_key, heyreach_api_key, allo_api_key, slack_bot_token,
      slack_channel_id, booking_link, voice_prompt, digest_timezone,
      cc_email, cc_emails, cc_round_robin_emails, contact_email,
    } = req.body;

    if (!name || !slack_bot_token || !slack_channel_id) {
      return res.status(400).json({ error: 'name, slack_bot_token, and slack_channel_id are required' });
    }

    const alwaysCc = normalizeCcListField(cc_emails || cc_email);
    const rr = normalizeCcListField(cc_round_robin_emails);
    const legacyCc = alwaysCc ? alwaysCc.split(',')[0].trim() : null;

    const contactEmail = portalContactEmail({ cc_emails: alwaysCc, cc_email: legacyCc });
    const booked = normalizeClientBooking({ name, booking_link });

    const { rows: [client] } = await db.query(
      `INSERT INTO clients (
         name, smartlead_api_key, heyreach_api_key, allo_api_key, slack_bot_token, slack_channel_id,
         booking_link, booking_destination_url, voice_prompt, digest_timezone,
         cc_email, cc_emails, cc_round_robin_emails, contact_email
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        name,
        smartlead_api_key || null,
        heyreach_api_key || null,
        allo_api_key || null,
        slack_bot_token,
        slack_channel_id,
        booked.booking_link || null,
        booked.booking_destination_url || null,
        voice_prompt || '',
        digest_timezone || null,
        legacyCc,
        alwaysCc,
        rr,
        contactEmail,
      ]
    );

    console.log('[Admin] Client created', { id: client.id });
    let icp;
    try {
      icp = summarizeIcpResult(await ensureClientIcp(client, { db }));
    } catch (err) {
      console.warn('[Admin] ICP ensure failed', { err: err.message });
      icp = { status: 'needs_review', reason: 'ensure_failed', env_needed: null, transcript_count: 0 };
    }
    const portal = await provisionClientToPortal(client);
    res.status(201).json({
      ...formatClient(client),
      icp,
      portal_login_link: portal.loginLink || null,
      portal_warning: portal.warning || null,
      portal_synced: !!portal.ok,
    });
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

// One-time backfill: push every existing client to the portal.
router.post('/admin/clients/sync-portal', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM clients
        WHERE active IS DISTINCT FROM false
        ORDER BY created_at ASC`
    );
    for (const client of rows) {
      const derived = portalContactEmail(client);
      if (derived !== (client.contact_email || null)) {
        await db.query(
          `UPDATE clients SET contact_email = $1, updated_at = now() WHERE id = $2`,
          [derived, client.id]
        );
        client.contact_email = derived;
      }
    }
    const results = await provisionAllClients(rows);
    const ok = results.filter((r) => r.ok).length;
    console.log('[Admin] Portal sync-all finished', { total: results.length, ok });
    res.json({ ok: true, total: results.length, synced: ok, results });
  } catch (err) {
    console.error('[Admin] Portal sync-all error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Backfill ICP profiles for existing clients that have none.
router.post('/admin/clients/backfill-icp', async (req, res) => {
  try {
    const dryRun = /^(1|true|yes)$/i.test(String(req.query.dry || req.body?.dry || ''));
    const counts = await backfillMissingClientIcp({ db, dryRun });
    console.log('[Admin] ICP backfill finished', counts);
    res.json({ ok: true, ...counts });
  } catch (err) {
    console.error('[Admin] ICP backfill error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Rebuild one client's ICP. force=true (default) ignores an existing
 * skipped_existing / ready row and re-searches Fireflies.
 * Counts only; re-grades last-3-day "no ICP" cards in place when ready.
 */
router.post('/admin/clients/:clientId/rebuild-icp', async (req, res) => {
  try {
    const forceRaw = req.query.force ?? req.body?.force;
    const force = forceRaw == null ? true : /^(1|true|yes|on)$/i.test(String(forceRaw));
    const { rows: [client] } = await db.query(
      'SELECT * FROM clients WHERE id = $1',
      [req.params.clientId],
    );
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const result = await ensureClientIcp(client, { db, force });
    let regrade = { scanned: 0, updated: 0 };
    if (result.status === 'ready') {
      regrade = await regradeNoIcpCards({ clientId: client.id });
    }
    console.log('[Admin] rebuild-icp', { status: result.status, regrade });
    res.json({ ok: true, force, icp: summarizeIcpResult(result), regrade });
  } catch (err) {
    console.error('[Admin] rebuild-icp error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Update client
router.patch('/admin/clients/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const fields = req.body;
    const allowedFields = [
      'name', 'smartlead_api_key', 'heyreach_api_key', 'allo_api_key', 'slack_bot_token',
      'slack_channel_id', 'booking_link', 'booking_destination_url', 'voice_prompt',
      'active', 'digest_timezone', 'cc_email', 'cc_emails', 'cc_round_robin_emails',
      'contact_email',
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
      fields.contact_email = portalContactEmail({ cc_emails: alwaysCc, cc_email: fields.cc_email });
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'cc_round_robin_emails')) {
      fields.cc_round_robin_emails = normalizeCcListField(fields.cc_round_robin_emails);
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'contact_email')
      && !Object.prototype.hasOwnProperty.call(fields, 'cc_emails')
      && !Object.prototype.hasOwnProperty.call(fields, 'cc_email')) {
      // Always-notify is the source of truth. A lone contact_email write is ignored.
      delete fields.contact_email;
    }

    if (Object.prototype.hasOwnProperty.call(fields, 'booking_link')
      || Object.prototype.hasOwnProperty.call(fields, 'name')) {
      const { rows: [existing] } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
      if (existing) {
        const booked = normalizeClientBooking({
          name: fields.name != null ? fields.name : existing.name,
          booking_link: fields.booking_link != null ? fields.booking_link : existing.booking_link,
          booking_destination_url: existing.booking_destination_url,
        });
        fields.booking_link = booked.booking_link || null;
        fields.booking_destination_url = booked.booking_destination_url || null;
      }
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
    const portal = await provisionClientToPortal(client);
    res.json({
      ...formatClient(client),
      portal_login_link: portal.loginLink || null,
      portal_warning: portal.warning || null,
      portal_synced: !!portal.ok,
    });
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
    platform: platformRaw = 'smartlead',
    linkedinUrl,
    heyreach: heyreachMeta,
    thread_ts: threadTsRaw,
    threadTs: threadTsAlt,
    cc_client: ccClientRaw,
    ccClient: ccClientAlt,
  } = req.body || {};
  const threadTs = String(threadTsRaw || threadTsAlt || '').trim() || null;
  const platform = String(platformRaw || 'smartlead').toLowerCase();
  if (!['smartlead', 'heyreach'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be smartlead or heyreach' });
  }
  const ccClientVal = ccClientRaw !== undefined ? ccClientRaw : ccClientAlt;
  const ccClient = ccClientVal === true || /^(1|true|yes|on)$/i.test(String(ccClientVal || ''));
  if (threadTs && !/^\d+\.\d+$/.test(threadTs)) {
    return res.status(400).json({ error: 'thread_ts must look like 1234567890.123456' });
  }

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
    const messages = lastOut
      ? [
        { role: 'us', message: lastOut },
        { role: 'prospect', message: inboundMessage },
      ]
      : [{ role: 'prospect', message: inboundMessage }];
    // HeyReach sends need the conversation / account ids in thread_context.
    const threadContext = platform === 'heyreach'
      ? { messages, heyreach: { ...(heyreachMeta || {}), linkedinUrl: (heyreachMeta && heyreachMeta.linkedinUrl) || linkedinUrl || null } }
      : messages;
    const display = formatCampaignDisplay(campaignName, campaignId) || String(campaignId);

    const { rows: [reply] } = await db.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email,
         inbound_message, thread_context, classification, draft_reply, status, linkedin_url)
       VALUES ($1, $11, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $12) RETURNING *`,
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
        platform,
        linkedinUrl || (heyreachMeta && heyreachMeta.linkedinUrl) || null,
      ]
    );

    const slackResult = await postProspectSlackCard({
      token: client.slack_bot_token,
      channelId: client.slack_channel_id,
      clientId,
      platform,
      campaignId: String(campaignId),
      leadId: String(leadId),
      threadContext,
      isDraft: true,
      replyId: reply.id,
      postInThread: false,
      threadTs,
      card: {
        showCcClientButton: ccClient,
        replyId: reply.id,
        leadName,
        leadEmail: leadEmail || null,
        linkedinUrl: linkedinUrl || undefined,
        platform,
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
      threadTs,
      ccClientButton: ccClient,
    });
  } catch (err) {
    console.error('[Admin] post-approval-card error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Redraft one existing reply row (e.g. a suppressed OTHER) and post a real
 * approval card, optionally into a Slack thread. HeyReach rows get their
 * conversation ids re-fetched so Approve & Send goes out via HeyReach.
 * Body: { replyId } or { inboundContains, platform?, sinceHours? }, thread_ts?
 * Response carries ids only, never lead text.
 */
router.post('/admin/redraft-reply', async (req, res) => {
  const b = req.body || {};
  const threadTs = String(b.thread_ts || b.threadTs || '').trim() || null;
  if (threadTs && !/^\d+\.\d+$/.test(threadTs)) return res.status(400).json({ error: 'bad thread_ts' });
  try {
    let rows;
    if (b.replyId) {
      ({ rows } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [b.replyId]));
    } else if (b.inboundContains && String(b.inboundContains).length >= 12) {
      ({ rows } = await db.query(
        `SELECT * FROM pending_replies
          WHERE inbound_message ILIKE '%' || $1 || '%'
            AND ($2::text IS NULL OR platform = $2)
            AND created_at > now() - make_interval(hours => $3::int)
          ORDER BY created_at DESC LIMIT 5`,
        [String(b.inboundContains), b.platform || null, parseInt(b.sinceHours, 10) || 48]
      ));
    } else {
      return res.status(400).json({ error: 'replyId or inboundContains (12+ chars) required' });
    }
    if (!rows.length) return res.status(404).json({ error: 'no matching reply' });
    if (rows.length > 1 && !b.replyId) {
      return res.status(409).json({ error: 'multiple matches', replyIds: rows.map((r) => r.id) });
    }
    const reply = rows[0];
    const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
    if (!client || !client.active) return res.status(404).json({ error: 'client not found or inactive' });

    const poller = require('../services/heyreach-poller');
    let threadContext = typeof reply.thread_context === 'string'
      ? JSON.parse(reply.thread_context || 'null') : reply.thread_context;
    let messages = Array.isArray(threadContext) ? threadContext : (threadContext?.messages || null);
    let lastOut = null;
    if (reply.platform === 'heyreach' && !(threadContext && threadContext.heyreach && threadContext.heyreach.conversationId)) {
      const heyreach = require('../services/heyreach');
      const conv = await heyreach.findConversation(client.heyreach_api_key, {
        leadId: reply.lead_id, conversationId: reply.lead_id, linkedinUrl: reply.linkedin_url, maxPages: 6,
      });
      if (!conv) return res.status(404).json({ error: 'HeyReach conversation not found', replyId: reply.id });
      const convMsgs = poller.conversationMessages(conv);
      messages = poller.messagesForThread(convMsgs);
      lastOut = poller.lastOutbound(convMsgs);
      threadContext = {
        messages,
        heyreach: {
          listId: poller.listId(conv),
          linkedinAccountId: poller.linkedInAccountId(conv),
          linkedinUrl: poller.linkedinUrl(conv) || reply.linkedin_url || null,
          conversationId: poller.conversationId(conv),
          senderId: poller.senderId(conv),
          campaignName: conv?.campaignName || conv?.campaign?.name || null,
        },
      };
    }
    if (!messages) messages = [{ role: 'prospect', message: reply.inbound_message }];

    const { classifyAndDraft } = require('../services/classifier');
    const { resolveVerifiedSchedulingSlots } = require('../services/scheduling-slots');
    const { promptBlock, slots } = await resolveVerifiedSchedulingSlots(client, { skipExternalFetch: true });
    const result = await classifyAndDraft(messages, reply.inbound_message, client.voice_prompt, client.booking_link, promptBlock, {
      leadName: reply.lead_name, digestTimezone: client.digest_timezone, platform: reply.platform,
      clientId: client.id, leadId: reply.lead_id, leadEmail: reply.lead_email, clientName: client.name,
      draftMode: 'realtime', slots,
    });
    const classification = ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION', 'OTHER'].includes(result.classification)
      ? result.classification : 'OTHER';
    const draft = result.draft || '';
    if (!draft) return res.status(422).json({ error: 'no draft generated', replyId: reply.id, classification: result.classification });

    await db.query(
      `UPDATE pending_replies
          SET thread_context = $1, classification = $2, draft_reply = $3, status = 'pending',
              suppression_reason = NULL, slack_message_ts = NULL, updated_at = now()
        WHERE id = $4`,
      [JSON.stringify(threadContext), classification, draft, reply.id]
    );
    const slackResult = await postProspectSlackCard({
      token: client.slack_bot_token,
      channelId: client.slack_channel_id,
      clientId: client.id,
      platform: reply.platform,
      campaignId: reply.campaign_id,
      leadId: reply.lead_id,
      threadContext,
      isDraft: true,
      replyId: reply.id,
      postInThread: false,
      threadTs,
      card: {
        replyId: reply.id,
        leadName: reply.lead_name,
        leadEmail: reply.lead_email || null,
        linkedinUrl: reply.linkedin_url || threadContext?.heyreach?.linkedinUrl || undefined,
        platform: reply.platform,
        classification,
        draft,
        reasoning: result.reasoning || 'Redrafted for approval.',
        inboundMessage: reply.inbound_message,
        campaignDisplay: formatCampaignDisplay(reply.campaign_name || threadContext?.heyreach?.campaignName, reply.campaign_id) || String(reply.campaign_id || ''),
        lastOutboundMessage: lastOut || undefined,
      },
    });
    return res.status(201).json({ ok: true, replyId: reply.id, platform: reply.platform, classification, slackMessageTs: slackResult && slackResult.ts, threadTs });
  } catch (err) {
    console.error('[Admin] redraft-reply error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Re-classify suppressed replies from the last N days (default 3) and
 * Slack-card mixed-intent / QUESTION rows. dry_run is the default.
 * Response is counts only.
 *
 * POST /admin/resurface-suppressed?days=3&dry=1
 * POST /admin/resurface-suppressed  { days, dry: false }  // live
 */
router.post('/admin/resurface-suppressed', async (req, res) => {
  try {
    const days = parseDays(req.query.days ?? req.body?.days);
    const dryRun = parseDryRun(req.query.dry ?? req.body?.dry);
    const limit = req.query.limit ?? req.body?.limit;
    const counts = await resurfaceSuppressedReplies({ days, dryRun, limit });
    console.log('[Admin] resurface-suppressed', counts);
    res.json({ ok: true, ...counts });
  } catch (err) {
    console.error('[Admin] resurface-suppressed error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
