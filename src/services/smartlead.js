const BASE_URL = 'https://server.smartlead.ai/api/v1';

function toPositiveInt(value, name) {
  const n = typeof value === 'number' ? value : Number(String(value || '').trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`SmartLead ${name} must be a positive integer (got: ${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * Confirms this campaign belongs to the SmartLead account for this API key.
 */
async function verifyCampaignAccess(apiKey, campaignId) {
  if (!apiKey || campaignId == null || campaignId === '') return false;
  try {
    const cid = toPositiveInt(campaignId, 'campaign_id');
    const url = `${BASE_URL}/campaigns/${encodeURIComponent(cid)}?api_key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function getThreadHistory(apiKey, campaignId, leadId) {
  const cid = toPositiveInt(campaignId, 'campaign_id');
  const lid = toPositiveInt(leadId, 'lead_id');
  const url = `${BASE_URL}/campaigns/${cid}/leads/${lid}/message-history?api_key=${encodeURIComponent(apiKey)}&show_plain_text_response=true`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SmartLead getThreadHistory failed (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * Pick email_stats_id from history for POST /campaigns/{id}/reply-email-thread (latest SENT row).
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

  const rows = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const stats = m.stats_id || m.email_stats_id || m.emailStatsId || m.statsId || null;
    if (!stats) continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    const time = m.time || m.sent_at || m.received_at || m.created_at || '';
    rows.push({ stats: String(stats), type, time: String(time) });
  }
  if (!rows.length) return null;

  const sent = rows.filter((x) => x.type === 'SENT' || x.type === 'OUTBOUND');
  const pool = sent.length ? sent : rows;
  pool.sort((a, b) => a.time.localeCompare(b.time));
  return pool[pool.length - 1].stats;
}

async function resolveEmailStatsId(apiKey, campaignId, leadId) {
  try {
    const hist = await getThreadHistory(apiKey, campaignId, leadId);
    return extractStatsIdFromHistory(hist);
  } catch (err) {
    console.error('[SmartLead] resolveEmailStatsId failed', { err: err.message });
    return null;
  }
}

/**
 * Reply endpoint: POST /campaigns/{campaign_id}/reply-email-thread
 * Body: email_stats_id, email_body (not /leads/reply-email-thread — that misroutes lead_id).
 */
async function sendReply(apiKey, campaignId, leadId, replyText, emailStatsId = null) {
  const cid = toPositiveInt(campaignId, 'campaign_id');
  let stats = String(emailStatsId || '').trim();
  if (!stats) {
    stats = (await resolveEmailStatsId(apiKey, cid, leadId)) || '';
  }
  if (!stats) {
    throw new Error(
      `SmartLead sendReply missing email_stats_id [campaign_id=${cid} lead_id=${leadId}] — no SENT message in thread history`
    );
  }

  const url = `${BASE_URL}/campaigns/${cid}/reply-email-thread?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email_stats_id: stats,
      email_body: String(replyText || ''),
      add_signature: true,
    }),
  });
  const responseBody = await res.text();
  if (!res.ok) {
    throw new Error(`SmartLead sendReply failed (${res.status}) [campaign_id=${cid} stats_id=${stats}]: ${responseBody}`);
  }
  try {
    return JSON.parse(responseBody);
  } catch {
    return { ok: true, raw: responseBody };
  }
}

module.exports = {
  getThreadHistory,
  sendReply,
  verifyCampaignAccess,
  extractStatsIdFromHistory,
  resolveEmailStatsId,
};
