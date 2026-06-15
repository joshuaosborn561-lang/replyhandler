const db = require('../db');
const smartlead = require('./smartlead');
const slack = require('./slack');
const { classifyAndDraft, DRAFT_CLASSIFICATIONS } = require('./classifier');
const { resolveVerifiedSchedulingSlots } = require('./scheduling-slots');
const { cancelForInboundReply } = require('./outbound-follow-up');
const {
  stripHtmlToText,
  stripEmailQuotePrefix,
  latestInboundFromSmartleadHistory,
  lastOutboundBodyFromSmartleadHistory,
  shouldSkipSlackForReply,
} = require('../utils/smartlead-webhook-helpers');

const SL_BASE = 'https://server.smartlead.ai/api/v1';

function envFlag(name, defaultValue = true) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function numberEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatCampaignDisplay(name, id) {
  const cid = id != null ? String(id).trim() : '';
  const cname = name != null ? String(name).trim() : '';
  if (cname && cid) return `${cname} (${cid})`;
  if (cname) return cname;
  if (cid) return `Campaign ${cid}`;
  return '';
}

function historyFromRow(row) {
  const list = row?.email_history || row?.emailHistory || row?.message_history || [];
  return { history: Array.isArray(list) ? list : [] };
}

function latestInboundFromRow(row) {
  const hist = historyFromRow(row);
  const fromHist = latestInboundFromSmartleadHistory(hist, row?.lead_email);
  if (fromHist) return fromHist;
  const list = hist.history || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || typeof m !== 'object') continue;
    if (String(m.type || '').toUpperCase() !== 'REPLY') continue;
    const raw = m.email_body || m.body || m.text || '';
    let plain = stripHtmlToText(raw) || String(raw).trim();
    plain = stripEmailQuotePrefix(plain);
    if (plain) return plain;
  }
  return '';
}

function replyTime(row) {
  const raw = row?.last_reply_time || row?.lastReplyTime;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

async function fetchInboxReplies(apiKey, offset, limit) {
  const url = `${SL_BASE}/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=true`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      limit,
      filters: { emailStatus: 'Replied' },
      sortBy: 'REPLY_TIME_DESC',
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`SmartLead inbox-replies failed (${res.status}): ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { return {}; }
}

async function alreadyProcessed({ clientId, campaignId, leadId, inboundMessage, inboundAt }) {
  const normalized = String(inboundMessage || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return true;
  const since = inboundAt || new Date(Date.now() - 48 * 3600 * 1000);
  const { rows } = await db.query(
    `SELECT 1
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'smartlead'
        AND COALESCE(campaign_id, '') = COALESCE($2, '')
        AND COALESCE(lead_id, '') = COALESCE($3, '')
        AND created_at > $4::timestamptz - interval '30 minutes'
        AND lower(regexp_replace(inbound_message, '\\s+', ' ', 'g')) = $5
      LIMIT 1`,
    [clientId, String(campaignId || ''), String(leadId || ''), since, normalized]
  );
  return rows.length > 0;
}

async function processInboxRow(client, row, options) {
  const campaignId = row?.email_campaign_id || row?.emailCampaignId;
  const leadId = row?.email_lead_id || row?.emailLeadId;
  if (!campaignId || !leadId) return { skipped: 'missing_ids' };

  const inbound = latestInboundFromRow(row);
  if (!inbound) return { skipped: 'no_inbound' };

  const at = replyTime(row);
  const lookbackMs = options.lookbackHours * 3600 * 1000;
  if (at && Date.now() - at.getTime() > lookbackMs) return { skipped: 'older_than_lookback' };

  if (await alreadyProcessed({
    clientId: client.id,
    campaignId,
    leadId,
    inboundMessage: inbound,
    inboundAt: at,
  })) {
    return { skipped: 'already_processed' };
  }

  await cancelForInboundReply({
    clientId: client.id,
    platform: 'smartlead',
    campaignId: String(campaignId),
    leadId: String(leadId),
    conversationId: null,
  });

  const leadName = `${row.lead_first_name || ''} ${row.lead_last_name || ''}`.trim() || 'Unknown';
  const leadEmail = row.lead_email || null;
  const threadContext = historyFromRow(row);
  const smartleadEmailStatsId = smartlead.extractStatsIdFromHistory(threadContext);
  const lastOutbound = lastOutboundBodyFromSmartleadHistory(threadContext) || '';
  const campaignDisplay = formatCampaignDisplay(row.email_campaign_name, campaignId);

  const { promptBlock } = await resolveVerifiedSchedulingSlots(client);
  const result = await classifyAndDraft(
    threadContext,
    inbound,
    client.voice_prompt,
    client.booking_link,
    promptBlock,
    { leadName, digestTimezone: client.digest_timezone },
  );
  const { classification, draft, proposed_time, reasoning } = result;

  if (shouldSkipSlackForReply(inbound)) return { skipped: 'ooo' };

  const isDraft = DRAFT_CLASSIFICATIONS.includes(classification);
  const status = isDraft ? 'pending' : 'alert_only';

  const { rows: [reply] } = await db.query(
    `INSERT INTO pending_replies
      (client_id, platform, campaign_id, lead_id, lead_name, lead_email, inbound_message, thread_context, classification, draft_reply, status, smartlead_email_stats_id)
     VALUES ($1, 'smartlead', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      client.id, String(campaignId), String(leadId), leadName, leadEmail, inbound,
      JSON.stringify(threadContext), classification, draft, status, smartleadEmailStatsId,
    ]
  );

  const card = {
    replyId: reply.id,
    leadName,
    leadEmail,
    platform: 'smartlead',
    classification,
    draft,
    reasoning: `${reasoning} (Recovered by SmartLead inbox polling backstop.)`,
    inboundMessage: inbound,
    campaignDisplay,
    lastOutboundMessage: lastOutbound || undefined,
  };

  let slackResult;
  if (isDraft) {
    slackResult = await slack.postDraftApproval(client.slack_bot_token, client.slack_channel_id, card);
  } else {
    slackResult = await slack.postAlert(client.slack_bot_token, client.slack_channel_id, card);
  }
  await db.query('UPDATE pending_replies SET slack_message_ts = $1 WHERE id = $2', [slackResult?.ts || null, reply.id]);

  if (classification === 'MEETING_PROPOSED' && leadEmail) {
    await db.query(
      `INSERT INTO meetings (client_id, pending_reply_id, lead_name, lead_email, proposed_time, status)
       VALUES ($1, $2, $3, $4, $5, 'proposed')`,
      [client.id, reply.id, leadName, leadEmail, proposed_time]
    );
  }

  return { posted: true, replyId: reply.id, leadName };
}

