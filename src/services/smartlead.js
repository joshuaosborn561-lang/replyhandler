const BASE_URL = 'https://server.smartlead.ai/api/v1';

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
  const res = await fetch(url);
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
 * Note: we intentionally do NOT CC clients on the prospect reply (deliverability).
 * Client notify is via forwardThreadToClient. The live API accepts `cc` if ever needed.
 */
async function sendReply(apiKey, campaignId, leadId, { replyText, emailStatsId, ccEmails }) {
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
  const cc = String(ccEmails || '').trim();
  if (cc) payload.cc = cc;

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

module.exports = {
  getThreadHistory,
  sendReply,
  forwardThreadToClient,
  getCampaign,
  resolveCampaignName,
  verifyCampaignAccess,
  resolveEmailStatsId,
  resolveIdsFromMasterInbox,
  extractStatsIdFromHistory,
  extractForwardAnchorFromHistory,
  formatPlainTextAsSmartleadHtml,
  looksLikeHandwrittenHtmlEmailBody,
};
