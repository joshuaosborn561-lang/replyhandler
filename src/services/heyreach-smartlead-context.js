/**
 * After a HeyReach Slack card is already posted, look the same person up
 * in Smartlead and reply in that card's thread with the cold email(s) we
 * sent. Lookup failures never throw to the card poster.
 *
 * The shared Smartlead key is 200 requests/minute, and the pollers use
 * the same key. This path keeps its own queue (about one call a second,
 * ~60/min) so a long client still leaves room for the pollers. A 429
 * pushes only this queue back. It does not take a process-wide lock.
 * fetchWith429Retry still retries that one request.
 *
 * Campaign list and Smartlead client list are cached per key for 30
 * minutes. One cold lookup pays for them; later lookups reuse them.
 *
 * Worst case for one lookup, client owns N campaigns, cache cold, email
 * misses, and the person is in every owned campaign: 2 + 2N calls
 * (campaign list, Smartlead client list, N name filters, N histories).
 * A warm email hit is 1 + H, where H is how many of this client's
 * campaigns that email is actually in.
 *
 * One thread message per reply. The flag lives on
 * thread_context.heyreach.smartleadContextPosted so a card re-render
 * (chat.update) or a second post attempt does not write the thread again.
 */

const { fetchWith429Retry, historyMessages } = require('./smartlead');
const { stripHtmlToText } = require('../utils/smartlead-webhook-helpers');
const {
  withSmartleadKey,
  ownerSlugsFromTags,
  clientForSlug,
  clientFromCampaignTitle,
  tagsFromRecord,
} = require('./campaign-routing');

const BASE_URL = 'https://server.smartlead.ai/api/v1';
const NO_MATCH_LINE = 'No Smartlead match was found.';
const NO_SENT_LINE = 'Smartlead match found, but no cold email has been sent.';
const DEFAULT_GAP_MS = 1000;
const RATE_LIMIT_BACKOFF_MS = 5000;
const LIST_TTL_MS = 30 * 60 * 1000;
const MAX_EMAILS = 8;
const BODY_CAP = 1500;

let paceTail = Promise.resolve();
let paceNotBefore = 0;
const accountCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pace(gapMs) {
  const gap = Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : DEFAULT_GAP_MS;
  const run = paceTail.then(async () => {
    const wait = Math.max(0, paceNotBefore - Date.now());
    if (wait) await sleep(wait);
    paceNotBefore = Date.now() + gap;
  });
  paceTail = run.then(() => {}, () => {});
  return run;
}

function resetSmartleadContextPace() {
  paceTail = Promise.resolve();
  paceNotBefore = 0;
  accountCache.clear();
}

/** Delay only this path's next Smartlead call. Pollers do not share the queue. */
function noteContextBackoff(ms) {
  const wait = Number(ms);
  if (!Number.isFinite(wait) || wait <= 0) return;
  paceNotBefore = Math.max(paceNotBefore, Date.now() + wait);
}

