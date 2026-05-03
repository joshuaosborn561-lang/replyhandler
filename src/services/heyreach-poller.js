const db = require('../db');
const heyreach = require('./heyreach');
const slack = require('./slack');
const { classifyAndDraft, DRAFT_CLASSIFICATIONS } = require('./classifier');
const { resolveVerifiedSchedulingSlots } = require('./scheduling-slots');
const { cancelForInboundReply } = require('./outbound-follow-up');
const {
  looksLikeOutOfOffice,
  looksLikeWrongPerson,
  looksLikeNotInterested,
} = require('../utils/smartlead-webhook-helpers');

const HR_BASE = 'https://api.heyreach.io/api/public';

function normWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function envFlag(name, defaultValue = true) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function numberEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function looksLikeRemoveMe(text) {
  const s = normWs(text);
  if (!s) return false;
  if (/\bunsubscribe\b/.test(s)) return true;
  if (/\bremove me\b/.test(s)) return true;
  if (/\bopt\s*out\b/.test(s) || /\bopt-?out\b/.test(s)) return true;
  if (/\btake me off\b/.test(s)) return true;
  if (/\bdo not (contact|email|message)\b/.test(s)) return true;
  if (/\bdon't (contact|email|message)\b/.test(s)) return true;
  if (/\bstop (emailing|messaging|sending|contacting|reaching out)\b/.test(s)) return true;
  return false;
}

function pickText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return String(obj.message || obj.body || obj.text || obj.content || '').trim();
}

function messageTime(m) {
  const raw = m?.createdAt || m?.creation_time || m?.created_at || m?.time || m?.timestamp || '';
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function isOutboundMessage(m) {
  if (!m || typeof m !== 'object') return false;
  const sender = String(m.sender || m.from || m.role || '').toUpperCase();
  if (sender === 'ME' || sender === 'US' || sender === 'USER') return true;
  if (m.is_reply === false || m.isReply === false) return true;
  return false;
}

function isInboundMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.is_reply === true || m.isReply === true) return true;
  const sender = String(m.sender || m.from || m.role || '').toUpperCase();
  if (!sender) return false;
  return sender !== 'ME' && sender !== 'US' && sender !== 'USER';
}

function conversationMessages(conv) {
  const candidates = [
    conv?.messages,
    conv?.recent_messages,
    conv?.recentMessages,
    conv?.conversationHistory,
    conv?.thread,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return [...c].sort((a, b) => {
        const at = messageTime(a)?.getTime() || 0;
        const bt = messageTime(b)?.getTime() || 0;
        return at - bt;
      });
    }
  }
  return [];
}

function conversationId(conv) {
  return conv?.id || conv?.conversationId || conv?.conversation_id || conv?.threadId || conv?.thread_id || null;
}

function campaignId(conv) {
  return (
    conv?.campaignId ||
    conv?.campaign_id ||
    conv?.campaign?.id ||
    conv?.campaign?.campaignId ||
    conv?.data?.campaignId ||
    conv?.data?.campaign_id ||
    null
  );
}

function campaignDisplay(conv, id) {
  const name = conv?.campaignName || conv?.campaign_name || conv?.campaign?.name || '';
  const cid = id != null ? String(id).trim() : '';
  if (name && cid) return `${name} (${cid})`;
  if (name) return name;
  if (cid) return `Campaign ${cid}`;
  return undefined;
}

function leadId(conv) {
  return conv?.leadId || conv?.lead_id || conv?.lead?.id || conv?.profile?.id || null;
}

function leadName(conv) {
  const lead = conv?.lead || conv?.profile || conv?.prospect || {};
  return (
    conv?.name ||
    conv?.lead_name ||
    conv?.firstName ||
    lead.full_name ||
    lead.name ||
    [lead.first_name || lead.firstName, lead.last_name || lead.lastName].filter(Boolean).join(' ').trim() ||
    'LinkedIn prospect'
  );
}

function linkedinUrl(conv) {
  const lead = conv?.lead || conv?.profile || conv?.prospect || {};
  return conv?.linkedinUrl || conv?.linkedin_url || conv?.profileUrl || lead.linkedinUrl || lead.linkedin_url || lead.profile_url || null;
}

