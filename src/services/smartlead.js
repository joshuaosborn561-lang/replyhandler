const { categoryIdForClassification } = require('./smartlead-category');
const { FYI_NOTES_LINE } = require('../utils/fyi-notify');

const BASE_URL = 'https://server.smartlead.ai/api/v1';

const FETCH_429_RETRIES = (() => {
  const n = parseInt(process.env.SMARTLEAD_429_RETRIES || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 4;
})();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res, attempt) {
  const header = res && res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('retry-after')
    : '';
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  const base = 1000 * (2 ** attempt);
  return Math.min(base, 16_000);
}

/**
 * fetch() with exponential backoff on 429. Used by poller thread fetches,
 * webhook list/create, and listEmailAccounts — the shared master key 429s
 * after a burst of ~11 calls 0.4s apart.
 */
async function fetchWith429Retry(url, opts = {}, { retries = FETCH_429_RETRIES } = {}) {
  let lastRes;
  for (let attempt = 0; attempt <= retries; attempt++) {
    lastRes = await fetch(url, opts);
    if (lastRes.status !== 429 || attempt === retries) return lastRes;
    const wait = retryAfterMs(lastRes, attempt);
    console.warn('[SmartLead] 429 — retry', { wait, attempt: attempt + 1, retries });
    try { await lastRes.text(); } catch { /* ignore */ }
    await sleep(wait);
  }
  return lastRes;
}

/** apiKey prefix → { fetchedAt, list } */
const categoryListCache = new Map();
const CATEGORY_LIST_TTL_MS = 30 * 60 * 1000;

function toSmartleadId(value, name) {
  const n = typeof value === 'number' ? value : Number(String(value || '').trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`SmartLead ${name} must be a positive integer (got: ${JSON.stringify(value)})`);
  }
  return n;
}

/** apiKey prefix + campaign id → { name, fetchedAt } */
const campaignNameCache = new Map();
const CAMPAIGN_NAME_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Fetch a SmartLead campaign (includes human-readable name).
 * @see https://api.smartlead.ai/api-reference/campaigns/get-by-id
 */
async function getCampaign(apiKey, campaignId) {
  if (!apiKey || campaignId == null || campaignId === '') return null;
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const url = `${BASE_URL}/campaigns/${encodeURIComponent(cid)}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`SmartLead getCampaign failed (${res.status}): ${body.slice(0, 300)}`);
  }
  if (!body || !String(body).trim()) {
    throw new Error(`SmartLead getCampaign empty body (${res.status})`);
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`SmartLead getCampaign invalid JSON: ${String(body).slice(0, 200)}`);
  }
}

/**
 * Resolve the human campaign name, with a short in-memory cache.
 * Returns null when the campaign is missing or the API fails.
 */
async function resolveCampaignName(apiKey, campaignId) {
  if (!apiKey || campaignId == null || campaignId === '') return null;
  let cid;
  try {
    cid = toSmartleadId(campaignId, 'campaign_id');
  } catch {
    return null;
  }
  const cacheKey = `${String(apiKey).slice(0, 12)}:${cid}`;
  const hit = campaignNameCache.get(cacheKey);
  if (hit && Date.now() - hit.fetchedAt < CAMPAIGN_NAME_TTL_MS) {
    return hit.name;
  }
  try {
    const data = await getCampaign(apiKey, cid);
    const name = data?.name != null ? String(data.name).trim() : '';
    const resolved = name || null;
    campaignNameCache.set(cacheKey, { name: resolved, fetchedAt: Date.now() });
    return resolved;
  } catch (err) {
    console.warn('[SmartLead] resolveCampaignName failed', {
      campaignId: cid, err: err.message,
    });
    return null;
  }
}

/**
 * Confirms this campaign belongs to the SmartLead account for this API key.
 * @see https://api.smartlead.ai/api-reference/campaigns/get-by-id — 404 if not accessible
 */
async function verifyCampaignAccess(apiKey, campaignId) {
  if (!apiKey || campaignId == null || campaignId === '') return false;
  try {
    const data = await getCampaign(apiKey, campaignId);
    return Boolean(data && (data.id != null || data.name != null));
  } catch {
    return false;
  }
}

/**
 * Returns the raw SmartLead thread history response.
 * Real shape (confirmed against live account, not the public doc's simplified example):
 * { history: [{ stats_id, type: 'SENT'|'REPLY', message_id, time, email_body, ... }, ...] }
 */
async function getThreadHistory(apiKey, campaignId, leadId) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const lid = toSmartleadId(leadId, 'lead_id');
  const url = `${BASE_URL}/campaigns/${cid}/leads/${lid}/message-history?api_key=${encodeURIComponent(apiKey)}&show_plain_text_response=true`;
  const res = await fetchWith429Retry(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SmartLead getThreadHistory failed (${res.status}): ${body}`);
  }
  return res.json();
}

