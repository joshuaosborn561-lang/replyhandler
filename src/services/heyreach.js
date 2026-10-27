const BASE_URL = 'https://api.heyreach.io/api/public';

const HEYREACH_LEAD_FALLBACK = 'Prospect';

function isGenericHeyreachLeadName(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  return /^(linkedin(\s+prospect)?|prospect|unknown)$/i.test(s);
}

function correspondentProfile(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj.correspondentProfile || obj.correspondent_profile || null;
}

/** Prospect display name from GetConversationsV2 row or webhook payload. */
function extractHeyreachLeadName(obj) {
  if (!obj || typeof obj !== 'object') return HEYREACH_LEAD_FALLBACK;

  const cp = correspondentProfile(obj);
  if (cp && typeof cp === 'object') {
    const fromParts = [cp.firstName, cp.lastName].filter(Boolean).join(' ').trim();
    const fromCp = fromParts
      || (typeof cp.fullName === 'string' && cp.fullName.trim())
      || (typeof cp.full_name === 'string' && cp.full_name.trim())
      || (typeof cp.name === 'string' && cp.name.trim());
    if (fromCp) return fromCp;
  }

  const lead = obj.lead && typeof obj.lead === 'object' ? obj.lead : null;
  const profile = obj.profile && typeof obj.profile === 'object' ? obj.profile : null;
  const prospect = obj.prospect && typeof obj.prospect === 'object' ? obj.prospect : null;
  const recipient = obj.recipient && typeof obj.recipient === 'object' ? obj.recipient : null;
  const fromProspect = recipient || prospect || lead || profile || {};

  const candidates = [
    obj.name,
    obj.lead_name,
    obj.leadName,
    obj.firstName,
    obj.first_name,
    fromProspect.full_name,
    fromProspect.fullName,
    fromProspect.name,
    [fromProspect.first_name || fromProspect.firstName, fromProspect.last_name || fromProspect.lastName]
      .filter(Boolean)
      .join(' ')
      .trim(),
    obj.contact?.full_name,
    obj.profile?.full_name,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() && !isGenericHeyreachLeadName(c)) return c.trim();
  }
  return HEYREACH_LEAD_FALLBACK;
}

function extractHeyreachLinkedinUrl(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const cp = correspondentProfile(obj);
  const candidates = [
    obj.linkedinUrl,
    obj.linkedin_url,
    obj.profileUrl,
    cp?.profileUrl,
    cp?.linkedinUrl,
    cp?.linkedin_url,
    obj.lead?.linkedinUrl,
    obj.lead?.linkedin_url,
    obj.lead?.profile_url,
    obj.profile?.profileUrl,
    obj.profile?.linkedin_url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

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
    { method: 'GET', url: `${BASE_URL}/campaign/GetById?campaignId=${encodeURIComponent(id)}`, body: null },
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
    const failure = new Error(`HeyReach sendMessage failed (${res.status}): ${responseBody}`);
    failure.status = res.status;
    throw failure;
  }
  try { return JSON.parse(responseBody); } catch { return { raw: responseBody }; }
}

class HeyreachLookupError extends Error {
  constructor(message, { status = null, code = 'heyreach_lookup' } = {}) {
    super(message);
    this.name = 'HeyreachLookupError';
    this.status = status;
    this.code = code;
  }
}

function fatalInboxStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500);
}

function clampPageLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(100, Math.floor(n));
}

function clampMaxPages(maxPages) {
  const n = Number(maxPages);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(30, Math.floor(n));
}

/**
 * LinkedIn /in/ slug, so https://linkedin.com/in/James-Frenchik and
 * https://www.linkedin.com/in/james-frenchik/ compare equal.
 */
