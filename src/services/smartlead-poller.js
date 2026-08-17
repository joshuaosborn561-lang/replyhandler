const db = require('../db');
const smartlead = require('./smartlead');
const { postProspectSlackCard } = require('./slack-reply-post');
const { recordSuppressedReply } = require('./suppressed-replies');
const { classifyFromSmartlead } = require('./smartlead-category');
const { classifyAndDraft } = require('./classifier');
const { resolveVerifiedSchedulingSlots } = require('./scheduling-slots');
const { cancelForInboundReply } = require('./outbound-follow-up');
const { applyClientDraftPolicy } = require('../utils/client-draft-policy');
const { formatCampaignDisplay } = require('../utils/campaign-display');
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
  normalizeSmartleadLeadId,
  normalizeSmartleadCampaignId,
} = require('../utils/smartlead-webhook-helpers');
const { slackChannelSuppressionReason } = require('../utils/slack-channel-policy');

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

function historyFromRow(row) {
  const list = row?.email_history || row?.emailHistory || row?.message_history || [];
  return { history: Array.isArray(list) ? list : [] };
}

function latestInboundFromHistory(hist, leadEmail) {
  const fromHist = latestInboundFromSmartleadHistory(hist, leadEmail);
  if (fromHist) return fromHist;
  const list = (hist && hist.history) || [];
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

function latestInboundFromRow(row) {
  return latestInboundFromHistory(historyFromRow(row), row?.lead_email);
}

function replyTime(row) {
  const raw = row?.last_reply_time || row?.lastReplyTime;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** Newest REPLY/INBOUND timestamp inside a thread history, or null. */
function newestReplyTimeFromHistory(hist) {
  const list = (hist && hist.history) || [];
  let newest = null;
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type !== 'REPLY' && type !== 'INBOUND') continue;
    const raw = m.time || m.sent_at || m.received_at || m.created_at;
    const d = raw ? new Date(raw) : null;
    if (d && !Number.isNaN(d.getTime()) && (!newest || d > newest)) newest = d;
  }
  return newest;
}

function staleToleranceMs() {
  const n = parseInt(process.env.SMARTLEAD_HISTORY_STALE_TOLERANCE_SEC || '', 10);
  return (Number.isFinite(n) && n >= 0 ? n : 60) * 1000;
}

/**
 * True when a master-inbox row contradicts itself: it reports a `last_reply_time`
 * newer than the newest REPLY in the `email_history` it shipped with.
 *
 * SmartLead's master-inbox can serve a stale `email_history` while its
 * `last_reply_time` is already current. When that happens the newest reply is
 * invisible to this poller, and because the older reply it *can* see was already
 * carded, dedupe correctly calls it a duplicate and skips — so a real reply is
 * never posted, and the webhook is the only path left. Observed 2026-08-11:
 * Chase Dawson (SalesGlider, campaign 3739758) replied "Wednesday works. 1-3pm
 * est if possible." at 16:09; master-inbox still showed only the 15:53 reply
 * 2.5h later, while campaigns/:id/leads/:id/message-history had it all along.
 */
function historyLagsLastReply(row, hist) {
  const last = replyTime(row);
  if (!last) return false;
  const newest = newestReplyTimeFromHistory(hist);
  // Row claims a reply but shipped no reply at all — always worth a real fetch.
  if (!newest) return true;
  return last.getTime() - newest.getTime() > staleToleranceMs();
}

/**
 * Authoritative per-thread history. Fail-open: on any error the caller keeps the
 * master-inbox copy, so a refetch problem can never cost us a poll cycle.
 */