function historyMessages(historyResponse) {
  if (!historyResponse || typeof historyResponse !== 'object') return [];
  if (Array.isArray(historyResponse.history)) return historyResponse.history;
  if (Array.isArray(historyResponse.messages)) return historyResponse.messages;
  if (Array.isArray(historyResponse)) return historyResponse;
  return [];
}

function extractForwardAnchorFromHistory(historyResponse) {
  const rows = [];
  for (const m of historyMessages(historyResponse)) {
    if (!m || typeof m !== 'object') continue;
    const messageId = m.message_id || m.messageId || null;
    const statsId = m.stats_id || m.email_stats_id || m.emailStatsId || m.statsId || null;
    if (!messageId || !statsId) continue;
    rows.push({
      messageId: String(messageId),
      statsId: String(statsId),
      type: String(m.type || m.direction || '').toUpperCase(),
      time: m.time || m.sent_at || m.received_at || m.created_at || '',
    });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const replies = rows.filter((r) => r.type === 'REPLY');
  const pool = replies.length ? replies : rows;
  return pool[pool.length - 1];
}

/**
 * Extract the `email_stats_id` to reply against.
 * SmartLead's reply endpoint expects the stats_id of a SENT message in the thread
 * (not the inbound REPLY) — it's how SmartLead correlates the follow-up to a sent email.
 * We pick the most recent SENT message's stats_id.
 */
function extractStatsIdFromHistory(historyResponse) {
  if (!historyResponse || typeof historyResponse !== 'object') return null;
  const list = Array.isArray(historyResponse.history)
    ? historyResponse.history
    : Array.isArray(historyResponse.messages)
      ? historyResponse.messages
      : Array.isArray(historyResponse)
        ? historyResponse
        : [];

  const withStats = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const stats = m.stats_id || m.email_stats_id || m.emailStatsId || m.statsId || null;
    if (!stats) continue;
    withStats.push({
      stats: String(stats),
      type: String(m.type || m.direction || '').toUpperCase(),
      time: m.time || m.sent_at || m.received_at || m.created_at || '',
    });
  }
  if (!withStats.length) return null;

  // Prefer most recent SENT/outbound (SmartLead replies attach to a sent email)
  const sent = withStats.filter((x) => x.type === 'SENT' || x.type === 'OUTBOUND');
  const pool = sent.length ? sent : withStats;
  pool.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return pool[pool.length - 1].stats;
}

/**
 * Resolve the stats_id for a given campaign/lead via message-history.
 * Returns null if unavailable.
 */