function contextPaceDelayMs() {
  return Math.max(0, paceNotBefore - Date.now());
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nameParts(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

function normCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(incorporated|corporation|company|inc|llc|ltd|corp|co|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function companyMatches(wanted, found) {
  const a = normCompany(wanted);
  const b = normCompany(found);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function nameMatches(lead, parts) {
  if (!lead || !parts) return false;
  const first = String(lead.first_name || lead.firstName || '').trim().toLowerCase();
  const last = String(lead.last_name || lead.lastName || '').trim().toLowerCase();
  return first === parts.first.toLowerCase() && last === parts.last.toLowerCase();
}

function positiveInt(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function formatSentDate(raw) {
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) {
    const s = String(raw || '').trim();
    return s || 'unknown date';
  }
  return new Date(t).toISOString().slice(0, 10);
}

function sentColdEmails(history, campaignName) {
  const sent = [];
  for (const message of historyMessages(history)) {
    const type = String(message.type || message.direction || '').toUpperCase();
    if (type !== 'SENT' && type !== 'OUTBOUND') continue;
    const body = stripHtmlToText(message.email_body || message.body || message.text || '').trim();
    if (!body) continue;
    const seq = message.email_seq_number ?? message.seq_number ?? message.sequence_number;
    sent.push({
      campaignName: campaignName || 'Unknown campaign',
      seq: seq == null || seq === '' ? null : seq,
      time: message.time || message.sent_at || message.sent_time || message.created_at || '',
      subject: String(message.subject || '').trim(),
      body,
      id: message.stats_id || message.email_stats_id || message.message_id || null,
    });
  }
  sent.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  sent.forEach((row, index) => {
    if (row.seq == null || row.seq === '') row.seq = index + 1;
  });
  return sent;
}

function quoteBody(body) {
  const text = String(body || '').trim().slice(0, BODY_CAP);
  if (!text) return '_(empty)_';
  return text.split('\n').map((line) => `>${esc(line) || ' '}`).join('\n');
}

function buildSmartleadThreadMessage(result) {
  if (!result || result.status === 'error') return null;
  if (result.status !== 'match') {
    return {
      text: NO_MATCH_LINE,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: NO_MATCH_LINE } }],
    };
  }
  const emails = Array.isArray(result.emails) ? result.emails : [];
  if (!emails.length) {
    return {
      text: NO_SENT_LINE,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: NO_SENT_LINE } }],
    };
  }
  const shown = emails.slice(0, MAX_EMAILS);
  const blocks = [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Smartlead cold email* · matched by ${esc(result.matchedBy || 'email')}`,
    },
  }];
  for (const email of shown) {
    const subject = email.subject ? `\n*Subject:* ${esc(email.subject)}` : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Campaign:* ${esc(email.campaignName)}`,
          `*Step:* ${esc(email.seq)}`,
          `*Sent:* ${esc(formatSentDate(email.time))}${subject}`,
          quoteBody(email.body),
        ].join('\n'),
      },
    });
  }
  if (emails.length > shown.length) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${emails.length - shown.length} more sent email${emails.length - shown.length === 1 ? '' : 's'} not shown`,
      }],
    });
  }
  const first = shown[0];
  const text = `Smartlead cold email: ${first.campaignName}, step ${first.seq}, sent ${formatSentDate(first.time)}`;
  return { text, blocks };
}

async function smartleadJson(apiKey, { method = 'GET', path, query = {}, body = null, gapMs, fetchJson }) {
  if (fetchJson) return fetchJson({ method, path, query, body });
  await pace(gapMs);
  const params = new URLSearchParams({ api_key: apiKey });
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  const url = `${BASE_URL}${path}?${params}`;
  const res = await fetchWith429Retry(url, body == null ? { method } : {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.status === 429) noteContextBackoff(RATE_LIMIT_BACKOFF_MS);
  return { status: res.status, ok: res.ok, json };
}

function rowsOf(json, keys) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(json[key])) return json[key];
  }
  return [];
}

function normalizeLiveCampaign(row) {
  const id = positiveInt(row?.id || row?.campaign_id);
  if (!id) return null;
  return {
    id,
    name: String(row.name || row.campaign_name || '').trim(),
    clientId: positiveInt(row.client_id || row.clientId),
    tags: tagsFromRecord(row) || [],
  };
}

/**
 * Map a Smartlead client record onto one of our clients.
 * uuid match first, then a unique logo/name match. Ambiguous → null.
 * The shared SalesGlider client is ambiguous for title-owned campaigns;
 * callers only use this when tag, route, and title did not already decide.
 */
function ourClientForSmartleadClient(slClient, ourClients) {
  if (!slClient) return null;
  const uuid = String(slClient.uuid || '').trim();
  if (uuid) {
    const byId = (ourClients || []).find((c) => String(c.id) === uuid);
    if (byId) return byId;
  }
  const labels = [slClient.logo, slClient.name].map((s) => String(s || '').trim()).filter(Boolean);
  const hits = new Map();
  for (const label of labels) {
    const hit = clientForSlug(label, ourClients) || clientFromCampaignTitle(label, ourClients);
    if (hit && hit.id) hits.set(String(hit.id), hit);
  }
  if (hits.size === 1) return [...hits.values()][0];
  return null;
}

/**
 * Who owns one Smartlead campaign.
 *
 * Most reliable signal first, same order the poller already trusts:
 *   1. sg-owner tag on the campaign row (explicit; no per-campaign refetch)
 *   2. smartlead_campaign_routes (explicit map we store)
 *   3. Campaign title "Client | …" when that match is unique
 *   4. Smartlead client_id, only when that client maps to exactly one of ours
 *
 * Title comes before client_id because many of our clients share one
 * Smartlead client (SalesGlider, id 345263). "Ciotola | …" is Ciotola
 * even when Smartlead files it under SalesGlider. client_id still picks
 * up a dedicated client (PowerGRYD, BPLTG) whose title has no prefix.
 */
function attributeCampaign(campaign, { clients, routes, smartleadClientsById }) {
  const slugs = ownerSlugsFromTags(campaign.tags || []);
  if (slugs.length === 1) {
    const tagged = clientForSlug(slugs[0], clients);
    if (tagged && tagged.id) return { clientId: String(tagged.id), via: 'tag' };
  }
  const routed = routes.get(String(campaign.id));
  if (routed) return { clientId: String(routed), via: 'route' };
  const titled = clientFromCampaignTitle(campaign.name, clients);
  if (titled && titled.id) return { clientId: String(titled.id), via: 'title' };
  const sl = campaign.clientId != null ? smartleadClientsById.get(String(campaign.clientId)) : null;
  const mapped = ourClientForSmartleadClient(sl, clients);
  if (mapped && mapped.id) return { clientId: String(mapped.id), via: 'smartlead_client' };
  return null;
}

function asRouteMap(routes) {
  if (routes instanceof Map) return routes;
  const map = new Map();
  for (const row of routes || []) {
    if (row && row.campaign_id != null && row.client_id != null) {
      map.set(String(row.campaign_id), String(row.client_id));
    }
  }
  return map;
}

/**
 * Every campaign that belongs to the replying client. No numeric cap.
 * Stored ids and route rows are kept when the live list has no row, and
 * dropped when a stronger live signal assigns them to someone else.
 */
function campaignsOwnedByClient({
  replyClient,
  clients = [],
  routes = [],
  storedCampaignIds = [],
  smartleadCampaigns = [],
  smartleadClients = [],
} = {}) {
  if (!replyClient || replyClient.id == null) return [];
  const replyId = String(replyClient.id);
  const routeMap = asRouteMap(routes);
  const smartleadClientsById = new Map(
    (smartleadClients || []).map((c) => [String(c.id), c])
  );
  const live = new Map();
  for (const row of smartleadCampaigns || []) {
    const campaign = normalizeLiveCampaign(row);
    if (campaign) live.set(campaign.id, campaign);
  }
  const ctx = { clients, routes: routeMap, smartleadClientsById };
  const owned = [];
  const seen = new Set();
  const push = (id, name, via) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    owned.push({ id, name: name || null, via });
  };

  for (const campaign of live.values()) {
    const attr = attributeCampaign(campaign, ctx);
    if (attr && attr.clientId === replyId) push(campaign.id, campaign.name, attr.via);
  }

  const addIfNotContradicted = (id, via) => {
    if (!id || seen.has(id)) return;
    const campaign = live.get(id);
    if (campaign) {
      const attr = attributeCampaign(campaign, ctx);
      if (attr && attr.clientId !== replyId) return;
      push(id, campaign.name, attr && attr.clientId === replyId ? attr.via : via);
      return;
    }
    push(id, null, via);
  };

  for (const raw of storedCampaignIds || []) addIfNotContradicted(positiveInt(raw), 'stored');
  for (const [cid, ownerId] of routeMap) {
    if (ownerId !== replyId) continue;
    addIfNotContradicted(positiveInt(cid), 'route');
  }
  return owned;
}

function leadFromEmailPayload(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (!json.id) return null;
  return json;
}

function campaignsFromLead(lead) {
  const rows = Array.isArray(lead?.lead_campaign_data) ? lead.lead_campaign_data : [];
  const out = [];
  for (const row of rows) {
    const id = positiveInt(row?.campaign_id || row?.campaignId);
    if (!id) continue;
    out.push({
      id,
      name: String(row.campaign_name || row.campaignName || '').trim() || null,
    });
  }
  return out;
}

function filterLeads(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json.leads)) return json.leads;
  if (Array.isArray(json.data)) return json.data;
  return [];
}

function leadRecord(item) {
  const lead = item?.email_lead || item?.lead || item || {};
  const id = positiveInt(lead.id || item?.lead_id || item?.leadId);
  if (!id) return null;
  return {
    id,
    first_name: lead.first_name || lead.firstName || '',
    last_name: lead.last_name || lead.lastName || '',
    company_name: lead.company_name || lead.companyName || '',
    email: lead.email || '',
  };
}

async function lookupByEmail(apiKey, email, http) {
  const res = await smartleadJson(apiKey, {
    path: '/leads/',
    query: { email },
    gapMs: http.gapMs,
    fetchJson: http.fetchJson,
  });
  if (res.status === 429) {
    const err = new Error('Smartlead lead lookup still rate limited');
    err.status = 429;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`Smartlead lead lookup unauthorized (${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Smartlead lead lookup failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return leadFromEmailPayload(res.json);
}

async function searchCampaignByName(apiKey, campaignId, parts, http) {
  const res = await smartleadJson(apiKey, {
    method: 'POST',
    path: `/campaigns/${campaignId}/leads/filter`,
    body: { searchText: `${parts.first} ${parts.last}`, limit: 10 },
    gapMs: http.gapMs,
    fetchJson: http.fetchJson,
  });
  if (res.status === 404 || res.status === 400) return { leads: [], error: false };
  if (!res.ok) return { leads: [], error: true, status: res.status };
  return { leads: filterLeads(res.json), error: false };
}

async function historiesFor(apiKey, leadId, campaigns, http) {
  const emails = [];
  let error = false;
  for (const campaign of campaigns) {
    const res = await smartleadJson(apiKey, {
      path: `/campaigns/${campaign.id}/leads/${leadId}/message-history`,
      query: { show_plain_text_response: 'true' },
      gapMs: http.gapMs,
      fetchJson: http.fetchJson,
    });
    if (!res.ok) {
      error = true;
      continue;
    }
    const name = campaign.name || `Campaign ${campaign.id}`;
    emails.push(...sentColdEmails(res.json, name));
  }
  const seen = new Set();
  const unique = [];
  for (const email of emails) {
    const key = email.id ? `id:${email.id}` : `${email.time}|${email.body.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(email);
  }
  return { emails: unique, error };
}

async function nameSearch(apiKey, { name, company, campaigns, http }) {
  const parts = nameParts(name);
  if (!parts) return { status: 'none' };
  const list = [];
  const seen = new Set();
  for (const raw of campaigns || []) {
    const id = positiveInt(raw?.id ?? raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name: raw?.name || null });
  }
  if (!list.length) return { status: 'none' };

  const hits = [];
  let errors = 0;
  let okSearches = 0;
  for (const campaign of list) {
    const found = await searchCampaignByName(apiKey, campaign.id, parts, http);
    if (found.error) {
      errors += 1;
      continue;
    }
    okSearches += 1;
    for (const item of found.leads) {
      const lead = leadRecord(item);
      if (!lead || !nameMatches(lead, parts)) continue;
      if (company && !companyMatches(company, lead.company_name)) continue;
      hits.push({ lead, campaign });
    }
  }
  if (!okSearches && errors) {
    const err = new Error('Smartlead name search failed');
    err.status = 502;
    throw err;
  }
  const byLead = new Map();
  for (const hit of hits) {
    if (!byLead.has(hit.lead.id)) byLead.set(hit.lead.id, { lead: hit.lead, campaigns: [] });
    byLead.get(hit.lead.id).campaigns.push(hit.campaign);
  }
  if (byLead.size !== 1) return { status: 'none' };
  const only = [...byLead.values()][0];
  const history = await historiesFor(apiKey, only.lead.id, only.campaigns, http);
  if (history.error && !history.emails.length) {
    return { status: 'error', error: 'message_history_failed' };
  }
  return {
    status: 'match',
    matchedBy: 'name',
    leadId: only.lead.id,
    emails: history.emails,
    partial: history.error,
  };
}

/**
 * @returns {{status:'match'|'none'|'error', matchedBy?:string, emails?:object[], error?:string}}
 */
function cacheKeyFor(apiKey) {
  return String(apiKey || '').slice(0, 12);
}

async function loadAccountIndex(apiKey, http) {
  const key = cacheKeyFor(apiKey);
  const hit = accountCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit;
  const campaignsRes = await smartleadJson(apiKey, {
    path: '/campaigns/',
    gapMs: http.gapMs,
    fetchJson: http.fetchJson,
  });
  if (!campaignsRes.ok) {
    const err = new Error(`Smartlead campaign list failed (${campaignsRes.status})`);
    err.status = campaignsRes.status;
    throw err;
  }
  const clientsRes = await smartleadJson(apiKey, {
    path: '/client/',
    gapMs: http.gapMs,
    fetchJson: http.fetchJson,
  });
  const index = {
    at: Date.now(),
    campaigns: rowsOf(campaignsRes.json, ['data', 'campaigns']),
    smartleadClients: clientsRes.ok ? rowsOf(clientsRes.json, ['data', 'clients']) : [],
  };
  accountCache.set(key, index);
  return index;
}

async function storedOwnership(query, clientId) {
  const storedCampaignIds = [];
  const routes = [];
  const pull = async (sql, params, onRow) => {
    try {
      const { rows } = await query(sql, params);
      for (const row of rows || []) onRow(row);
    } catch (err) {
      console.warn('[HeyReach] Smartlead ownership lookup failed', { err: err.message });
    }
  };
  let clients = [];
  try {
    const { rows } = await query(
      `SELECT id, name FROM clients WHERE active IS DISTINCT FROM false`,
      []
    );
    clients = rows || [];
  } catch (err) {
    console.warn('[HeyReach] client list failed', { err: err.message });
  }
  await pull(
    `SELECT DISTINCT campaign_id
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'smartlead'
        AND campaign_id IS NOT NULL
        AND campaign_id <> ''`,
    [clientId],
    (row) => { if (row && row.campaign_id) storedCampaignIds.push(row.campaign_id); }
  );
  await pull(
    `SELECT campaign_id, client_id FROM smartlead_campaign_routes`,
    [],
    (row) => { if (row) routes.push(row); }
  );
  const replyClient = clients.find((c) => String(c.id) === String(clientId)) || { id: clientId, name: '' };
  return { clients, routes, storedCampaignIds, replyClient };
}

async function resolveOwnedCampaigns({ apiKey, clientId, query, http, ownership }) {
  if (Array.isArray(ownership?.ownedCampaigns)) {
    return { campaigns: ownership.ownedCampaigns };
  }
  const db = ownership || (query ? await storedOwnership(query, clientId) : {
    clients: [], routes: [], storedCampaignIds: [], replyClient: { id: clientId, name: '' },
  });
  let live = { campaigns: [], smartleadClients: [] };
  let listError = null;
  try {
    live = await loadAccountIndex(apiKey, http);
  } catch (err) {
    listError = err;
  }
  const campaigns = campaignsOwnedByClient({
    replyClient: db.replyClient,
    clients: db.clients,
    routes: db.routes,
    storedCampaignIds: db.storedCampaignIds,
    smartleadCampaigns: live.campaigns,
    smartleadClients: live.smartleadClients,
  });
  if (!campaigns.length && listError) {
    return { campaigns: [], error: String(listError.message || listError).slice(0, 200) };
  }
  return { campaigns };
}

async function findSmartleadColdEmails({
  apiKey,
  email,
  name,
  company,
  clientId = null,
  query = null,
  ownedCampaigns = null,
  ownership = null,
  gapMs = DEFAULT_GAP_MS,
  fetchJson = null,
} = {}) {
  if (!apiKey) return { status: 'error', error: 'no_api_key' };
  const http = { gapMs, fetchJson };
  try {
    const resolved = await resolveOwnedCampaigns({
      apiKey,
      clientId,
      query,
      http,
      ownership: ownedCampaigns ? { ownedCampaigns } : ownership,
    });
    if (resolved.error && !resolved.campaigns.length) {
      return { status: 'error', error: resolved.error };
    }
    const owned = resolved.campaigns || [];
    const ownedById = new Map(owned.map((c) => [c.id, c]));
    const emailAddr = String(email || '').trim();
    if (emailAddr.includes('@')) {
      const lead = await lookupByEmail(apiKey, emailAddr, http);
      if (lead) {
        const theirs = campaignsFromLead(lead)
          .filter((c) => ownedById.has(c.id))
          .map((c) => ({ id: c.id, name: ownedById.get(c.id).name || c.name }));
        if (theirs.length) {
          const history = await historiesFor(apiKey, positiveInt(lead.id), theirs, http);
          if (history.error && !history.emails.length) {
            return { status: 'error', error: 'message_history_failed' };
          }
          return {
            status: 'match',
            matchedBy: 'email',
            leadId: positiveInt(lead.id),
            emails: history.emails,
            partial: history.error,
            ownedCount: owned.length,
          };
        }
      }
    }
    if (!owned.length) return { status: 'none' };
    const found = await nameSearch(apiKey, { name, company, campaigns: owned, http });
    if (found && found.status === 'match') found.ownedCount = owned.length;
    return found;
  } catch (err) {
    return { status: 'error', error: String(err && err.message || err).slice(0, 200) };
  }
}

const CLAIM_SQL = `
UPDATE pending_replies
   SET thread_context = (
     CASE
       WHEN jsonb_typeof(thread_context) = 'array' THEN
         jsonb_build_object(
           'messages', thread_context,
           'heyreach', jsonb_build_object('smartleadContextPosted', true)
         )
       ELSE
         jsonb_set(
           jsonb_set(
             COALESCE(thread_context, '{}'::jsonb),
             '{heyreach}',
             CASE
               WHEN jsonb_typeof(thread_context->'heyreach') = 'object'
               THEN thread_context->'heyreach'
               ELSE '{}'::jsonb
             END,
             true
           ),
           '{heyreach,smartleadContextPosted}',
           'true'::jsonb,
           true
         )
     END
   )
 WHERE id = $1
   AND COALESCE(thread_context #>> '{heyreach,smartleadContextPosted}', '') <> 'true'
RETURNING id`;

const RELEASE_SQL = `
UPDATE pending_replies
   SET thread_context = jsonb_set(
     thread_context,
     '{heyreach,smartleadContextPosted}',
     'false'::jsonb,
     true
   )
 WHERE id = $1
   AND jsonb_typeof(thread_context->'heyreach') = 'object'`;

async function claimContextPost(query, replyId) {
  const { rows } = await query(CLAIM_SQL, [replyId]);
  return Boolean(rows && rows.length);
}

async function releaseContextPost(query, replyId) {
  await query(RELEASE_SQL, [replyId]);
}

async function clientSmartleadKey(query, clientId) {
  const { rows } = await query(
    `SELECT smartlead_api_key FROM clients WHERE id = $1`,
    [clientId]
  );
  const client = rows && rows[0];
  if (!client) return null;
  return withSmartleadKey(client).smartlead_api_key || null;
}

async function defaultPostThread({ token, channelId, threadTs, text, blocks }) {
  const slack = require('./slack');
  const client = slack.getClient(token);
  return client.chat.postMessage({
    channel: channelId,
    thread_ts: String(threadTs),
    text,
    blocks,
  });
}

/**
 * Post the Smartlead context once, in the card thread. Never throws.
 * Returns { posted, reason }.
 */
async function postHeyreachSmartleadContext({
  replyId,
  clientId,
  token,
  channelId,
  threadTs,
  email,
  name,
  company,
  query,
  findEmails = findSmartleadColdEmails,
  postThread = defaultPostThread,
  gapMs,
} = {}) {
  try {
    if (!replyId || !threadTs || !channelId || !token) {
      return { posted: false, reason: 'missing_thread' };
    }
    const q = query;
    if (!q) return { posted: false, reason: 'no_db' };
    const apiKey = await clientSmartleadKey(q, clientId);
    if (!apiKey) return { posted: false, reason: 'no_api_key' };
    const found = await findEmails({
      apiKey, email, name, company, clientId, query: q, gapMs,
    });
    if (!found || found.status === 'error') {
      console.warn('[HeyReach] Smartlead context lookup failed', {
        replyId, error: found && found.error,
      });
      return { posted: false, reason: 'lookup_failed' };
    }
    const message = buildSmartleadThreadMessage(found);
    if (!message) return { posted: false, reason: 'no_message' };
    const claimed = await claimContextPost(q, replyId);
    if (!claimed) return { posted: false, reason: 'already_posted' };
    try {
      await postThread({ token, channelId, threadTs, text: message.text, blocks: message.blocks });
    } catch (err) {
      await releaseContextPost(q, replyId).catch(() => {});
      console.warn('[HeyReach] Smartlead context thread post failed', {
        replyId, err: err.message,
      });
      return { posted: false, reason: 'slack_failed' };
    }
    return { posted: true, reason: found.status, matchedBy: found.matchedBy || null };
  } catch (err) {
    console.warn('[HeyReach] Smartlead context failed', {
      replyId, err: err.message,
    });
    return { posted: false, reason: 'failed' };
  }
}

module.exports = {
  NO_MATCH_LINE,
  NO_SENT_LINE,
  findSmartleadColdEmails,
  buildSmartleadThreadMessage,
  postHeyreachSmartleadContext,
  campaignsOwnedByClient,
  sentColdEmails,
  formatSentDate,
  companyMatches,
  resetSmartleadContextPace,
  noteContextBackoff,
  contextPaceDelayMs,
  CLAIM_SQL,
};