function linkedinProfileSlug(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  let path = s;
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    path = new URL(withProto).pathname;
  } catch {
    path = s;
  }
  const match = path.match(/\/in\/([^/?#]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).replace(/\/+$/, '').toLowerCase();
  } catch {
    return match[1].replace(/\/+$/, '').toLowerCase();
  }
}

function canonicalLinkedinProfileUrl(url) {
  const slug = linkedinProfileSlug(url);
  if (!slug) return null;
  return `https://www.linkedin.com/in/${slug}/`;
}

function linkedinUrlsMatch(a, b) {
  const sa = linkedinProfileSlug(a);
  const sb = linkedinProfileSlug(b);
  if (sa && sb) return sa === sb;
  const na = String(a || '').trim().replace(/\/+$/, '').toLowerCase();
  const nb = String(b || '').trim().replace(/\/+$/, '').toLowerCase();
  return Boolean(na && nb && na === nb);
}

function normalizePersonName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantNameTokens(name) {
  return normalizePersonName(name).split(' ').filter((token) => token.length > 1);
}

/** First + last name, ignoring a single-letter middle initial. */
function namesMatch(wanted, conv) {
  const want = significantNameTokens(wanted);
  if (want.length < 2) return false;
  const candidates = [];
  const extracted = extractHeyreachLeadName(conv);
  if (!isGenericHeyreachLeadName(extracted)) candidates.push(extracted);
  const cp = correspondentProfile(conv);
  if (cp) {
    const fromParts = [cp.firstName, cp.lastName].filter(Boolean).join(' ');
    if (fromParts) candidates.push(fromParts);
    if (cp.fullName) candidates.push(cp.fullName);
    if (cp.full_name) candidates.push(cp.full_name);
  }
  for (const candidate of candidates) {
    const got = significantNameTokens(candidate);
    if (got.length < 2) continue;
    if (want[0] === got[0] && want[want.length - 1] === got[got.length - 1]) return true;
  }
  return false;
}

function extractHeyreachConversationId(conv) {
  if (!conv || typeof conv !== 'object') return null;
  const cid = conv.id || conv.conversationId || conv.conversation_id || conv.threadId || conv.thread_id;
  const s = cid != null ? String(cid).trim() : '';
  return s || null;
}

function extractHeyreachLinkedInAccountId(conv) {
  if (!conv || typeof conv !== 'object') return null;
  const account = conv.linkedInAccount || conv.linkedinAccount || conv.linkedin_account || null;
  const candidates = [
    conv.linkedInAccountId,
    conv.linkedinAccountId,
    conv.linkedin_account_id,
    conv.linked_in_account_id,
    conv.accountId,
    account?.id,
    account?.linkedInAccountId,
    conv.sender?.id,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const n = Number(candidate);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function conversationsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload;
  const nested = payload.data && typeof payload.data === 'object' ? payload.data : null;
  const candidates = [
    payload.items,
    payload.conversations,
    payload.results,
    Array.isArray(payload.data) ? payload.data : null,
    nested?.items,
    nested?.conversations,
    nested?.results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function lastMessageTime(conv) {
  const raw = conv?.lastMessageAt || conv?.last_message_at || conv?.updatedAt || conv?.updated_at || 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

async function getConversations(apiKey, { offset = 0, limit = 25, accountIds, filters } = {}) {
  const body = { offset, limit };
  if (Array.isArray(accountIds) && accountIds.length) body.accountIds = accountIds;
  if (filters && typeof filters === 'object') body.filters = filters;
  const res = await fetch(`${BASE_URL}/inbox/GetConversationsV2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify(body),
  });
  const responseBody = await res.text();
  if (!res.ok) {
    throw new HeyreachLookupError(
      `HeyReach GetConversationsV2 failed (${res.status}): ${responseBody.slice(0, 300)}`,
      { status: res.status, code: 'heyreach_http' },
    );
  }
  try {
    return JSON.parse(responseBody);
  } catch {
    throw new HeyreachLookupError(
      `HeyReach GetConversationsV2 returned non-JSON: ${responseBody.slice(0, 200)}`,
      { code: 'heyreach_http' },
    );
  }
}

function inboxFilters({ leadProfileUrl, searchString, linkedInAccountIds } = {}) {
  const filters = {
    linkedInAccountIds: Array.isArray(linkedInAccountIds) ? linkedInAccountIds : [],
    campaignIds: [],
    tags: [],
    searchString: searchString || '',
  };
  if (leadProfileUrl) filters.leadProfileUrl = leadProfileUrl;
  return filters;
}

function conversationMatches(conv, { conversationId, leadId, linkedinUrl }) {
  if (!conv || typeof conv !== 'object') return false;
  const cid = extractHeyreachConversationId(conv);
  if (conversationId && cid && String(cid) === String(conversationId)) return true;

  const lid = conv.leadId || conv.lead_id || conv.lead?.id || conv.profile?.id
    || conv.correspondentProfile?.linkedin_id || conv.correspondentProfile?.linkedinId;
  if (leadId && lid && String(lid) === String(leadId)) return true;

  if (linkedinUrl && linkedinUrlsMatch(extractHeyreachLinkedinUrl(conv), linkedinUrl)) return true;
  return false;
}

async function pageConversations(apiKey, { filters, maxPages, limit, accountIds }, accept) {
  const pageLimit = clampPageLimit(limit);
  const pages = clampMaxPages(maxPages);
  const matches = [];
  for (let page = 0; page < pages; page++) {
    const payload = await getConversations(apiKey, {
      offset: page * pageLimit,
      limit: pageLimit,
      accountIds,
      filters,
    });
    const rows = conversationsFromPayload(payload);
    if (!rows.length) break;
    for (const conv of rows) {
      if (accept(conv)) matches.push(conv);
    }
    if (rows.length < pageLimit) break;
  }
  return matches;
}

async function pageConversationsSoft(apiKey, options, accept) {
  try {
    return await pageConversations(apiKey, options, accept);
  } catch (err) {
    if (fatalInboxStatus(err.status)) throw err;
    if (err.status && err.status >= 400) {
      console.warn('[HeyReach] Filtered inbox lookup rejected', { status: err.status, err: err.message });
      return [];
    }
    throw err;
  }
}

function pickConversation(matches, { linkedinUrl, leadName }) {
  if (!matches.length) return null;
  const wanted = linkedinProfileSlug(linkedinUrl);
  if (wanted) {
    const urlHits = matches.filter((conv) => (
      linkedinProfileSlug(extractHeyreachLinkedinUrl(conv)) === wanted
    ));
    if (urlHits.length) {
      urlHits.sort((a, b) => lastMessageTime(b) - lastMessageTime(a));
      return urlHits[0];
    }
    // A row with a different /in/ slug is a different person, even if it was
    // the only result. A single row that omitted the URL can still be the
    // lead the profile filter just returned.
    const withOtherSlug = matches.filter((conv) => {
      const slug = linkedinProfileSlug(extractHeyreachLinkedinUrl(conv));
      return slug && slug !== wanted;
    });
    if (withOtherSlug.length) return null;
    if (matches.length === 1) return matches[0];
    throw new HeyreachLookupError(
      `HeyReach inbox lookup matched ${matches.length} conversations for ${leadName || 'this lead'}. Nothing was sent.`,
      { code: 'ambiguous' },
    );
  }
  if (matches.length === 1) return matches[0];
  const slugs = new Set(
    matches.map((conv) => linkedinProfileSlug(extractHeyreachLinkedinUrl(conv)) || ''),
  );
  if (slugs.size > 1) {
    throw new HeyreachLookupError(
      `HeyReach inbox lookup matched ${matches.length} conversations for ${leadName || 'this lead'}. Nothing was sent.`,
      { code: 'ambiguous' },
    );
  }
  const sorted = [...matches].sort((a, b) => lastMessageTime(b) - lastMessageTime(a));
  return sorted[0];
}

/**
 * Find the HeyReach conversation for a lead.
 *
 * Prefers filters.leadProfileUrl (one request for that LinkedIn URL) over
 * scanning the latest inbox page. Unfiltered paging is the fallback and
 * honors maxPages — callers that only know a name or an id should pass a
 * higher maxPages than the webhook default of 3.
 *
 * HTTP 429 / 5xx throw HeyreachLookupError. Not found returns null.
 * allowNameSearch may throw when several different people share the name.
 */
async function findConversation(apiKey, {
  conversationId,
  leadId,
  linkedinUrl,
  leadName,
  allowNameSearch = false,
  maxPages = 3,
  limit = 50,
  accountIds,
} = {}) {
  const usableLeadId = leadId != null && String(leadId).trim() && String(leadId).trim() !== 'test-lead'
    ? String(leadId).trim()
    : null;
  const strong = { conversationId, leadId: usableLeadId, linkedinUrl };

  if (linkedinUrl) {
    const canonical = canonicalLinkedinProfileUrl(linkedinUrl);
    const urls = [...new Set([canonical, String(linkedinUrl).trim()].filter(Boolean))];
    for (const url of urls) {
      const matches = await pageConversationsSoft(apiKey, {
        filters: inboxFilters({ leadProfileUrl: url, linkedInAccountIds: accountIds }),
        maxPages: 2,
        limit: Math.min(clampPageLimit(limit), 20),
        accountIds,
      }, (conv) => {
        if (linkedinUrlsMatch(extractHeyreachLinkedinUrl(conv), linkedinUrl)) return true;
        if (conversationId && extractHeyreachConversationId(conv) === String(conversationId)) return true;
        return false;
      });
      const picked = pickConversation(matches, { linkedinUrl, leadName });
      if (picked) return picked;
    }
  }

  const hasStrongKey = Boolean(conversationId || usableLeadId || linkedinUrl);
  if (hasStrongKey) {
    const unfiltered = await pageConversations(apiKey, {
      maxPages,
      limit,
      accountIds,
    }, (conv) => {
      if (linkedinUrl && linkedinUrlsMatch(extractHeyreachLinkedinUrl(conv), linkedinUrl)) return true;
      if (conversationId && extractHeyreachConversationId(conv) === String(conversationId)) return true;
      if (!linkedinUrl && usableLeadId && conversationMatches(conv, { leadId: usableLeadId })) return true;
      return false;
    });
    const urlHits = linkedinUrl
      ? unfiltered.filter((conv) => linkedinUrlsMatch(extractHeyreachLinkedinUrl(conv), linkedinUrl))
      : [];
    const fromUrl = pickConversation(urlHits, { linkedinUrl, leadName });
    if (fromUrl) return fromUrl;
    if (conversationId) {
      const byId = unfiltered.find((conv) => (
        extractHeyreachConversationId(conv) === String(conversationId)
      ));
      if (byId) return byId;
    }
    if (!linkedinUrl) {
      const fromId = pickConversation(unfiltered, { leadName });
      if (fromId) return fromId;
    }
  }

  if (allowNameSearch && leadName && !isGenericHeyreachLeadName(leadName)) {
    const matches = await pageConversationsSoft(apiKey, {
      filters: inboxFilters({ searchString: leadName, linkedInAccountIds: accountIds }),
      maxPages: Math.min(clampMaxPages(maxPages), 5),
      limit,
      accountIds,
    }, (conv) => {
      if (conversationMatches(conv, strong)) return true;
      if (!namesMatch(leadName, conv)) return false;
      const url = extractHeyreachLinkedinUrl(conv);
      if (linkedinUrl && url && !linkedinUrlsMatch(url, linkedinUrl)) return false;
      return true;
    });
    return pickConversation(matches, { linkedinUrl, leadName });
  }

  return null;
}

module.exports = {
  sendMessage,
  verifyCampaignAccess,
  tryFetchCampaignById,
  getConversations,
  findConversation,
  extractHeyreachLeadName,
  extractHeyreachLinkedinUrl,
  extractHeyreachConversationId,
  extractHeyreachLinkedInAccountId,
  linkedinProfileSlug,
  linkedinUrlsMatch,
  canonicalLinkedinProfileUrl,
  namesMatch,
  HeyreachLookupError,
  HEYREACH_LEAD_FALLBACK,
};
