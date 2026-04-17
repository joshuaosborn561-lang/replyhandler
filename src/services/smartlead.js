const BASE_URL = 'https://server.smartlead.ai/api/v1';

function toSmartleadId(value, name) {
  const n = typeof value === 'number' ? value : Number(String(value || '').trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`SmartLead ${name} must be a positive integer (got: ${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * Confirms this campaign belongs to the SmartLead account for this API key.
 * @see https://api.smartlead.ai/api-reference/campaigns/get-by-id — 404 if not accessible
 */
async function verifyCampaignAccess(apiKey, campaignId) {
  if (!apiKey || campaignId == null || campaignId === '') return false;
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const url = `${BASE_URL}/campaigns/${encodeURIComponent(cid)}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  return res.ok;
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

/**
 * SmartLead reply endpoint.
 * @see https://api.smartlead.ai/api-reference/campaigns/reply-email-thread
 * Required: email_stats_id, email_body.
 */
async function sendReply(apiKey, campaignId, leadId, { replyText, emailStatsId }) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const lid = toSmartleadId(leadId, 'lead_id');
  let stats = String(emailStatsId || '').trim();
  if (!stats) {
    // Last-resort in-line resolution so Slack Approve never silently 400s.
    stats = (await resolveEmailStatsId(apiKey, cid, lid)) || '';
  }
  if (!stats) {
    throw new Error(`SmartLead sendReply missing email_stats_id [campaign_id=${cid} lead_id=${lid}] — no SENT message found in thread history`);
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
    throw new Error(`SmartLead sendReply failed (${res.status}) [campaign_id=${cid} lead_id=${lid} stats_id=${stats}]: ${responseBody}`);
  }
  // SmartLead's reply endpoint sometimes returns plain text (e.g. "Email added to the queue, will be sent out soon!")
  // even though docs show JSON. Parse defensively.
  try { return JSON.parse(responseBody); } catch { return { ok: true, raw: responseBody }; }
}

module.exports = {
  getThreadHistory,
  sendReply,
  verifyCampaignAccess,
  resolveEmailStatsId,
  extractStatsIdFromHistory,
};