async function refetchThreadHistory(client, campaignId, leadId) {
  try {
    const hist = await smartlead.getThreadHistory(client.smartlead_api_key, campaignId, leadId);
    const list = Array.isArray(hist?.history) ? hist.history
      : Array.isArray(hist?.messages) ? hist.messages
        : Array.isArray(hist) ? hist : [];
    if (!list.length) return null;
    return { history: list };
  } catch (err) {
    console.warn('[SmartLeadPoll] Thread history refetch failed — keeping master-inbox copy', {
      client: client.name, campaignId, leadId, err: err.message,
    });
    return null;
  }
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

  const at = replyTime(row);
  const lookbackMs = options.lookbackHours * 3600 * 1000;
  if (at && Date.now() - at.getTime() > lookbackMs) return { skipped: 'older_than_lookback' };

  // Derived before the dedupe checks: the webhook and this poller build the inbound
  // text differently (payload body vs rebuilt history), so an exact text match is not
  // a reliable identity. stats_id comes from the same thread history in both paths.
  let threadContext = historyFromRow(row);

  // Master-inbox can ship a stale email_history. Trust the per-thread endpoint
  // instead whenever the row contradicts itself, or the newest reply stays
  // invisible and dedupe silently drops it as a duplicate of the older one.
  if (historyLagsLastReply(row, threadContext) && client.smartlead_api_key) {
    const counter = options.refetchCounter;
    const cap = options.maxHistoryRefetch;
    if (!counter || counter.count < cap) {
      if (counter) counter.count++;
      const fresh = await refetchThreadHistory(client, campaignId, leadId);
      if (fresh) {
        const before = newestReplyTimeFromHistory(threadContext);
        const after = newestReplyTimeFromHistory(fresh);
        threadContext = fresh;
        console.log('[SmartLeadPoll] Master-inbox history was stale — refetched thread', {
          client: client.name,
          campaignId,
          leadId,
          leadEmail: row.lead_email || null,
          lastReplyTime: at ? at.toISOString() : null,
          newestReplyBefore: before ? before.toISOString() : null,
          newestReplyAfter: after ? after.toISOString() : null,
        });
      }
    } else {
      console.warn('[SmartLeadPoll] Stale master-inbox history but refetch cap reached', {
        client: client.name, campaignId, leadId, cap,
      });
    }
  }

  const inbound = latestInboundFromHistory(threadContext, row?.lead_email);
  if (!inbound) return { skipped: 'no_inbound' };

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
  let campaignName = row.email_campaign_name || row.emailCampaignName || null;
  if (!campaignName && client.smartlead_api_key && campaignId) {
    campaignName = await smartlead.resolveCampaignName(client.smartlead_api_key, campaignId);
  }
  const campaignDisplay = formatCampaignDisplay(campaignName, campaignId);

  const { promptBlock } = await resolveVerifiedSchedulingSlots(client, { skipExternalFetch: true });
  let result;
  try {
    result = await classifyAndDraft(
      threadContext,
      inbound,
      client.voice_prompt,
      client.booking_link,
      promptBlock,
      {
        leadName,
        digestTimezone: client.digest_timezone,
        platform: 'smartlead',
        clientId: client.id,
        leadId,
        leadEmail,
        clientName: client.name,
      },
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

  const suppressed = slackChannelSuppressionReason({ classification, inboundMessage: inbound });
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
      (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email, inbound_message, thread_context, classification, draft_reply, status, smartlead_email_stats_id)
     VALUES ($1, 'smartlead', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      client.id, String(campaignId), campaignName || null, String(leadId), leadName, leadEmail, inbound,
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
  const refetchCounter = { count: 0 };
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
    // Per-cycle budget for stale-history refetches, so a broadly stale
    // master-inbox cannot turn one poll into hundreds of extra API calls.
    const maxHistoryRefetch = numberEnv('SMARTLEAD_POLL_MAX_HISTORY_REFETCH', 10);

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
            const result = await processInboxRow(client, row, {
              lookbackHours, refetchCounter, maxHistoryRefetch,
            });
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
    console.log('[SmartLeadPoll] Finished', {
      ms: Date.now() - started, ...totals, skipCounts, staleHistoryRefetches: refetchCounter.count,
    });
  }
  return totals;
}

module.exports = {
  pollSmartleadReplies,
  fetchInboxReplies,
  historyFromRow,
  latestInboundFromRow,
  latestInboundFromHistory,
  replyTime,
  newestReplyTimeFromHistory,
  historyLagsLastReply,
};