function listId(conv) {
  return conv?.listId || conv?.list_id || conv?.list?.id || null;
}

function linkedInAccountId(conv) {
  return (
    conv?.linkedinAccountId ||
    conv?.linkedin_account_id ||
    conv?.linkedInAccountId ||
    conv?.linked_in_account_id ||
    conv?.accountId ||
    conv?.sender?.id ||
    conv?.linkedin_account?.id ||
    null
  );
}

function senderId(conv) {
  return conv?.senderId || conv?.sender_id || conv?.sender?.senderId || conv?.sender?.sender_id || null;
}

function latestInbound(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isInboundMessage(m)) continue;
    const text = pickText(m);
    if (!text) continue;
    return { message: m, text, at: messageTime(m) };
  }
  return null;
}

function lastOutbound(messages) {
  let out = '';
  for (const m of messages) {
    if (!isOutboundMessage(m)) continue;
    const t = pickText(m);
    if (t) out = t;
  }
  return out;
}

function messagesForThread(messages) {
  return messages.map((m) => ({
    role: isOutboundMessage(m) ? 'us' : 'prospect',
    message: pickText(m),
    at: messageTime(m)?.toISOString?.() || m?.createdAt || m?.creation_time || null,
  })).filter((m) => m.message);
}

async function heyreachGetConversations(apiKey, { offset, limit, accountIds }) {
  const body = { offset, limit };
  if (accountIds && accountIds.length) body.accountIds = accountIds;
  const res = await fetch(`${HR_BASE}/inbox/GetConversationsV2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HeyReach GetConversationsV2 failed (${res.status}): ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

function conversationsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload;
  for (const key of ['items', 'data', 'conversations', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

async function alreadyProcessed({ clientId, campaignId: cid, leadKey, inboundMessage, inboundAt }) {
  const normalized = normWs(inboundMessage);
  if (!normalized) return true;
  const since = inboundAt || new Date(Date.now() - 48 * 3600 * 1000);
  const { rows } = await db.query(
    `SELECT 1
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'heyreach'
        AND COALESCE(campaign_id, '') = COALESCE($2, '')
        AND COALESCE(lead_id, '') = COALESCE($3, '')
        AND created_at > $4::timestamptz - interval '30 minutes'
        AND lower(regexp_replace(inbound_message, '\\s+', ' ', 'g')) = $5
      LIMIT 1`,
    [clientId, cid == null ? null : String(cid), leadKey == null ? null : String(leadKey), since, normalized]
  );
  return rows.length > 0;
}

async function maybeUpdateExistingThinReply({ clientId, campaignId: cid, leadKey, inboundMessage, threadContext, lastOutboundMessage }) {
  if (!lastOutboundMessage || !String(lastOutboundMessage).trim()) return false;
  const normalized = normWs(inboundMessage);
  if (!normalized) return false;
  const { rows } = await db.query(
    `SELECT id, thread_context, slack_message_ts
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'heyreach'
        AND COALESCE(campaign_id, '') = COALESCE($2, '')
        AND COALESCE(lead_id, '') = COALESCE($3, '')
        AND lower(regexp_replace(inbound_message, '\\s+', ' ', 'g')) = $4
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientId, cid == null ? null : String(cid), leadKey == null ? null : String(leadKey), normalized]
  );
  if (!rows.length) return false;

  let current = rows[0].thread_context;
  if (typeof current === 'string') {
    try { current = JSON.parse(current); } catch { current = null; }
  }
  const currentMessages = Array.isArray(current?.messages) ? current.messages : (Array.isArray(current) ? current : []);
  if (lastOutbound(currentMessages)) return true;

  await db.query('UPDATE pending_replies SET thread_context = $1, updated_at = now() WHERE id = $2', [
    JSON.stringify(threadContext),
    rows[0].id,
  ]);
  console.log('[HeyReachPoll] Enriched existing thin reply context', { replyId: rows[0].id });
  return true;
}

