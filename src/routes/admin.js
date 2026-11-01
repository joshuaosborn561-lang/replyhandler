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
  saveManualIcpProfile,
} = require('../services/client-icp-profile');
const { regradeNoIcpCards } = require('../services/regrade-no-icp-cards');
const { resurfaceSuppressedReplies, parseDays, parseDryRun } = require('../services/resurface-suppressed');
const { postStoredHeyreachApprovalCard } = require('../services/heyreach-approval-card');
const { supersedeEarlierOpenCards, retireDuplicateOpenCards } = require('../services/supersede-cards');
const { refreshReferralDrafts } = require('../services/refresh-referral-draft');
const { validateExtraction } = require('../services/followup-sequence-copy');

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
      cc_email, cc_emails, cc_round_robin_emails, contact_email, notify_emails,
    } = req.body;

    if (!name || !slack_bot_token || !slack_channel_id) {
      return res.status(400).json({ error: 'name, slack_bot_token, and slack_channel_id are required' });
    }

    const alwaysCc = normalizeCcListField(cc_emails || cc_email);
    const rr = normalizeCcListField(cc_round_robin_emails);
    const notifyList = normalizeCcListField(notify_emails);
    const legacyCc = alwaysCc ? alwaysCc.split(',')[0].trim() : null;

    const contactEmail = portalContactEmail({ cc_emails: alwaysCc, cc_email: legacyCc });
    const booked = normalizeClientBooking({ name, booking_link });

    const { rows: [client] } = await db.query(
      `INSERT INTO clients (
         name, smartlead_api_key, heyreach_api_key, allo_api_key, slack_bot_token, slack_channel_id,
         booking_link, booking_destination_url, voice_prompt, digest_timezone,
         cc_email, cc_emails, cc_round_robin_emails, contact_email, notify_emails
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
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
        notifyList,
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

// Hand-entered ICP. Same open admin surface as the other client routes.
router.post('/admin/clients/:clientId/icp-profile', async (req, res) => {
  try {
    const result = await saveManualIcpProfile(db, req.params.clientId, req.body);
    if (!result.ok) return res.status(result.statusCode || 400).json({ error: result.error });
    console.log('[Admin] icp-profile saved', {
      status: result.icp_status,
      source: result.icp_source,
      transcript_count: result.icp_transcript_count,
    });
    res.json({
      ok: true,
      icp_profile: result.icp_profile,
      icp_status: result.icp_status,
      icp_source: result.icp_source,
      icp_transcript_count: result.icp_transcript_count,
    });
  } catch (err) {
    console.error('[Admin] icp-profile error', { err: err.message });
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
      'contact_email', 'notify_emails',
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
    if (Object.prototype.hasOwnProperty.call(fields, 'notify_emails')) {
      fields.notify_emails = normalizeCcListField(fields.notify_emails);
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
    // An update re-syncs the portal record and must not email another invite.
    const portal = await provisionClientToPortal(client, { invite: false });
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
    thread_ts: threadTsRaw,
    threadTs: threadTsAlt,
    cc_client: ccClientRaw,
    ccClient: ccClientAlt,
  } = req.body || {};
  const threadTs = String(threadTsRaw || threadTsAlt || '').trim() || null;
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
      threadTs,
      card: {
        showCcClientButton: ccClient,
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

    let superseded = { retired: [] };
    if (slackResult?.ts && !slackResult.skipped) {
      superseded = await supersedeEarlierOpenCards({
        clientId,
        platform: 'smartlead',
        campaignId: String(campaignId),
        leadId: String(leadId),
        leadEmail: leadEmail || null,
        keepId: reply.id,
        newTs: slackResult.ts,
        channelId: client.slack_channel_id,
        token: client.slack_bot_token,
      });
    }

    return res.status(201).json({
      ok: true,
      replyId: reply.id,
      slackMessageTs: slackResult.ts,
      threadTs,
      ccClientButton: ccClient,
      superseded: superseded.retired || [],
    });
  } catch (err) {
    console.error('[Admin] post-approval-card error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Retire older open Slack cards when the same client + lead + campaign has
 * more than one. dry=1 (the default) lists reply ids and changes nothing.
 * dry=0 marks the older rows superseded and rewrites those Slack messages.
 *
 *   POST /admin/cards/retire-duplicates?dry=1
 *   POST /admin/cards/retire-duplicates?dry=0
 */
router.post('/admin/cards/retire-duplicates', async (req, res) => {
  try {
    const dryRun = parseDryRun(req.query.dry ?? req.body?.dry);
    const result = await retireDuplicateOpenCards({ dryRun });
    console.log('[Admin] retire-duplicates', {
      dryRun,
      groups: result.groups,
      retire: result.retire.length,
      failed: result.failed,
    });
    return res.json(result);
  } catch (err) {
    console.error('[Admin] retire-duplicates error', { err: err.message });
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

/**
 * Turn one stored HeyReach reply into a sendable approval card.
 * Same row, same inbound — does not insert a second card.
 *
 * POST /admin/heyreach/approval-card
 * Body: { replyId, draft, classification? }
 */
/**
 * Rewrite referral drafts to the fixed template.
 * A card that already exists is chat.update'd. A missing card is posted once.
 * Nothing is sent. dry=1 is the default. A live run needs leadEmail or replyId.
 *
 * Preview Ariel:
 *   POST /admin/refresh-referral-draft?leadEmail=ariel@orioncityscape.com&campaignId=4242292
 * Apply (one card, even if the poller counted already_posted or older_than_lookback):
 *   POST /admin/refresh-referral-draft?leadEmail=ariel@orioncityscape.com&campaignId=4242292&dry=0
 * A named lead or reply id is not limited to the last 30 days. No Slack ts
 * posts exactly one card. A real Slack ts is chat.update on that message.
 */
router.post('/admin/refresh-referral-draft', async (req, res) => {
  const dryRaw = req.query.dry ?? req.body?.dry;
  const dry = !(dryRaw === '0' || dryRaw === 0 || dryRaw === false || dryRaw === 'false');
  const leadEmail = req.query.leadEmail || req.query.lead_email || req.body?.leadEmail || req.body?.lead_email || '';
  const replyId = req.query.replyId || req.query.reply_id || req.body?.replyId || req.body?.reply_id || '';
  const campaignId = req.query.campaignId || req.query.campaign_id || req.body?.campaignId || req.body?.campaign_id || '';
  if (!dry && !String(leadEmail).trim() && !String(replyId).trim()) {
    return res.status(400).json({
      error: 'Pass leadEmail or replyId when dry=0. A live run is one prospect, not every card.',
    });
  }
  try {
    const result = await refreshReferralDrafts({ dry, leadEmail, replyId, campaignId });
    console.log('[Admin] refresh-referral-draft', {
      dry, leadEmail: leadEmail || null, campaignId: campaignId || null,
      updated: result.updated, posted: result.posted, skipped: result.skipped,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Admin] refresh-referral-draft failed', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.post('/admin/heyreach/approval-card', async (req, res) => {
  try {
    const result = await postStoredHeyreachApprovalCard({
      replyId: req.body?.replyId || req.body?.reply_id,
      draft: req.body?.draft,
      classification: req.body?.classification,
      reasoning: req.body?.reasoning,
    });
    return res.status(result.posted ? 201 : 200).json(result);
  } catch (err) {
    console.error('[Admin] heyreach approval card error', { err: err.message });
    return res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * Trace ghosted-meeting checks: every booked meeting looked at, the decision, the reason,
 * and the stage-by-stage trail. Read-only. Query: ?days=2 (default 3), ?decision=held.
 */
router.get('/admin/ghosted-meetings', async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 3));
    const decision = req.query.decision ? String(req.query.decision) : null;
    const { rows } = await db.query(
      `SELECT g.id, c.name AS client, g.lead_key, g.meeting_start, g.meeting_end, g.source,
              g.decision, g.reason, g.evidence, g.sequence_id, g.trail, g.first_seen_at, g.decided_at
         FROM ghosted_meeting_checks g JOIN clients c ON c.id = g.client_id
        WHERE g.first_seen_at >= now() - ($1::int * interval '1 day')
          AND ($2::text IS NULL OR g.decision = $2)
        ORDER BY g.meeting_start DESC LIMIT 200`,
      [days, decision],
    );
    return res.json({ count: rows.length, checks: rows });
  } catch (err) {
    console.error('[Admin] ghosted-meetings list error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Run one ghosted-meeting scan now. When GHOSTED_MEETING_ENABLED is off this is always a
 * dry run (decides and logs, enrolls nothing). With the flag on, pass { dryRun: true } to
 * preview. Nothing here sends to a lead.
 */
router.post('/admin/ghosted-meetings/run', async (req, res) => {
  try {
    const ghostedMeetings = require('../services/ghosted-meetings');
    const wantsDry = req.body && (req.body.dryRun === true || req.body.dryRun === 'true');
    const dryRun = wantsDry || !ghostedMeetings.enabled();
    const result = await ghostedMeetings.runGhostedMeetingScan({ dryRun });
    return res.json({ dryRun, flag: ghostedMeetings.enabled(), result });
  } catch (err) {
    console.error('[Admin] ghosted-meetings run error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Hand-enroll one ghosted meeting into the existing ghosted-meeting follow-up flow (same
 * sequence, same approval cards, same stop rules as the scanner). Sends nothing and posts
 * nothing itself; the sequence runner posts the cards and a human clicks them. Idempotent:
 * a lead that already has a ghosted-meeting sequence comes back alreadyEnrolled.
 * Like every admin route it takes no key (Josh, Oct 20).
 * Body: { leadEmail, clientId? | client?, meetingStart?, meetingEnd?, dryRun? }
 * 201 enrolled, 200 alreadyEnrolled / dryRun, 400 bad input, 404 unknown client or lead, 409 blocked.
 */
router.post('/admin/ghosted-meetings/enroll', async (req, res) => {
  try {
    const out = await require('../services/ghosted-manual-enroll').enrollManual(req.body || {});
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[Admin] ghosted-meetings enroll error', { err: err.message });
    return res.status(500).json({ ok: false, error: 'enroll failed' });
  }
});

/**
 * Reopen a reply card that was Rejected: rejected -> pending, nothing else. Writes an audit row
 * (followup_card_events, event_type admin_status_change) in the same statement. Never sends, does
 * not restore cancelled follow-up nudges, does not touch Smartlead or HeyReach.
 * Body: { status: 'pending' | 'interested', reason?, actor?, repaintCard? }
 * 'interested' also sets classification INTERESTED when the card is not already a positive class.
 * repaintCard: true redraws the existing Slack message (chat.update) so its buttons come back.
 * 200 changed / already pending, 400 bad input, 404 unknown card, 409 card is not rejected.
 */
router.post('/admin/cards/:id/status', async (req, res) => {
  try {
    const out = await require('../services/card-status-admin').setCardStatus(req.params.id, req.body || {});
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[Admin] card status error', { err: err.message });
    return res.status(500).json({ ok: false, error: 'card status change failed' });
  }
});

/**
 * Day-30 nurture: flags, lead counts by stage, exit reasons, touch counts. Read only, counts only (no lead rows).
 */
router.get('/admin/nurture', async (_req, res) => {
  try {
    return res.json(await require('../services/nurture-day30').status());
  } catch (err) {
    console.error('[Admin] nurture status error', { err: err.message });
    return res.status(500).json({ error: 'nurture status failed' });
  }
});

/**
 * Run one nurture pass now. Needs NURTURE_ENABLED. With ?dry=1 it enrols and checks exits
 * (database only) and previews the cards that would post, but posts nothing.
 */
router.post('/admin/nurture/run', async (req, res) => {
  try {
    const svc = require('../services/nurture-day30');
    if (!svc.enabled()) return res.status(409).json({ error: 'NURTURE_ENABLED is off' });
    const dry = /^(1|true|yes)$/i.test(String(req.query.dry || ''));
    if (!dry) return res.json({ dry: false, result: await svc.runNurtureTick() });
    const result = {
      entries: await svc.scanEntries(),
      exits: await svc.syncExits(),
      touches: await svc.runTouches({ dryRun: true }),
    };
    return res.json({ dry: true, result });
  } catch (err) {
    console.error('[Admin] nurture run error', { err: err.message });
    return res.status(500).json({ error: 'nurture run failed' });
  }
});

/**
 * Hand-enrol leads into Day-30 nurture, each with its own subject and body. Body:
 *   { clientId, leads: [{ email, name, subject, body, company?, phone?, summary?, note?,
 *                         last_outreach_at?, due?, hubspot?: false, hubspot_contact_id? }], apply?, allowPartial? }
 * Writes nothing unless apply is true. It never posts or sends; the nurture flags and the human
 * Approve click still decide that. Like every admin route it takes no key (Josh, Oct 20). A write also
 * needs the client to be in NURTURE_CLIENT_IDS, and the response has issue codes by row, no names or emails.
 */
router.post('/admin/nurture/enrol', async (req, res) => {
  try {
    const { clientId, leads, apply = false, allowPartial = false } = req.body || {};
    const out = await require('../services/nurture-manual-enrol').enrolManual({
      clientId, leads, apply: apply === true || apply === 'true', allowPartial: allowPartial === true,
    });
    if (out.error && !out.results) return res.status(out.error === 'client_not_in_NURTURE_CLIENT_IDS' ? 409 : 400).json({ error: out.error });
    const slim = (out.results || []).map((r) => ({
      index: r.index, ref: r.ref, status: r.status, errors: r.errors, warnings: r.warnings,
      ...(r.nextTouchAt ? { nextTouchAt: r.nextTouchAt } : {}),
    }));
    return res.status(out.ok ? 200 : 409).json({
      ok: out.ok, applied: out.applied, error: out.error, flags: out.flags, batchWarnings: out.batchWarnings,
      summary: out.summary, results: slim,
    });
  } catch (err) {
    console.error('[Admin] nurture enrol error', { err: err.message });
    return res.status(500).json({ error: 'nurture enrol failed' });
  }
});

/**
 * Set (or clear) a client's offer line and proof point for the follow-up card
 * sequence by hand. Like every admin route it takes no key (Josh, Oct 20: no
 * admin key checks). The proof point still has to carry a real number; a manual row is never overwritten by extraction.
 * Body: { clientId, campaignId?, offerLine?, proofPoint?, clear? }
 */
router.post('/admin/followup-sequence/copy', async (req, res) => {
  try {
    const { clientId, campaignId = '', offerLine = null, proofPoint = null, clear = false } = req.body || {};
    if (!clientId) return res.status(400).json({ error: 'clientId required' });
    const camp = campaignId != null ? String(campaignId) : '';
    if (clear) {
      await db.query(
        `DELETE FROM followup_sequence_copy WHERE client_id = $1 AND campaign_id = $2 AND source = 'manual'`,
        [clientId, camp],
      );
      return res.json({ cleared: true });
    }
    if (proofPoint && !/\d/.test(String(proofPoint))) {
      return res.status(400).json({ error: 'proofPoint must contain a real number' });
    }
    // Same structural checks as extraction, minus the verbatim-from-copy rule
    // (a human is vouching for it).
    const checked = validateExtraction(`${offerLine || ''} ${proofPoint || ''}`, {
      offer_line: offerLine, proof_point: proofPoint,
    });
    if (checked.reasons.length) return res.status(400).json({ error: 'rejected', reasons: checked.reasons });
    await db.query(
      `INSERT INTO followup_sequence_copy (client_id, campaign_id, offer_line, proof_point, source, source_hash, extracted_at)
       VALUES ($1, $2, $3, $4, 'manual', NULL, now())
       ON CONFLICT (client_id, campaign_id) DO UPDATE
         SET offer_line = EXCLUDED.offer_line, proof_point = EXCLUDED.proof_point,
             source = 'manual', source_hash = NULL, extracted_at = now()`,
      [clientId, camp, checked.offerLine, checked.proofPoint],
    );
    return res.json({ saved: true, offerLine: checked.offerLine, proofPoint: checked.proofPoint });
  } catch (err) {
    console.error('[Admin] followup-sequence copy error', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Render a day-of brief for one meeting and send nothing. Does not queue it.
 * Query: ?meetingId=
 */
router.get('/admin/client-briefs/preview', async (req, res) => {
  try {
    const { previewBrief } = require('../services/client-dayof-brief');
    const meetingId = req.query.meetingId || req.query.meeting_id;
    const out = await previewBrief({ meetingId });
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[Admin] client brief preview error', { err: err.message });
    return res.status(500).json({ error: 'preview_failed' });
  }
});

/** Briefs waiting on a reviewer. Held only. Nothing here has been emailed. */
router.get('/admin/client-briefs/pending', async (_req, res) => {
  try {
    const { listPendingBriefs } = require('../services/client-dayof-brief');
    const out = await listPendingBriefs();
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[Admin] client brief pending error', { err: err.message });
    return res.status(500).json({ error: 'pending_failed' });
  }
});

/**
 * Release a held brief. Optional JSON body merges enriched fields, then re-renders.
 * A zero-context brief stays held and is not sent. The client email goes out only
 * when CLIENT_DAYOF_BRIEF_ENABLED is on.
 */
router.post('/admin/client-briefs/:id/release', async (req, res) => {
  try {
    const { releaseBrief } = require('../services/client-dayof-brief');
    const out = await releaseBrief(req.params.id, req.body || {});
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[Admin] client brief release error', { err: err.message });
    return res.status(500).json({ error: 'release_failed' });
  }
});

/** Drop a brief. A blocked brief is never emailed. */
router.post('/admin/client-briefs/:id/block', async (req, res) => {
  try {
    const { blockBrief } = require('../services/client-dayof-brief');
    const out = await blockBrief(req.params.id);
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[Admin] client brief block error', { err: err.message });
    return res.status(500).json({ error: 'block_failed' });
  }
});

/**
 * Upcoming client meetings for the EA writer.
 * Query: ?from=&to= (ISO instants, start inclusive, end exclusive, at most 31 days).
 * Same auth as the other admin routes on this router: none.
 */
router.get('/admin/client-meetings/upcoming', async (req, res) => {
  try {
    const { listUpcomingMeetings } = require('../services/client-dayof-brief');
    const out = await listUpcomingMeetings({ from: req.query.from, to: req.query.to });
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[Admin] upcoming client meetings error', { err: err.message });
    return res.status(500).json({ error: 'upcoming_failed' });
  }
});

/**
 * Send one EA-written brief. Body: { meeting_id, subject, html }.
 * To = that client's notify_emails. CC = Josh. Gated by CLIENT_DAYOF_BRIEF_ENABLED.
 * Same auth as the other admin routes on this router: none.
 */
router.post('/admin/client-brief/send', async (req, res) => {
  try {
    const { sendClientBrief } = require('../services/client-dayof-brief');
    const body = req.body || {};
    const out = await sendClientBrief({
      meetingId: body.meeting_id || body.meetingId,
      subject: body.subject,
      html: body.html,
    });
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error('[Admin] client brief send error', { err: err.message });
    return res.status(500).json({ error: 'send_failed' });
  }
});

module.exports = router;
