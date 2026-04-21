const BASE_URL = 'https://api.heyreach.io/api/public';

function toHeyreachInt(value, name) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`HeyReach ${name} must be a positive integer (got: ${JSON.stringify(value)})`);
  }
  return n;
}

function nonEmptyString(value) {
  const s = String(value ?? '').trim();
  return s ? s : null;
}

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

function campaignIdMatchesResponse(target, payload) {
  if (!payload || typeof payload !== 'object') return false;
  const t = String(target).trim();
  const candidates = [
    payload.id,
    payload.campaignId,
    payload.campaign_id,
    payload?.data?.id,
    payload?.data?.campaignId,
    payload?.data?.campaign_id,
    payload?.campaign?.id,
    payload?.campaign?.campaignId,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim() === t) return true;
  }
  return false;
}

/**
 * Try a cheap "fetch this campaign" call before paging GetAll.
 * HeyReach has evolved endpoint shapes; we probe a few common patterns.
 */
async function tryFetchCampaignById(apiKey, campaignId) {
  const id = String(campaignId).trim();
  const headers = { 'Content-Type': 'application/json', 'X-API-KEY': apiKey };

  const attempts = [
    { method: 'GET', url: `${BASE_URL}/campaign/${encodeURIComponent(id)}`, body: null },
    { method: 'POST', url: `${BASE_URL}/campaign/GetById`, body: JSON.stringify({ id: Number(id) || id }) },
    { method: 'POST', url: `${BASE_URL}/campaign/GetById`, body: JSON.stringify({ campaignId: Number(id) || id }) },
    { method: 'POST', url: `${BASE_URL}/campaign/Get`, body: JSON.stringify({ id: Number(id) || id }) },
  ];

  for (const a of attempts) {
    try {
      const res = await fetch(a.url, {
        method: a.method,
        headers,
        body: a.body,
      });
      if (res.status === 404) continue;
      if (!res.ok) continue;
      const payload = await res.json();
      if (campaignIdMatchesResponse(id, payload)) return true;
    } catch {
      // ignore — fall through to GetAll
    }
  }
  return false;
}

/**
 * Paginates HeyReach GetAll until the campaign id is found or lists are exhausted.
 */
async function verifyCampaignAccess(apiKey, campaignId) {
  if (!apiKey || campaignId == null || String(campaignId).trim() === '') return false;
  const target = String(campaignId).trim();

  if (await tryFetchCampaignById(apiKey, target)) return true;

  let offset = 0;
  const limit = 100;
  const maxPages = 50;

  for (let page = 0; page < maxPages; page++) {
    const res = await fetch(`${BASE_URL}/campaign/GetAll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
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

/**
 * Send an inbox reply.
 * HeyReach public API: POST /inbox/SendMessage with a FLAT body (verified live; wrapping in { input } returns 404).
 * Prefer conversationId + linkedInAccountId. Include senderId if the webhook provided it.
 */
async function sendMessage(apiKey, { conversationId, linkedInAccountId, senderId, listId, linkedinUrl, message }) {
  const msg = String(message || '');
  const url = `${BASE_URL}/inbox/SendMessage`;

  // conversationId is an opaque base64-ish string (e.g. "2-ZWMzZDIzYjk...") — do NOT coerce to int.
  const cid = nonEmptyString(conversationId);
  const aid = toHeyreachInt(linkedInAccountId, 'linkedInAccountId');
  const sid = toHeyreachInt(senderId, 'senderId');
  const lid = toHeyreachInt(listId, 'listId');
  const lurl = nonEmptyString(linkedinUrl);

  console.log('[HeyReach] Sending message', {
    conversationId: cid, linkedInAccountId: aid, senderId: sid, listId: lid, linkedinUrl: lurl, messageLength: msg.length,
  });

  // VERIFIED against live HeyReach API: /inbox/SendMessage expects a FLAT body
  // (no { input: ... } wrapper). Wrapping returns 404 "This conversation does not exist".
  let body;
  if (cid && aid) {
    body = { conversationId: cid, linkedInAccountId: aid, message: msg };
    if (sid) body.senderId = sid;
  } else if (lid && aid && lurl) {
    body = { listId: lid, linkedInAccountId: aid, linkedinUrl: lurl, message: msg };
    if (sid) body.senderId = sid;
  } else {
    throw new Error(
      `HeyReach sendMessage missing required identifiers (conversationId+linkedInAccountId OR listId+linkedInAccountId+linkedinUrl). Got: ` +
      JSON.stringify({ conversationId, linkedInAccountId, senderId, listId, linkedinUrl })
    );
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify(body),
  });

  const responseBody = await res.text();
  console.log('[HeyReach] Response', { status: res.status, body: responseBody });

  if (!res.ok) {
    throw new Error(`HeyReach sendMessage failed (${res.status}): ${responseBody}`);
  }
  try { return JSON.parse(responseBody); } catch { return { raw: responseBody }; }
}

module.exports = { sendMessage, verifyCampaignAccess, tryFetchCampaignById };
