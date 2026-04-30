const BASE_URL = 'https://api.heyreach.io/api/public';

function extractCampaignList(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload;
  const nested = payload.data;
  const candidates = [
    payload.items,
    payload.campaigns,
    payload.results,
    payload.collection,
    payload.value,
    Array.isArray(nested) ? nested : nested?.items,
    nested?.campaigns,
    nested?.data,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function campaignRowId(row) {
  if (row == null) return null;
  if (typeof row === 'number' || typeof row === 'string') return String(row);
  const id = row.id ?? row.campaignId ?? row.campaign_id ?? row.CampaignId;
  return id != null ? String(id) : null;
}

function campaignIdMatchesResponse(payload, target) {
  if (!payload || typeof payload !== 'object') return false;
  const t = String(target).trim();
  const candidates = [
    payload.id,
    payload.campaignId,
    payload.campaign_id,
    payload.data?.id,
    payload.data?.campaignId,
    payload.campaign?.id,
  ];
  return candidates.some((v) => v != null && String(v).trim() === t);
}

/**
 * Confirms campaign belongs to this HeyReach workspace for the API key.
 * Tries GetById first, then paginates GetAll as fallback.
 */
async function verifyCampaignAccess(apiKey, campaignId) {
  if (!apiKey || campaignId == null || String(campaignId).trim() === '') return false;
  const target = String(campaignId).trim();

  try {
    const res = await fetch(
      `${BASE_URL}/campaign/GetById?campaignId=${encodeURIComponent(target)}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      }
    );
    if (res.ok) {
      try {
        const payload = await res.json();
        if (campaignIdMatchesResponse(payload, target)) return true;
      } catch {
        return true;
      }
    }
  } catch (err) {
    console.warn('[HeyReach] GetById error', { campaignId: target, err: err.message });
  }

  let offset = 0;
  const limit = 100;
  const maxPages = 50;

  for (let page = 0; page < maxPages; page++) {
    const res = await fetch(`${BASE_URL}/campaign/GetAll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({ offset, limit }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HeyReach GetAll failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const payload = await res.json();
    const rows = extractCampaignList(payload);
    for (const row of rows) {
      if (campaignRowId(row) === target) return true;
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return false;
}

async function sendMessage(apiKey, listId, linkedinAccountId, linkedinUrl, message) {
  const url = `${BASE_URL}/inbox/send-message`;
  console.log('[HeyReach] Sending message', { listId, linkedinUrl, messageLength: message.length });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      listId,
      linkedinAccountId,
      linkedinUrl,
      message,
    }),
  });

  const responseBody = await res.text();
  console.log('[HeyReach] Response', { status: res.status, body: responseBody });

  if (!res.ok) {
    throw new Error(`HeyReach sendMessage failed (${res.status}): ${responseBody}`);
  }

  try {
    return JSON.parse(responseBody);
  } catch {
    return { raw: responseBody };
  }
}

module.exports = { sendMessage, verifyCampaignAccess };
