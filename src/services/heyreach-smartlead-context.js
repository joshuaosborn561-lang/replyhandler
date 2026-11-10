/**
 * After a HeyReach Slack card is already posted, look the same person up
 * in Smartlead and reply in that card's thread with the cold email(s) we
 * sent. Lookup failures never throw to the card poster.
 *
 * The shared Smartlead key is 200 requests/minute. This path spaces its
 * own calls and reuses fetchWith429Retry. It does not pace the poller.
 *
 * One thread message per reply. The flag lives on
 * thread_context.heyreach.smartleadContextPosted so a card re-render
 * (chat.update) or a second post attempt does not write the thread again.
 */

const { fetchWith429Retry, historyMessages } = require('./smartlead');
const { stripHtmlToText } = require('../utils/smartlead-webhook-helpers');
const { withSmartleadKey } = require('./campaign-routing');

const BASE_URL = 'https://server.smartlead.ai/api/v1';
const NO_MATCH_LINE = 'No Smartlead match was found.';
const NO_SENT_LINE = 'Smartlead match found, but no cold email has been sent.';
const DEFAULT_GAP_MS = 350;
const DEFAULT_NAME_CAP = 12;
const MAX_CAMPAIGNS_PER_LEAD = 6;
const MAX_EMAILS = 8;
const BODY_CAP = 1500;

let paceTail = Promise.resolve();
let paceNotBefore = 0;

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
  return { status: res.status, ok: res.ok, json };
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
  return out.slice(0, MAX_CAMPAIGNS_PER_LEAD);
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
  for (const campaign of campaigns.slice(0, MAX_CAMPAIGNS_PER_LEAD)) {
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

async function nameSearch(apiKey, { name, company, campaignIds, http }) {
  const parts = nameParts(name);
  if (!parts) return { status: 'none' };
  const cap = http.nameCap || DEFAULT_NAME_CAP;
  const ids = [];
  const seen = new Set();
  for (const raw of campaignIds || []) {
    const id = positiveInt(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= cap) break;
  }
  if (ids.length < cap && http.listCampaignIds) {
    let listed = [];
    try {
      listed = await http.listCampaignIds(apiKey);
    } catch (err) {
      if (!ids.length) throw err;
    }
    for (const raw of listed || []) {
      const id = positiveInt(raw?.id ?? raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= cap) break;
    }
  }
  if (!ids.length) return { status: 'none' };

  const hits = [];
  let errors = 0;
  let okSearches = 0;
  for (const id of ids) {
    const found = await searchCampaignByName(apiKey, id, parts, http);
    if (found.error) {
      errors += 1;
      continue;
    }
    okSearches += 1;
    for (const item of found.leads) {
      const lead = leadRecord(item);
      if (!lead || !nameMatches(lead, parts)) continue;
      if (company && !companyMatches(company, lead.company_name)) continue;
      hits.push({ lead, campaignId: id });
    }
  }
  if (!okSearches && errors) {
    const err = new Error('Smartlead name search failed');
    err.status = 502;
    throw err;
  }
  const byLead = new Map();
  for (const hit of hits) {
    if (!byLead.has(hit.lead.id)) byLead.set(hit.lead.id, { lead: hit.lead, campaignIds: [] });
    byLead.get(hit.lead.id).campaignIds.push(hit.campaignId);
  }
  if (byLead.size !== 1) return { status: 'none' };
  const only = [...byLead.values()][0];
  const campaigns = only.campaignIds.slice(0, MAX_CAMPAIGNS_PER_LEAD).map((id) => ({ id, name: null }));
  const history = await historiesFor(apiKey, only.lead.id, campaigns, http);
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
async function findSmartleadColdEmails({
  apiKey,
  email,
  name,
  company,
  campaignIds = [],
  gapMs = DEFAULT_GAP_MS,
  nameCap = DEFAULT_NAME_CAP,
  fetchJson = null,
  listCampaignIds,
} = {}) {
  if (!apiKey) return { status: 'error', error: 'no_api_key' };
  const http = { gapMs, nameCap, fetchJson, listCampaignIds };
  const emailAddr = String(email || '').trim();
  try {
    if (emailAddr.includes('@')) {
      const lead = await lookupByEmail(apiKey, emailAddr, http);
      if (lead) {
        const history = await historiesFor(apiKey, positiveInt(lead.id), campaignsFromLead(lead), http);
        if (history.error && !history.emails.length) {
          return { status: 'error', error: 'message_history_failed' };
        }
        return {
          status: 'match',
          matchedBy: 'email',
          leadId: positiveInt(lead.id),
          emails: history.emails,
          partial: history.error,
        };
      }
    }
    // No account-wide campaign scan. One shared key covers every client, and
    // walking the campaign list would burn the 200/min budget and can attach
    // another client's sequence. Name search stays inside the ids we already
    // have for this client, plus any list the caller passes in tests.
    const listed = typeof listCampaignIds === 'function' ? listCampaignIds : async () => [];
    return await nameSearch(apiKey, {
      name,
      company,
      campaignIds,
      http: { ...http, listCampaignIds: listed },
    });
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

async function clientCampaignIds(query, clientId) {
  const ids = [];
  const pull = async (sql) => {
    try {
      const { rows } = await query(sql, [clientId]);
      for (const row of rows || []) {
        if (row && row.campaign_id) ids.push(row.campaign_id);
      }
    } catch (err) {
      console.warn('[HeyReach] Smartlead campaign id lookup failed', { err: err.message });
    }
  };
  await pull(
    `SELECT DISTINCT campaign_id
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'smartlead'
        AND campaign_id IS NOT NULL
        AND campaign_id <> ''
      LIMIT 40`
  );
  await pull(
    `SELECT campaign_id
       FROM smartlead_campaign_routes
      WHERE client_id = $1
      LIMIT 40`
  );
  return ids;
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
    const campaignIds = email ? [] : await clientCampaignIds(q, clientId);
    const found = await findEmails({
      apiKey, email, name, company, campaignIds, gapMs,
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
  sentColdEmails,
  formatSentDate,
  companyMatches,
  resetSmartleadContextPace,
  CLAIM_SQL,
};