async function resolveEmailStatsId(apiKey, campaignId, leadId) {
  try {
    const history = await getThreadHistory(apiKey, campaignId, leadId);
    return extractStatsIdFromHistory(history);
  } catch (err) {
    console.error('[SmartLead] resolveEmailStatsId failed', { err: err.message });
    return null;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function trimUrlTrailingPunct(url) {
  let u = String(url);
  while (u.length > 0) {
    const c = u[u.length - 1];
    if (')]}>'.includes(c) || (c === '.' && !u.includes('?'))) {
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  return u;
}

function formatPlainTextAsSmartleadHtml(plain) {
  const normalized = String(plain || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const urlRe = /(https?:\/\/[^\s<]+)/gi;
  return lines
    .map((line) => {
      const parts = [];
      let last = 0;
      let m;
      while ((m = urlRe.exec(line)) !== null) {
        parts.push(escapeHtml(line.slice(last, m.index)));
        const raw = m[1];
        const url = trimUrlTrailingPunct(raw);
        const tail = raw.slice(url.length);
        const h = escapeHtml(url);
        parts.push(`<a href="${h}">${h}</a>${escapeHtml(tail)}`);
        last = m.index + raw.length;
      }
      parts.push(escapeHtml(line.slice(last)));
      return parts.join('');
    })
    .join('<br/>');
}

function looksLikeHandwrittenHtmlEmailBody(s) {
  const t = String(s || '');
  return /<\s*(a\s|br\s|\/\s*br|p\s|div\s|span\s|table\s|html\s)/i.test(t);
}

function shouldHtmlifyOutboundBody() {
  const v = process.env.SMARTLEAD_OUTBOUND_HTML;
  if (v === undefined || v === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** POST /campaigns/{campaign_id}/reply-email-thread — never /leads/reply-email-thread (misroutes lead_id). */
function replyEmailThreadUrl(apiKey, campaignId) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  return `${BASE_URL}/campaigns/${cid}/reply-email-thread?api_key=${encodeURIComponent(apiKey)}`;
}

function explainSmartleadSendError(status, responseBody, campaignId, leadId, stats) {
  const body = String(responseBody || '');
  if (
    status === 400 &&
    /"lead_id"\s*must be a number/i.test(body) &&
    /"params"/i.test(body)
  ) {
    return (
      `SmartLead sendReply failed (${status}): ${body}. ` +
      'This usually means the app called /campaigns/{id}/leads/reply-email-thread instead of /campaigns/{id}/reply-email-thread. ' +
      'Redeploy the latest app build, then retry Approve on the Slack card.'
    );
  }
  const lid = leadId != null && leadId !== '' ? leadId : 'n/a';
  return `SmartLead sendReply failed (${status}) [campaign_id=${campaignId} lead_id=${lid} stats_id=${stats}]: ${body}`;
}

/**
 * SmartLead reply endpoint.
 * @see https://api.smartlead.ai/api-reference/campaigns/reply-email-thread
 * Required: email_stats_id, email_body (lead_id is not a path param on this route).
 *
 * SmartLead POST /campaigns/{id}/reply-email-thread accepts `cc` and `bcc`
 * as comma-separated strings (field name `cc`, never an array). Default send
 * still omits both (deliverability); "Approve & Send + CC client" opts into
 * `cc` with the Always-forward address. `bcc` is unused.
 * Client notify is via Gmail / forwardThreadToClient, independent of this CC.
 */
async function sendReply(apiKey, campaignId, leadId, {
  replyText, emailStatsId, cc, bcc,
  recipient, toEmail, toFirstName,
  replyMessageId, replyEmailTime, replyEmailBody,
  requireCc = false, requiredCc = null,
} = {}) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  let stats = String(emailStatsId || '').trim();
  let lidForLog = leadId;
  if (!stats && leadId != null && leadId !== '') {
    const lid = toSmartleadId(leadId, 'lead_id');
    lidForLog = lid;
    stats = (await resolveEmailStatsId(apiKey, cid, lid)) || '';
  }
  if (!stats) {
    const lidHint = leadId != null && leadId !== '' ? toSmartleadId(leadId, 'lead_id') : 'unknown';
    throw new Error(
      `SmartLead sendReply missing email_stats_id [campaign_id=${cid} lead_id=${lidHint}] — no SENT message found in thread history`
    );
  }
  let emailBody = String(replyText || '');
  if (shouldHtmlifyOutboundBody() && !looksLikeHandwrittenHtmlEmailBody(emailBody)) {
    emailBody = formatPlainTextAsSmartleadHtml(emailBody);
  }

  const url = replyEmailThreadUrl(apiKey, cid);
  if (/\/leads\/reply-email-thread/i.test(url)) {
    throw new Error('SmartLead sendReply internal error: misconstructed reply URL');
  }

  const payload = {
    email_stats_id: stats,
    email_body: emailBody,
    add_signature: true,
  };
  // Docs (reply-email-thread): to_email (optional, defaults to lead email),
  // to_first_name (optional), reply_message_id, reply_email_body (quoted
  // original so the quoted line matches the TO), reply_email_time.
  // `recipient` is rejected with 400 — never send it.
  // https://api.smartlead.ai/api-reference/campaigns/reply-email-thread
  const to = String(toEmail || recipient || '').trim();
  if (to) payload.to_email = to;
  const first = String(toFirstName || '').trim();
  if (first && first.toLowerCase() !== 'there') payload.to_first_name = first;
  const replyId = typeof replyMessageId === 'string' ? replyMessageId.trim() : '';
  if (replyId) payload.reply_message_id = replyId;
  const quoted = typeof replyEmailBody === 'string' ? replyEmailBody.trim() : '';
  if (quoted) payload.reply_email_body = quoted;
  const replyTime = typeof replyEmailTime === 'string' ? replyEmailTime.trim() : '';
  if (replyTime) payload.reply_email_time = replyTime;
  // SmartLead field is `cc` (comma-separated string). Never an array.
  if (typeof cc === 'string') {
    const ccStr = cc.trim();
    if (ccStr) payload.cc = ccStr;
  }
  if (typeof bcc === 'string') {
    const bccStr = bcc.trim();
    if (bccStr) payload.bcc = bccStr;
  }

  // A referred-contact send must include cc. Do not POST a reply that would
  // go out without it.
  if (requireCc) {
    const have = String(payload.cc || '').toLowerCase();
    const need = Array.isArray(requiredCc) && requiredCc.length
      ? requiredCc
      : String(payload.cc || '').split(',').map((s) => s.trim()).filter(Boolean);
    const missing = need.filter((email) => !have.includes(String(email).toLowerCase()));
    if (!payload.cc || missing.length) {
      const who = (missing.length ? missing : need).join(', ') || 'the referred contact';
      throw new Error(`SmartLead reply would go out without CC ${who}. Nothing was sent.`);
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const responseBody = await res.text();
  if (!res.ok) {
    throw new Error(explainSmartleadSendError(res.status, responseBody, cid, lidForLog, stats));
  }
  // SmartLead's reply endpoint sometimes returns plain text (e.g. "Email added to the queue, will be sent out soon!")
  // even though docs show JSON. Parse defensively.
  try { return JSON.parse(responseBody); } catch { return { ok: true, raw: responseBody }; }
}

/**
 * Forward a thread copy to the client (always-CC / round-robin).
 * Prospect reply is sent separately with no CC — this is the client notify path.
 * @see https://api.smartlead.ai/api-reference/inbox/forward
 */
async function forwardThreadToClient(apiKey, campaignId, leadId, {
  toEmail,
  leadName,
  leadEmail,
  sentText,
  cellPhone,
  phoneProvider,
}) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const to = String(toEmail || '').trim();
  if (!to) throw new Error('Client forward email is empty');

  let anchor = null;
  if (leadId != null && leadId !== '') {
    const lid = toSmartleadId(leadId, 'lead_id');
    const history = await getThreadHistory(apiKey, cid, lid);
    anchor = extractForwardAnchorFromHistory(history);
  }
  if (!anchor) {
    throw new Error('Could not find a thread message to forward for the client copy');
  }

  const lead = String(leadName || 'prospect').trim() || 'prospect';
  const emailLine = leadEmail
    ? ` (${escapeHtml(String(leadEmail).trim())})`
    : '';
  const phone = String(cellPhone || '').trim();
  const phoneLine = phone
    ? `<p><strong>Cell:</strong> ${escapeHtml(phone)}${phoneProvider ? ` <em>(via ${escapeHtml(phoneProvider)})</em>` : ''}</p>`
    : '<p><strong>Cell:</strong> not found</p>';

  const forwardBody = (
    `<p>FYI — reply sent to ${escapeHtml(lead)}${emailLine}:</p>` +
    `<p>${escapeHtml(FYI_NOTES_LINE)}</p>` +
    phoneLine +
    `<p>${formatPlainTextAsSmartleadHtml(sentText)}</p>`
  );
  const url = `${BASE_URL}/campaigns/${cid}/forward-email?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message_id: anchor.messageId,
      stats_id: anchor.statsId,
      to_emails: to,
      forward_email_subject: `Copy: reply to ${lead}`,
      forward_email_body: forwardBody,
    }),
  });
  const responseBody = await res.text();
  if (!res.ok) {
    throw new Error(`SmartLead forward-email failed (${res.status}): ${responseBody}`);
  }
  try { return JSON.parse(responseBody); } catch { return { ok: true, raw: responseBody }; }
}

async function fetchMasterInboxPage(apiKey, offset, limit) {
  const url = `${BASE_URL}/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=true`;
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
  if (!res.ok) throw new Error(`SmartLead master-inbox failed (${res.status}): ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { return {}; }
}

/**
 * Webhooks often ship sl_email_lead_id + stats_id but omit email_campaign_id.
 * Look up the campaign (and lead) from master inbox when ids are incomplete.
 */
/**
 * GET /leads/?email= — the lead's real id, its campaigns, and its own phone.
 * Used when a webhook arrives without sl_email_lead_id.
 * @returns {Promise<{leadId:string, campaignIds:string[], lead:object}|null>}
 */
async function lookupLeadByEmail(apiKey, email) {
  if (!apiKey || !email) return null;
  const url = `${BASE_URL}/leads/?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(String(email).trim())}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SmartLead lead lookup failed (${res.status})`);
  const lead = await res.json().catch(() => null);
  if (!lead || !lead.id) return null;
  const campaignIds = (Array.isArray(lead.lead_campaign_data) ? lead.lead_campaign_data : [])
    .map((c) => c && (c.campaign_id || c.campaignId))
    .filter((c) => c != null)
    .map(String);
  return { leadId: String(lead.id), campaignIds, lead };
}

/** Pick the campaign: keep the payload's if the lead is really in it, else the lead's latest. */
function pickLeadCampaign(payloadCampaignId, campaignIds = []) {
  const want = payloadCampaignId != null ? String(payloadCampaignId) : null;
  if (want && (!campaignIds.length || campaignIds.includes(want))) return want;
  return campaignIds.length ? campaignIds[campaignIds.length - 1] : want;
}

async function resolveIdsFromMasterInbox(apiKey, { leadId, leadEmail, statsId } = {}, maxPages = 6) {
  if (!apiKey) return null;
  const wantLead = leadId != null && String(leadId).trim() ? String(leadId).trim() : null;
  const wantEmail = leadEmail ? String(leadEmail).trim().toLowerCase() : null;
  const wantStats = statsId ? String(statsId).trim() : null;
  if (!wantLead && !wantEmail && !wantStats) return null;

  const pageSize = 25;
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    let payload;
    try {
      payload = await fetchMasterInboxPage(apiKey, offset, pageSize);
    } catch (err) {
      console.error('[SmartLead] resolveIdsFromMasterInbox fetch failed', { err: err.message, page });
      break;
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!rows.length) break;

    for (const row of rows) {
      const rowLead = row.email_lead_id || row.emailLeadId || row.sl_email_lead_id || null;
      const rowEmail = String(row.lead_email || row.email || '').trim().toLowerCase();
      const rowCampaign = row.email_campaign_id || row.emailCampaignId || null;
      const hist = Array.isArray(row.email_history) ? row.email_history : [];
      const statsMatch = wantStats && hist.some((h) => String(h.stats_id || h.email_stats_id || '') === wantStats);

      const leadMatch = wantLead && rowLead != null && String(rowLead) === wantLead;
      const emailMatch = wantEmail && rowEmail && rowEmail === wantEmail;

      if ((leadMatch || emailMatch || statsMatch) && rowCampaign) {
        return {
          campaignId: String(rowCampaign),
          leadId: rowLead != null ? String(rowLead) : wantLead,
          inboxRow: row,
        };
      }
    }
    if (rows.length < pageSize) break;
  }
  return null;
}

/**
 * Account lead categories (Interested, Not Interested, …).
 * @see GET /leads/fetch-categories
 */
async function fetchLeadCategories(apiKey) {
  if (!apiKey) throw new Error('SmartLead fetchLeadCategories missing api_key');
  const cacheKey = String(apiKey).slice(0, 12);
  const hit = categoryListCache.get(cacheKey);
  if (hit && Date.now() - hit.fetchedAt < CATEGORY_LIST_TTL_MS) {
    return hit.list;
  }
  const url = `${BASE_URL}/leads/fetch-categories?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`SmartLead fetchLeadCategories failed (${res.status}): ${body.slice(0, 300)}`);
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch {
    throw new Error(`SmartLead fetchLeadCategories invalid JSON: ${body.slice(0, 200)}`);
  }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
  categoryListCache.set(cacheKey, { list, fetchedAt: Date.now() });
  return list;
}

/**
 * Set a campaign lead's SmartLead category.
 * @see POST /campaigns/{campaign_id}/leads/{lead_id}/category
 */
async function updateLeadCategory(apiKey, campaignId, leadId, categoryId) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const lid = toSmartleadId(leadId, 'lead_id');
  const cat = toSmartleadId(categoryId, 'category_id');
  const url = `${BASE_URL}/campaigns/${cid}/leads/${lid}/category?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category_id: cat }),
  });
  const responseBody = await res.text();
  if (!res.ok) {
    throw new Error(`SmartLead updateLeadCategory failed (${res.status}): ${responseBody.slice(0, 300)}`);
  }
  try { return JSON.parse(responseBody); } catch { return { ok: true, raw: responseBody }; }
}

