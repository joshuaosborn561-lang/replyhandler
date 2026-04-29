const { Router } = require('express');
const db = require('../db');
const smartlead = require('../services/smartlead');
const heyreach = require('../services/heyreach');
const { classifyAndDraft, DRAFT_CLASSIFICATIONS } = require('../services/classifier');
const { profileToEmail } = require('../services/leadmagic');
const slack = require('../services/slack');
const { resolveVerifiedSchedulingSlots } = require('../services/scheduling-slots');

const router = Router();

function normWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function looksLikeOutOfOffice(text) {
  const s = normWs(text);
  if (!s) return false;
  // "out of the office" has an extra word — \bout of office\b does NOT match it.
  if (/\bout of (the )?office\b/.test(s)) return true;
  if (/\bautomatic reply\b/.test(s) || /\bauto-?reply\b/.test(s)) return true;
  if (/\bon vacation\b/.test(s) || /\bvacation\b/.test(s)) return true;
  // Common variants: "limited access to my email", "limited email access"
  if (/\blimited access to (my )?(email|inbox|messages)\b/.test(s)) return true;
  if (/\blimited email access\b/.test(s)) return true;
  if (/\bwill return on\b/.test(s) || /\breturning on\b/.test(s)) return true;
  if (/\bwill be returning\b/.test(s) || /\breturning (on )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(s)) return true;
  if (/\baway from (the )?(office|desk)\b/.test(s)) return true;
  if (/\bmonitoring (my )?(email|inbox) (closely|infrequently)\b/.test(s)) return true;
  return false;
}

function looksLikeWrongPerson(text) {
  const s = normWs(text);
  if (!s) return false;
  if (/\bwrong person\b/.test(s)) return true;
  if (/\bnot the right (person|contact)\b/.test(s)) return true;
  if (/\bno longer (with|employed|works?)\b/.test(s)) return true;
  if (/\bhas left\b/.test(s) && /\b(company|organization|org|team)\b/.test(s)) return true;
  if (/\bplease (reach|contact)\b/.test(s) && /\binstead\b/.test(s)) return true;
  return false;
}

