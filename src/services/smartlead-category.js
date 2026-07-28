/**
 * Resolve SmartLead's own native reply category for a lead and map it to an
 * internal action bucket. SmartLead classifies replies itself (Interested,
 * Meeting Request, Not Interested, Do Not Contact, Information Request,
 * Out Of Office, Wrong Person, Team member) — we use that directly instead
 * of asking Gemini to classify SmartLead email replies.
 *
 * Only "Do Not Contact" (remove_me) and "Out Of Office" are ever silent.
 * Everything else — including Not Interested / Wrong Person, and any
 * category we fail to determine — defaults to notify + draft. Missing a
 * real interested/objection reply is worse than an extra approval card
 * that gets rejected.
 */
const BASE_URL = 'https://server.smartlead.ai/api/v1';

function firstCategoryField(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const v = obj.category || obj.lead_category_name || obj.lead_category || obj.category_name || obj.categoryName;
  return v ? String(v) : null;
}

function categoryFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const direct = firstCategoryField(payload);
  if (direct) return direct;
  for (const key of ['lead', 'lead_data', 'data']) {
    const nested = payload[key];
    const v = firstCategoryField(nested);
    if (v) return v;
  }
  return null;
}

function categoryFromHistoryResponse(historyResponse) {
  if (!historyResponse || typeof historyResponse !== 'object') return null;
  const direct = firstCategoryField(historyResponse);
  if (direct) return direct;
  for (const key of ['lead', 'lead_data']) {
    const nested = historyResponse[key];
    const v = firstCategoryField(nested);
    if (v) return v;
  }
  return null;
}

async function fetchLeadCategoryDirect(apiKey, campaignId, leadId) {
  try {
    const url = `${BASE_URL}/campaigns/${campaignId}/leads/${leadId}?api_key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return categoryFromHistoryResponse(data);
  } catch (err) {
    console.warn('[SmartleadCategory] Direct lead fetch failed', { err: err.message });
    return null;
  }
}

function mapCategoryToAction(categoryName) {
  const normalized = String(categoryName || '').trim().toLowerCase();
  // Unknown/unparsed category — never assume silent. Default to full visibility.
  if (!normalized) return 'notify_draft';
  if (normalized.includes('do not contact') || normalized.includes('unsubscribe') || /\bremove\b/.test(normalized)) {
    return 'remove_me';
  }
  if (normalized.includes('out of office') || normalized === 'ooo') {
    return 'silent_ooo';
  }
  if (normalized.includes('meeting')) {
    return 'meeting_proposed';
  }
  // Interested, Not Interested, Information Request, Wrong Person, Team member,
  // or anything else SmartLead surfaces — all come to Slack with a draft.
  return 'notify_draft';
}

/**
 * @returns {Promise<{ category: string|null, action: 'remove_me'|'silent_ooo'|'meeting_proposed'|'notify_draft' }>}
 */
async function resolveSmartleadCategory({ apiKey, campaignId, leadId, webhookPayload, threadHistory }) {
  let category = categoryFromPayload(webhookPayload) || categoryFromHistoryResponse(threadHistory);

  if (!category) {
    category = await fetchLeadCategoryDirect(apiKey, campaignId, leadId);
  }

  if (!category) {
    console.warn('[SmartleadCategory] Could not determine category — defaulting to notify_draft', { campaignId, leadId });
  }

  return { category, action: mapCategoryToAction(category) };
}

module.exports = { resolveSmartleadCategory, mapCategoryToAction };
