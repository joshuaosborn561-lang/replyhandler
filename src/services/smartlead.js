const BASE_URL = 'https://server.smartlead.ai/api/v1';

async function getThreadHistory(apiKey, campaignId, leadId) {
  const url = `${BASE_URL}/campaigns/${campaignId}/leads/${leadId}/message-history?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SmartLead getThreadHistory failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function sendReply(apiKey, campaignId, leadId, replyText) {
  const url = `${BASE_URL}/campaigns/${campaignId}/leads/reply-email-thread?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_id: leadId, reply_text: replyText }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SmartLead sendReply failed (${res.status}): ${body}`);
  }
  return res.json();
}

module.exports = { getThreadHistory, sendReply };