function looksLikeNotInterested(text) {
  const s = normWs(text);
  if (!s) return false;
  // Clear declines first (avoid matching "interested in" inside "not interested in")
  if (/\bwe are not interested\b/.test(s)) return true;
  if (/\b(i'?m|i am) not interested\b/.test(s)) return true;
  if (/\bnot interested in\b/.test(s)) return true;
  if (/\bnot interested at (this|the) time\b/.test(s)) return true;
  if (/\bnot interested\b/.test(s)) return true;
  if (/\bno thanks\b/.test(s) || /\bno thank you\b/.test(s)) return true;
  if (/\bnot a fit\b/.test(s)) return true;
  if (/\bwe are all set\b/.test(s)) return true;
  if (/\bplease stop\b/.test(s) || /\bstop (emailing|messaging)\b/.test(s)) return true;
  return false;
}

function looksLikeRemoveMe(text) {
  const s = normWs(text);
  if (!s) return false;
  if (/\bunsubscribe\b/.test(s)) return true;
  if (/\bremove me\b/.test(s)) return true;
  if (/\bopt\s*out\b/.test(s) || /\bopt-?out\b/.test(s)) return true;
  if (/\btake me off\b/.test(s) || /\btake (my name|me) off\b/.test(s)) return true;
  if (/\bremove (my|me) from\b/.test(s) && /\b(list|mailing list|your list)\b/.test(s)) return true;
  if (/\bdo not contact\b/.test(s) || /\bdon't contact\b/.test(s)) return true;
  if (/\bdo not email\b/.test(s) || /\bdon't email\b/.test(s)) return true;
  if (/\bdo not message\b/.test(s) || /\bdon't message\b/.test(s)) return true;
  if (/\bstop reaching out\b/.test(s) || /\bstop contacting\b/.test(s)) return true;
  if (/\bstop emailing\b/.test(s) || /\bstop sending\b/.test(s)) return true;
  return false;
}

// HeyReach can retry webhooks; dedupe per client+campaign+lead+message hash.
const heyreachDedupe = new Map();
function heyreachDedupeKey({ clientId, campaignId, leadId, inboundMessage, linkedinUrl, listId, linkedinAccountId }) {
  const msg = normWs(inboundMessage).slice(0, 500);
  // Include extra ids where present; HeyReach can omit leadId on some payload shapes.
  return [
    clientId,
    'heyreach',
    String(campaignId || ''),
    String(leadId || ''),
    String(linkedinUrl || ''),
    String(listId || ''),
    String(linkedinAccountId || ''),
    msg,
  ].join('|');
}
function isHeyreachDuplicate(key) {
  const now = Date.now();
  const ttlMs = 5 * 60 * 1000; // 5 minutes
  const last = heyreachDedupe.get(key);
  // Opportunistic cleanup
  if (heyreachDedupe.size > 2000) {
    for (const [k, ts] of heyreachDedupe.entries()) {
      if (now - ts > ttlMs) heyreachDedupe.delete(k);
    }
  }
  if (last && now - last < ttlMs) return true;
  heyreachDedupe.set(key, now);
  return false;
}

// Cache HeyReach campaign access checks to reduce latency.
const heyreachCampaignAccessCache = new Map();
async function verifyHeyreachCampaignAccessCached(apiKey, campaignId) {
  const k = `${String(campaignId)}|${String(apiKey).slice(0, 6)}`;
  const now = Date.now();
  const ttlMs = 10 * 60 * 1000;
  const cached = heyreachCampaignAccessCache.get(k);
  if (cached && now - cached.ts < ttlMs) return cached.ok;
  const ok = await heyreach.verifyCampaignAccess(apiKey, campaignId);
  heyreachCampaignAccessCache.set(k, { ok, ts: now });
  return ok;
}

async function heyreachDuplicateInDb({ clientId, campaignId, leadId, inboundMessage }) {
  const normalized = normWs(inboundMessage);
  if (!normalized) return false;
  // DB-backed idempotency across restarts/retries: same client+campaign+lead+normalized body in last 30 minutes.
  // Note: uses regexp_replace to match our normWs behavior.
  const { rows } = await db.query(
    `SELECT 1
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'heyreach'
        AND campaign_id = $2
        AND COALESCE(lead_id, '') = COALESCE($3, '')
        AND created_at > now() - interval '30 minutes'
        AND lower(regexp_replace(inbound_message, '\\s+', ' ', 'g')) = $4
      LIMIT 1`,
    [clientId, String(campaignId || ''), leadId == null ? null : String(leadId), normalized]
  );
  return rows.length > 0;
}

/**
 * HeyReach payloads vary: inbound text may be on message/body OR only inside recent_messages / conversationHistory.
 * If we only read message/reply/body, OOO heuristics see "" and never suppress.
 */
function heyreachLastProspectFromThread(list) {
  if (!Array.isArray(list) || !list.length) return '';
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || typeof m !== 'object') continue;
    const sender = String(m.sender || m.from || m.role || '').toUpperCase();
    const isReply = m.is_reply === true || m.isReply === true || String(m.type || '').toLowerCase() === 'reply';
    if (sender === 'ME' || sender === 'US' || sender === 'USER') continue;
    // HeyReach sometimes omits sender; treat explicit inbound reply flags as prospect.
    if (!sender && !isReply) continue;
    const txt = m.message || m.body || m.text || m.content || '';
    const t = String(txt).trim();
    if (t) return t;
  }
  // Single-message payloads sometimes omit sender/is_reply — use the only body.
  if (list.length === 1 && list[0] && typeof list[0] === 'object') {
    const m = list[0];
    const t = String(m.message || m.body || m.text || m.content || '').trim();
    if (t) return t;
  }
  return '';
}

function heyreachInboundEffective(payload) {
  const direct = String(
    payload.message ||
      payload.reply ||
      payload.body ||
      payload.text ||
      payload.lastMessage ||
      payload.inboundMessage ||
      payload.inbound_message ||
      ''
  ).trim();
  if (direct) return direct;

  const recent = payload.recent_messages || payload.recentMessages || payload.messages;
  const fromRecent = heyreachLastProspectFromThread(Array.isArray(recent) ? recent : []);
  if (fromRecent) return fromRecent;

  const hist = payload.conversationHistory || payload.thread;
  const fromHist = heyreachLastProspectFromThread(Array.isArray(hist) ? hist : []);
  if (fromHist) return fromHist;

  return '';
}

// SmartLead sends many event types to one URL; only process real replies.
const SMARTLEAD_NON_REPLY_EVENTS = new Set([
  'EMAIL_SENT', 'SENT', 'OUTBOUND', 'EMAIL_OPENED', 'OPEN', 'EMAIL_CLICKED', 'CLICK', 'EMAIL_BOUNCED', 'BOUNCE', 'BOUNCED',
  'LEAD_UNSUBSCRIBED', 'UNSUBSCRIBED', 'UNSUBSCRIBE',
]);

function stripHtmlToText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function smartleadLatestReplyFromHistory(histResponse) {
  if (!histResponse || typeof histResponse !== 'object') return '';
  const list = Array.isArray(histResponse.history)
    ? histResponse.history
    : Array.isArray(histResponse.messages)
      ? histResponse.messages
      : Array.isArray(histResponse)
        ? histResponse
        : [];
  const rows = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type !== 'REPLY' && type !== 'INBOUND') continue;
    const raw = m.email_body || m.body || m.text || '';
    const plain = stripHtmlToText(raw) || String(raw).trim();
    if (!plain) continue;
    const time = String(m.time || m.sent_at || m.received_at || m.created_at || '');
    rows.push({ time, body: plain });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time));
  return rows.length ? rows[rows.length - 1].body : '';
}

function parseSmartleadWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { campaignId: null, leadId: null, leadEmail: null, leadName: 'Unknown', direct: '' };
  }
  const leadData = payload.lead_data || payload.lead || {};
  const replyObj =
    payload.reply_message ||
    payload.replyMessage ||
    payload.reply ||
    payload.latest_reply ||
    payload.last_reply ||
    null;
  const fromReplyObj =
    replyObj && typeof replyObj === 'object'
      ? (replyObj.body || replyObj.message || replyObj.text || replyObj.html || replyObj.email_body || '')
      : String(replyObj || '');
  const direct = String(
    fromReplyObj ||
      payload.reply ||
      payload.message ||
      payload.body ||
      payload.reply_text ||
      payload.replyText ||
      ''
  ).trim();

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
    'Unknown';

  return { campaignId, leadId, leadEmail, leadName, direct };
}

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

    const eventType = String(payload.event_type || payload.eventType || payload.type || payload.webhook_event || '').toUpperCase();
    if (eventType && SMARTLEAD_NON_REPLY_EVENTS.has(eventType)) {
      console.log('[Webhook] SmartLead skipped non-reply event', { clientId, event: eventType });
      return res.status(200).json({ ok: true, skipped: true, reason: 'non_reply_event', event: eventType });
    }

    const parsed = parseSmartleadWebhookPayload(payload);
    const { campaignId, leadId, leadEmail, leadName } = parsed;
    let inboundMessage = parsed.direct ? stripHtmlToText(parsed.direct) || parsed.direct : '';

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
      threadContext = [{ role: 'prospect', message: inboundMessage || '(no thread)' }];
    }

    if (!String(inboundMessage || '').trim() && threadContext && typeof threadContext === 'object' && !Array.isArray(threadContext)) {
      const fromHist = smartleadLatestReplyFromHistory(threadContext);
      if (fromHist) {
        inboundMessage = fromHist;
        console.log('[Webhook] SmartLead inbound from message-history (webhook body empty)', { clientId, campaignId, leadId, len: inboundMessage.length });
      }
    }

    if (!String(inboundMessage || '').trim()) {
      console.warn('[Webhook] SmartLead no usable reply text after history', { clientId, campaignId, leadId, leadName });
      await slack.postError(client.slack_bot_token, client.slack_channel_id, {
        leadName: `${leadName} (SmartLead)`,
        platform: 'smartlead',
        error: 'No reply body in webhook or message-history — check SmartLead payload keys / EMAIL_REPLY shape.',
      });
      return res.status(200).json({ ok: true, error: 'empty_inbound' });
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

    // Hard suppress noise classes.
    if (classification === 'OUT_OF_OFFICE' || looksLikeOutOfOffice(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'ooo' });
    }
    if (classification === 'NOT_INTERESTED' || looksLikeNotInterested(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'not_interested' });
    }
    if (classification === 'WRONG_PERSON' || looksLikeWrongPerson(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'wrong_person' });
    }
    if (classification === 'REMOVE_ME' || looksLikeRemoveMe(inboundMessage)) {
      // SmartLead: attempt to unsubscribe silently.
      try {
        const unsubUrl = `https://server.smartlead.ai/api/v1/campaigns/${campaignId}/leads/${leadId}/unsubscribe?api_key=${encodeURIComponent(client.smartlead_api_key)}`;
        await fetch(unsubUrl, { method: 'POST' });
      } catch (err) {
        console.error('[Webhook] Failed to unsubscribe in SmartLead', { err: err.message });
      }
      return res.status(200).json({ ok: true, skipped: true, reason: 'remove_me' });
    }

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
    const inboundMessage = heyreachInboundEffective(payload);
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

    const dedupeKey = heyreachDedupeKey({ clientId, campaignId, leadId, inboundMessage, linkedinUrl, listId, linkedinAccountId });
    if (isHeyreachDuplicate(dedupeKey)) {
      console.log('[Webhook] HeyReach duplicate suppressed', { clientId, campaignId, leadId });
      return res.status(200).json({ ok: true, skipped: true, reason: 'duplicate' });
    }
    if (await heyreachDuplicateInDb({ clientId, campaignId, leadId, inboundMessage })) {
      console.log('[Webhook] HeyReach duplicate suppressed (db)', { clientId, campaignId, leadId });
      return res.status(200).json({ ok: true, skipped: true, reason: 'duplicate_db' });
    }

    let heyreachCampaignOk = false;
    try {
      heyreachCampaignOk = await verifyHeyreachCampaignAccessCached(client.heyreach_api_key, campaignId);
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

    // Hard suppress noise classes.
    if (classification === 'OUT_OF_OFFICE' || looksLikeOutOfOffice(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'ooo' });
    }
    if (classification === 'NOT_INTERESTED' || looksLikeNotInterested(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'not_interested' });
    }
    if (classification === 'WRONG_PERSON' || looksLikeWrongPerson(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'wrong_person' });
    }
    if (classification === 'REMOVE_ME' || looksLikeRemoveMe(inboundMessage)) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'remove_me' });
    }

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