function envClients() {
  const raw = process.env.HEYREACH_POLL_CLIENTS_JSON;
  if (raw) {
    try {
      const rows = JSON.parse(raw);
      if (Array.isArray(rows)) return rows;
    } catch (err) {
      console.error('[HeyReachPoll] Invalid HEYREACH_POLL_CLIENTS_JSON', { err: err.message });
    }
  }

  const built = [];
  for (const prefix of ['SALESGLIDER', 'NIETO']) {
    const key = process.env[`${prefix}_HEYREACH_API_KEY`];
    const token = process.env[`${prefix}_SLACK_BOT_TOKEN`];
    const channel = process.env[`${prefix}_SLACK_CHANNEL_ID`];
    if (!key || !token || !channel) continue;
    built.push({
      id: process.env[`${prefix}_CLIENT_ID`] || prefix.toLowerCase(),
      name: prefix === 'SALESGLIDER' ? 'SalesGlider' : 'Nieto',
      heyreach_api_key: key,
      slack_bot_token: token,
      slack_channel_id: channel,
      booking_link: process.env[`${prefix}_BOOKING_LINK`] || null,
      voice_prompt: process.env[`${prefix}_VOICE_PROMPT`] || '',
      active: true,
    });
  }
  return built;
}

async function loadClients() {
  const { rows } = await db.query(
    `SELECT *
       FROM clients
      WHERE active IS DISTINCT FROM false
        AND heyreach_api_key IS NOT NULL
        AND heyreach_api_key <> ''`
  );
  if (rows.length) return rows;
  const fallback = envClients();
  if (fallback.length) {
    console.warn('[HeyReachPoll] No DB clients with HeyReach keys; using env fallback clients');
  }
  return fallback;
}

