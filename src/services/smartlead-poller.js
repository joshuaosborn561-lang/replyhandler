const db = require('../db');
const smartlead = require('./smartlead');
const { postProspectSlackCard } = require('./slack-reply-post');
const { recordSuppressedReply } = require('./suppressed-replies');
const { classifyFromSmartlead } = require('./smartlead-category');
const { classifyAndDraft } = require('./classifier');
const { resolveVerifiedSchedulingSlots } = require('./scheduling-slots');
const { cancelForInboundReply } = require('./outbound-follow-up');
const { applyClientDraftPolicy } = require('../utils/client-draft-policy');
const {
  alreadyPostedToSlack,
  findUnpostedReply,
  repostReplyRowToSlack,
  recoverUnpostedSlackCards,
} = require('./reply-dedupe');
const {
  stripHtmlToText,
  stripEmailQuotePrefix,
  latestInboundFromSmartleadHistory,
  lastOutboundBodyFromSmartleadHistory,
  slackSuppressionReason,
  normalizeSmartleadLeadId,
  normalizeSmartleadCampaignId,
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

async function processInboxRow(client, row, options) {
  const campaignId = normalizeSmartleadCampaignId(row) || row?.email_campaign_id || row?.emailCampaignId;
  const leadId = normalizeSmartleadLeadId(row) || row?.email_lead_id || row?.emailLeadId;
  if (!campaignId || !leadId) return { skipped: 'missing_ids' };

  const inbound = latestInboundFromRow(row);
  if (!inbound) return { skipped: 'no_inbound' };

  const at = replyTime(row);
  const lookbackMs = options.lookbackHours * 3600 * 1000;
  if (at && Date.now() - at.getTime() > lookbackMs) return { skipped: 'older_than_lookback' };

  // Derived before the dedupe checks: the webhook and this poller build the inbound
  // text differently (payload body vs rebuilt history), so an exact text match is not
  // a reliable identity. stats_id comes from the same thread history in both paths.
  const threadContext = historyFromRow(row);
  const smartleadEmailStatsId = smartlead.extractStatsIdFromHistory(threadContext);

  const unposted = await findUnpostedReply({
    clientId: client.id,
    platform: 'smartlead',
    campaignId,
    leadId,
    inboundMessage: inbound,
    emailStatsId: smartleadEmailStatsId,
  });
  if (unposted) {
    await repostReplyRowToSlack(client, unposted, {
      reasoningExtra: `${unposted.classification || 'pending'} (Recovered by SmartLead inbox polling — Slack post retry.)`,
    });
    return { posted: true, replyId: unposted.id, leadName: unposted.lead_name, recovered: true };
  }

  if (await alreadyPostedToSlack({
    clientId: client.id,
    platform: 'smartlead',
    campaignId,
    leadId,
    inboundMessage: inbound,
    emailStatsId: smartleadEmailStatsId,
  })) {
    return { skipped: 'already_posted' };
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
  const lastOutbound = lastOutboundBodyFromSmartleadHistory(threadContext) || '';
  const campaignDisplay = formatCampaignDisplay(row.email_campaign_name, campaignId);

  const { promptBlock } = await resolveVerifiedSchedulingSlots(client, { skipExternalFetch: true });
  let result;
  try {
    result = await classifyAndDraft(
      threadContext,
      inbound,
      client.voice_prompt,
      client.booking_link,
      promptBlock,
      { leadName, digestTimezone: client.digest_timezone, platform: 'smartlead' },
    );
  } catch (err) {
    console.error('[SmartLeadPoll] classifyAndDraft threw — using OTHER/empty draft', {
      client: client.name, err: err.message,
    });
    result = {
      classification: 'OTHER',
      draft: '',
      proposed_time: null,
      reasoning: `Classifier failed: ${err.message}`,
    };
  }
  let { classification, draft, proposed_time, reasoning } = result;

  const slCategory = classifyFromSmartlead(row, threadContext);
  if (slCategory && slCategory.classification !== classification) {
    console.log('[SmartLeadPoll] Using SmartLead category over Gemini', {
      leadName, smartlead: slCategory.raw, mappedTo: slCategory.classification, gemini: classification,
    });
    classification = slCategory.classification;
    reasoning = `SmartLead category "${slCategory.raw}" → ${classification}. ${reasoning}`;
  }

  const suppressed = slackSuppressionReason(inbound);
  if (suppressed) {
    await recordSuppressedReply({
      clientId: client.id, platform: 'smartlead', campaignId, leadId,
      leadName, leadEmail, inboundMessage: inbound,
      classification, reason: suppressed, emailStatsId: smartleadEmailStatsId,
    });
    return { skipped: suppressed };
  }

  const policy = applyClientDraftPolicy(client, leadEmail, { classification, draft, reasoning });
  draft = policy.draft;
  reasoning = policy.reasoning;
  const isDraft = policy.isDraft;
  const status = policy.status;
  if (policy.skippedDraft) {
    console.log('[SmartLeadPoll] Draft skipped by client policy', {
      client: client.name, leadName, leadEmail, reason: policy.skipReason,
    });
  }

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

  try {
    await postProspectSlackCard({
      token: client.slack_bot_token,
      channelId: client.slack_channel_id,
      clientId: client.id,
      platform: 'smartlead',
      campaignId,
      leadId,
      threadContext,
      isDraft,
      replyId: reply.id,
      card,
    });
  } catch (err) {
    console.error('[SmartLeadPoll] Slack post failed (row saved for recovery)', {
      client: client.name,
      replyId: reply.id,
      leadName,
      channelId: client.slack_channel_id,
      err: err.message,
    });
    return { posted: false, skipped: 'slack_post_failed', replyId: reply.id, leadName };
  }

  if (isDraft && classification === 'MEETING_PROPOSED' && leadEmail) {
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
  // Declared outside try so finally can log without ReferenceError.
  const skipCounts = {};
  try {
    const recovery = await recoverUnpostedSlackCards({ limit: 15 });
    if (recovery.recovered) {
      totals.processed += recovery.recovered;
      console.log('[SmartLeadPoll] Recovered unposted Slack cards', recovery);
    }

    const clients = await loadClients();
    const pageLimit = Math.min(numberEnv('SMARTLEAD_POLL_PAGE_LIMIT', 10), 20);
    const maxReplies = numberEnv('SMARTLEAD_POLL_MAX_REPLIES', 40);
    const lookbackHours = numberEnv('SMARTLEAD_POLL_LOOKBACK_HOURS', 168);

    for (const client of clients) {
      let scanned = 0;
      let posted = 0;
      const clientSkips = {};
      const bumpSkip = (reason) => {
        skipCounts[reason] = (skipCounts[reason] || 0) + 1;
        clientSkips[reason] = (clientSkips[reason] || 0) + 1;
      };
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
              bumpSkip(result.skipped);
            }
          } catch (err) {
            console.error('[SmartLeadPoll] Row processing failed', {
              clientId: client.id, client: client.name, err: err.message,
            });
          }
        }
        if (rows.length < pageLimit) break;
      }
      console.log('[SmartLeadPoll] Client scan complete', {
        clientId: client.id, client: client.name, scanned, posted, skipReasons: clientSkips,
      });
    }
  } catch (err) {
    console.error('[SmartLeadPoll] Poll failed', { err: err.message, stack: err.stack });
  } finally {
    isPollingRunning = false;
    console.log('[SmartLeadPoll] Finished', { ms: Date.now() - started, ...totals, skipCounts });
  }
  return totals;
}

module.exports = { pollSmartleadReplies, fetchInboxReplies, historyFromRow, latestInboundFromRow, replyTime };