/**
 * Resolve the account's "Not Interested" category and apply it to this lead.
 */
async function markLeadNotInterested(apiKey, campaignId, leadId) {
  const categories = await fetchLeadCategories(apiKey);
  const categoryId = categoryIdForClassification(categories, 'NOT_INTERESTED');
  if (categoryId == null) {
    throw new Error('SmartLead has no "Not Interested" category on this account');
  }
  const result = await updateLeadCategory(apiKey, campaignId, leadId, categoryId);
  return { categoryId, result };
}

const emailAccountCache = new Map();
const EMAIL_ACCOUNT_TTL_MS = 10 * 60 * 1000;

function emailsFromAccountRow(row) {
  if (!row || typeof row !== 'object') return [];
  const candidates = [
    row.email, row.from_email, row.fromEmail, row.username,
    row.smtp_user, row.smtpUser, row.imap_user, row.imapUser,
  ];
  const out = [];
  for (const c of candidates) {
    const e = String(c || '').trim().toLowerCase();
    if (e.includes('@')) out.push(e);
  }
  return out;
}

/**
 * Sending mailboxes on this SmartLead key. Cached; misses are empty (fail-open).
 */
async function listEmailAccounts(apiKey) {
  if (!apiKey) return [];
  const cacheKey = String(apiKey).slice(0, 12);
  const hit = emailAccountCache.get(cacheKey);
  if (hit && Date.now() - hit.at < EMAIL_ACCOUNT_TTL_MS) return hit.emails;
  const emails = [];
  try {
    const pageSize = 100;
    let offset = 0;
    for (;;) {
      const url = `${BASE_URL}/email-accounts?api_key=${encodeURIComponent(apiKey)}&offset=${offset}&limit=${pageSize}`;
      const res = await fetchWith429Retry(url);
      const body = await res.text();
      if (!res.ok) {
        console.warn('[SmartLead] listEmailAccounts failed', { status: res.status, body: body.slice(0, 200) });
        break;
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const rows = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.data) ? parsed.data
          : Array.isArray(parsed?.email_accounts) ? parsed.email_accounts
            : [];
      if (!rows.length) break;
      for (const row of rows) emails.push(...emailsFromAccountRow(row));
      if (rows.length < pageSize) break;
      offset += pageSize;
    }
  } catch (err) {
    console.warn('[SmartLead] listEmailAccounts error', { err: err.message });
  }
  const unique = [...new Set(emails)];
  emailAccountCache.set(cacheKey, { at: Date.now(), emails: unique });
  return unique;
}