async function processConversation(client, conv, options) {
  const cid = campaignId(conv);
  if (!cid) return { skipped: 'missing_campaign_id' };

  const messages = conversationMessages(conv);
  const inbound = latestInbound(messages);
  if (!inbound) return { skipped: 'no_inbound' };
  const lookbackMs = options.lookbackHours * 3600 * 1000;
  if (inbound.at && Date.now() - inbound.at.getTime() > lookbackMs) return { skipped: 'older_than_lookback' };

  const convId = conversationId(conv);
  const lid = leadId(conv);
  const leadKey = lid || convId;
  if (!leadKey) return { skipped: 'missing_thread_id' };

  if (await alreadyProcessed({
    clientId: client.id,
    campaignId: cid,
    leadKey,
    inboundMessage: inbound.text,
    inboundAt: inbound.at,
  })) {
    return { skipped: 'already_processed' };
  }

  await cancelForInboundReply({
    clientId: client.id,
    platform: 'heyreach',
    campaignId: cid,
    leadId: lid,
    conversationId: convId,
  });

  const threadContext = messagesForThread(messages);
  const lastOut = lastOutbound(messages);
  if (await maybeUpdateExistingThinReply({
    clientId: client.id,
    campaignId: cid,
    leadKey,
    inboundMessage: inbound.text,
    threadContext: {
      messages: threadContext,
      heyreach: {
        listId: listId(conv),
        linkedinAccountId: linkedInAccountId(conv),
        linkedinUrl: linkedinUrl(conv),
        conversationId: convId,
        senderId: senderId(conv),
        campaignName: conv?.campaignName || conv?.campaign_name || conv?.campaign?.name || null,
      },
    },
    lastOutboundMessage: lastOut,
  })) {
    return { skipped: 'already_processed_enriched' };
  }
  const { promptBlock } = await resolveVerifiedSchedulingSlots(client, { skipExternalFetch: true });
  const result = await classifyAndDraft(threadContext, inbound.text, client.voice_prompt, client.booking_link, promptBlock);
  const { classification, draft, proposed_time, reasoning } = result;

  if (classification === 'OOO' || looksLikeOutOfOffice(inbound.text)) return { skipped: 'ooo' };
  if (classification === 'WRONG_PERSON' || looksLikeWrongPerson(inbound.text)) return { skipped: 'wrong_person' };
  if (classification === 'NOT_INTERESTED' || looksLikeNotInterested(inbound.text)) return { skipped: 'not_interested' };
  if (classification === 'REMOVE_ME' || looksLikeRemoveMe(inbound.text)) return { skipped: 'remove_me' };

  const isDraft = DRAFT_CLASSIFICATIONS.includes(classification);
  const status = isDraft ? 'pending' : 'alert_only';
  const meta = {
    messages: threadContext,
    heyreach: {
      listId: listId(conv),
      linkedinAccountId: linkedInAccountId(conv),
      linkedinUrl: linkedinUrl(conv),
      conversationId: convId,
      senderId: senderId(conv),
      campaignName: conv?.campaignName || conv?.campaign_name || conv?.campaign?.name || null,
    },
  };

  const { rows: [reply] } = await db.query(
    `INSERT INTO pending_replies
      (client_id, platform, campaign_id, lead_id, lead_name, linkedin_url, inbound_message, thread_context, classification, draft_reply, status)
     VALUES ($1, 'heyreach', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      client.id,
      cid,
      String(leadKey),
      leadName(conv),
      linkedinUrl(conv),
      inbound.text,
      JSON.stringify(meta),
      classification,
      draft,
      status,
    ]
  );

  const card = {
    replyId: reply.id,
    leadName: reply.lead_name,
    leadEmail: null,
    platform: 'heyreach',
    classification,
    draft,
    reasoning: `${reasoning} (Recovered by HeyReach polling backstop.)`,
    inboundMessage: inbound.text,
    campaignDisplay: campaignDisplay(conv, cid),
    lastOutboundMessage: lastOut || undefined,
  };

  let slackResult;
  if (isDraft) {
    slackResult = await slack.postDraftApproval(client.slack_bot_token, client.slack_channel_id, card);
  } else {
    slackResult = await slack.postAlert(client.slack_bot_token, client.slack_channel_id, card);
  }
  await db.query('UPDATE pending_replies SET slack_message_ts = $1 WHERE id = $2', [slackResult?.ts || null, reply.id]);

  if (classification === 'MEETING_PROPOSED' && linkedinUrl(conv)) {
    await db.query(
      `INSERT INTO meetings (client_id, pending_reply_id, lead_name, linkedin_url, proposed_time, status)
       VALUES ($1, $2, $3, $4, $5, 'proposed')`,
      [client.id, reply.id, reply.lead_name, linkedinUrl(conv), proposed_time]
    );
  }

  return { posted: true, replyId: reply.id };
}

let running = false;
async function pollHeyReachReplies() {
  if (!envFlag('HEYREACH_POLL_ENABLED', true)) return { processed: 0, skipped: 0 };
  if (running) {
    console.log('[HeyReachPoll] Previous run still active; skipping');
    return { processed: 0, skipped: 0 };
  }
  running = true;
  const started = Date.now();
  const totals = { processed: 0, skipped: 0 };
  try {
    const clients = await loadClients();
    const limit = numberEnv('HEYREACH_POLL_PAGE_LIMIT', 50);
    const maxConversations = numberEnv('HEYREACH_POLL_MAX_CONVERSATIONS', 100);
    const lookbackHours = numberEnv('HEYREACH_POLL_LOOKBACK_HOURS', 8);
    const accountIds = String(process.env.HEYREACH_POLL_ACCOUNT_IDS || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));

    for (const client of clients) {
      let scanned = 0;
      let posted = 0;
      for (let offset = 0; scanned < maxConversations; offset += limit) {
        const payload = await heyreachGetConversations(client.heyreach_api_key, {
          offset,
          limit,
          accountIds: accountIds.length ? accountIds : undefined,
        });
        const conversations = conversationsFromPayload(payload);
        if (!conversations.length) break;
        for (const conv of conversations) {
          if (scanned >= maxConversations) break;
          scanned++;
          try {
            const result = await processConversation(client, conv, { lookbackHours });
            if (result.posted) {
              posted++;
              totals.processed++;
            } else if (result.skipped) {
              totals.skipped++;
            }
          } catch (err) {
            console.error('[HeyReachPoll] Conversation processing failed', {
              clientId: client.id,
              client: client.name,
              err: err.message,
            });
          }
        }
        if (conversations.length < limit) break;
      }
      console.log('[HeyReachPoll] Client scan complete', { clientId: client.id, client: client.name, scanned, posted });
    }
  } catch (err) {
    console.error('[HeyReachPoll] Poll failed', { err: err.message, stack: err.stack });
  } finally {
    running = false;
    console.log('[HeyReachPoll] Finished', { ms: Date.now() - started });
  }
  return totals;
}

module.exports = {
  pollHeyReachReplies,
  heyreachGetConversations,
};
