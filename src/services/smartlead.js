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

async function getThreadHistory(apiKey, campaignId, leadId) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const lid = toSmartleadId(leadId, 'lead_id');
  const url = `${BASE_URL}/campaigns/${cid}/leads/${lid}/message-history?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SmartLead getThreadHistory failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function sendReply(apiKey, campaignId, leadId, replyText) {
  const cid = toSmartleadId(campaignId, 'campaign_id');
  const lid = toSmartleadId(leadId, 'lead_id');
  // SmartLead v1 API: POST /campaigns/{campaign_id}/reply-email-thread (not /leads/reply-email-thread)
  // Body: lead_id (number) + email_body (string). Other fields optional.
  const url = `${BASE_URL}/campaigns/${cid}/reply-email-thread?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_id: lid, email_body: String(replyText || '') }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SmartLead sendReply failed (${res.status}) [campaign_id=${cid} lead_id=${lid}]: ${body}`);
  }
  return res.json();
}

module.exports = { getThreadHistory, sendReply, verifyCampaignAccess };