async function listCampaigns(apiKey) {
  if (!apiKey) return [];
  const url = `${BASE_URL}/campaigns?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetchWith429Retry(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`SmartLead listCampaigns failed (${res.status}): ${body.slice(0, 300)}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.campaigns)) return parsed.campaigns;
  return [];
}

async function listCampaignWebhooks(apiKey, campaignId) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const url = `${BASE_URL}/campaigns/${cid}/webhooks?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetchWith429Retry(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`SmartLead list webhooks failed (${res.status}): ${body.slice(0, 300)}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = []; }
  if (Array.isArray(parsed)) return parsed;
  return parsed?.data || parsed?.webhooks || [];
}

async function createEmailReplyWebhook(apiKey, campaignId, webhookUrl, { name = 'ReplyHandler EMAIL_REPLY' } = {}) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const url = `${BASE_URL}/webhook/create?api_key=${encodeURIComponent(apiKey)}`;
  const payload = {
    name,
    webhook_url: webhookUrl,
    email_campaign_id: cid,
    association_type: 'campaign',
    event_type_map: { EMAIL_REPLY: true },
    force_create: true,
  };
  const res = await fetchWith429Retry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`SmartLead create webhook failed (${res.status}): ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { return { ok: true, raw: body }; }
}

function webhookHasEmailReply(hook, targetUrl) {
  if (!hook) return false;
  const events = (hook.event_types || hook.eventTypes || []).map((e) => String(e).toUpperCase());
  const map = hook.event_type_map || hook.eventTypeMap || {};
  const mapHit = Object.entries(map).some(([k, v]) => String(k).toUpperCase() === 'EMAIL_REPLY' && v);
  const hookUrl = String(hook.webhook_url || hook.webhookUrl || '').split('?')[0];
  const want = String(targetUrl || '').split('?')[0];
  return (events.includes('EMAIL_REPLY') || mapHit) && hookUrl === want;
}

module.exports = {
  getThreadHistory,
  sendReply,
  forwardThreadToClient,
  getCampaign,
  resolveCampaignName,
  verifyCampaignAccess,
  resolveEmailStatsId,
  resolveIdsFromMasterInbox,
  lookupLeadByEmail,
  pickLeadCampaign,
  extractStatsIdFromHistory,
  extractForwardAnchorFromHistory,
  formatPlainTextAsSmartleadHtml,
  looksLikeHandwrittenHtmlEmailBody,
  fetchLeadCategories,
  updateLeadCategory,
  markLeadNotInterested,
  listEmailAccounts,
  listCampaigns,
  listCampaignWebhooks,
  createEmailReplyWebhook,
  webhookHasEmailReply,
  historyMessages,
  fetchWith429Retry,
};
