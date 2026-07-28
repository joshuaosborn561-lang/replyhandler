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

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPlainTextAsSmartleadHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
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
 * Fallback when the primary Gmail notify fails: forward a thread copy via SmartLead's
 * own forward-email endpoint, with a custom body (lead name/email, cell phone if found,
 * and the reply we just sent).
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
  const to = String(toEmail || '').trim();
  if (!to) throw new Error('Client forward email is empty');

  let anchor = null;
  if (leadId != null && leadId !== '') {
    const history = await getThreadHistory(apiKey, campaignId, leadId);
    anchor = extractForwardAnchorFromHistory(history);
  }
  if (!anchor) {
    throw new Error('Could not find a thread message to forward for the client copy');
  }

  const lead = String(leadName || 'prospect').trim() || 'prospect';
  const emailLine = leadEmail ? ` (${escapeHtml(String(leadEmail).trim())})` : '';
  const phone = String(cellPhone || '').trim();
  const phoneLine = phone
    ? `<p><strong>Cell:</strong> ${escapeHtml(phone)}${phoneProvider ? ` <em>(via ${escapeHtml(phoneProvider)})</em>` : ''}</p>`
    : '<p><strong>Cell:</strong> not found</p>';

  const forwardBody = (
    `<p>FYI — reply sent to ${escapeHtml(lead)}${emailLine}:</p>` +
    phoneLine +
    `<p>${formatPlainTextAsSmartleadHtml(sentText)}</p>`
  );

  const url = `${BASE_URL}/campaigns/${campaignId}/forward-email?api_key=${encodeURIComponent(apiKey)}`;
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

module.exports = {
  getThreadHistory,
  sendReply,
  forwardThreadToClient,
  verifyCampaignAccess,
  extractForwardAnchorFromHistory,
  formatPlainTextAsSmartleadHtml,
};