async function loadClients() {
  const { rows } = await db.query(
    `SELECT * FROM clients
     WHERE active IS DISTINCT FROM false
       AND smartlead_api_key IS NOT NULL
       AND smartlead_api_key <> ''`
  );
  return rows;
}

let isPollingRunning = false;

async function pollSmartleadReplies() {
  if (!envFlag('SMARTLEAD_POLL_ENABLED', true)) return { processed: 0, skipped: 0 };
  if (isPollingRunning) {
    console.log('[SmartLeadPoll] Previous run still active; skipping');
    return { processed: 0, skipped: 0 };
  }
  isPollingRunning = true;
  const started = Date.now();
  const totals = { processed: 0, skipped: 0 };
  try {
    const clients = await loadClients();
    const pageLimit = Math.min(numberEnv('SMARTLEAD_POLL_PAGE_LIMIT', 10), 20);
    const maxReplies = numberEnv('SMARTLEAD_POLL_MAX_REPLIES', 40);
    const lookbackHours = numberEnv('SMARTLEAD_POLL_LOOKBACK_HOURS', 48);

    for (const client of clients) {
      let scanned = 0;
      let posted = 0;
      for (let offset = 0; scanned < maxReplies; offset += pageLimit) {
        let payload;
        try {
          payload = await fetchInboxReplies(client.smartlead_api_key, offset, pageLimit);
        } catch (err) {
          console.error('[SmartLeadPoll] Inbox fetch failed', { clientId: client.id, client: client.name, err: err.message });
          break;
        }
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        if (!rows.length) break;
        for (const row of rows) {
          if (scanned >= maxReplies) break;
          scanned++;
          try {
            const result = await processInboxRow(client, row, { lookbackHours });
            if (result.posted) {
              posted++;
              totals.processed++;
            } else if (result.skipped) {
              totals.skipped++;
            }
          } catch (err) {
            console.error('[SmartLeadPoll] Row processing failed', {
              clientId: client.id, client: client.name, err: err.message,
            });
          }
        }
        if (rows.length < pageLimit) break;
      }
      console.log('[SmartLeadPoll] Client scan complete', { clientId: client.id, client: client.name, scanned, posted });
    }
  } catch (err) {
    console.error('[SmartLeadPoll] Poll failed', { err: err.message, stack: err.stack });
  } finally {
    isPollingRunning = false;
    console.log('[SmartLeadPoll] Finished', { ms: Date.now() - started, ...totals });
  }
  return totals;
}

module.exports = { pollSmartleadReplies };
