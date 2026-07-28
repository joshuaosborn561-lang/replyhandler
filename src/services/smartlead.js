const BASE_URL = 'https://server.smartlead.ai/api/v1';

/**
 * Confirms this campaign belongs to the SmartLead account for this API key.
 * @see https://api.smartlead.ai/api-reference/campaigns/get-by-id — 404 if not accessible
 */
async function verifyCampaignAccess(apiKey, campaignId) {
  if (!apiKey || campaignId == null || campaignId === '') return false;
  const url = `${BASE_URL}/campaigns/${encodeURIComponent(campaignId)}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  return res.ok;
}

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

/**
 * @see https://api.smartlead.ai/reference/forward-reply
 */
async function forwardEmail(apiKey, campaignId, { messageId, statsId, toEmails, ccEmails, bccEmails, subject, body }) {
  const url = `${BASE_URL}/campaigns/${campaignId}/forward-email?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message_id: messageId,
      stats_id: statsId,
      to_emails: toEmails,
      ...(ccEmails ? { cc_emails: ccEmails } : {}),
      ...(bccEmails ? { bcc_emails: bccEmails } : {}),
      ...(subject ? { forward_email_subject: subject } : {}),
      ...(body ? { forward_email_body: body } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`SmartLead forwardEmail failed (${res.status}): ${errText}`);
  }
  return res.json();
}

module.exports = { getThreadHistory, sendReply, forwardEmail, verifyCampaignAccess };
