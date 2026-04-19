#!/usr/bin/env node
/**
 * Build training pairs: last prospect message (inbound) -> your next outbound reply,
 * from SmartLead message-history and HeyReach conversation threads.
 *
 * Usage: DATABASE_URL=... node scripts/extract-reply-pairs-for-voice.js
 * Env: same throttling as export-manual-replies; optional MAX_* to limit API volume.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function resolveDatabaseUrl() {
  const u = process.env.DATABASE_URL;
  if (u && !/railway\.internal/.test(u)) return u;
  const host = process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const port = process.env.RAILWAY_TCP_PROXY_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  const pass = process.env.POSTGRES_PASSWORD;
  const db = process.env.POSTGRES_DB || 'railway';
  if (host && pass) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }
  return u || null;
}

const SL_BASE = 'https://server.smartlead.ai/api/v1';
const HR_BASE = 'https://api.heyreach.io/api/public';
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), 'training-exports');
const MAX_CAMPAIGNS = parseInt(process.env.MAX_CAMPAIGNS || '40', 10);
const MAX_LEADS_PER_CAMPAIGN = parseInt(process.env.MAX_LEADS_PER_CAMPAIGN || '40', 10);
const MAX_CONVERSATIONS = parseInt(process.env.MAX_CONVERSATIONS || '400', 10);
const SL_DELAY_MS = parseInt(process.env.SMARTLEAD_DELAY_MS || '1100', 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithRetry(url, opts = {}, { retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    const text = await res.text();
    if (res.status === 429 && attempt < retries) {
      const wait = 2000 * (attempt + 1);
      console.warn(`[SmartLead] 429, retry in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 80)}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  throw new Error('fetchJsonWithRetry exhausted retries');
}

function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCampaignList(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload;
  const candidates = [payload.data, payload.campaigns, payload.items];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  const vals = Object.values(payload);
  if (vals.length && vals.every((v) => v && typeof v === 'object' && (v.id != null || v.campaign_id != null))) {
    return vals;
  }
  return [];
}

function campaignIdFromRow(row) {
  if (row == null) return null;
  if (typeof row === 'number' || typeof row === 'string') return String(row);
  return String(row.id ?? row.campaign_id ?? row.campaignId ?? '');
}

const OBJECTION_RE = /\b(not interested|unsubscribe|remove me|stop emailing|wrong person|no thanks|no thank you|hard pass|not a fit|don't contact|do not contact)\b/i;

function looksLikeObjectionOrEdgeInbound(text) {
  const t = String(text || '').trim();
  if (t.length < 8) return true;
  return OBJECTION_RE.test(t);
}

async function listSmartleadCampaigns(apiKey) {
  await sleep(SL_DELAY_MS);
  const url = `${SL_BASE}/campaigns?api_key=${encodeURIComponent(apiKey)}`;
  return fetchJsonWithRetry(url);
}

async function fetchCampaignLeads(apiKey, campaignId, offset, limit) {
  await sleep(SL_DELAY_MS);
  const url = `${SL_BASE}/campaigns/${campaignId}/leads?api_key=${encodeURIComponent(apiKey)}&offset=${offset}&limit=${limit}`;
  const data = await fetchJsonWithRetry(url);
  const leads = data.data || data.leads || data.items || [];
  const total = data.total_leads ?? data.total ?? data.count ?? leads.length;
  return { leads, total };
}

async function fetchSmartleadHistory(apiKey, campaignId, leadId) {
  await sleep(SL_DELAY_MS);
  const url = `${SL_BASE}/campaigns/${campaignId}/leads/${leadId}/message-history?api_key=${encodeURIComponent(apiKey)}&show_plain_text_response=true`;
  return fetchJsonWithRetry(url);
}

function historyToSortedMessages(hist) {
  const list = Array.isArray(hist?.history)
    ? hist.history
    : Array.isArray(hist)
      ? hist
      : [];
  const rows = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    const time = m.time || m.sent_at || m.received_at || m.created_at || '';
    const body = stripHtml(m.email_body || m.body || m.text || '');
    if (!body) continue;
    rows.push({ type, body, time: String(time) });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time));
  return rows;
}

/** Pairs: for each outbound, the nearest prior inbound (REPLY). */
function pairFromSmartLeadThread(sorted) {
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur.type !== 'SENT' && cur.type !== 'OUTBOUND') continue;
    let j = i - 1;
    while (j >= 0) {
      const prev = sorted[j];
      if (prev.type === 'REPLY' || prev.type === 'INBOUND') {
        pairs.push({ inbound: prev.body, outbound: cur.body });
        break;
      }
      j--;
    }
  }
  return pairs;
}

async function exportSmartLeadPairs(clientName, apiKey) {
  const pairs = [];
  if (!apiKey) return pairs;
  let campaigns;
  try {
    campaigns = extractCampaignList(await listSmartleadCampaigns(apiKey));
  } catch (e) {
    console.warn('[SmartLead] list campaigns failed', e.message);
    return pairs;
  }
  const rows = campaigns.slice(0, MAX_CAMPAIGNS);
  console.log(`[SmartLead] ${clientName}: scanning ${rows.length} campaigns for reply pairs`);

  for (const c of rows) {
    const cid = campaignIdFromRow(c);
    if (!cid) continue;
    let offset = 0;
    let leadCount = 0;
    while (leadCount < MAX_LEADS_PER_CAMPAIGN) {
      let batch;
      try {
        batch = await fetchCampaignLeads(apiKey, cid, offset, 100);
      } catch (e) {
        console.warn(`[SmartLead] campaign ${cid} leads failed`, e.message);
        break;
      }
      const leads = batch.leads || [];
      if (!leads.length) break;

      for (const lead of leads) {
        const lid = lead.lead?.id ?? lead.id ?? lead.lead_id ?? lead.leadId;
        if (lid == null) continue;
        leadCount++;
        try {
          const hist = await fetchSmartleadHistory(apiKey, cid, lid);
          const sorted = historyToSortedMessages(hist);
          const threadPairs = pairFromSmartLeadThread(sorted);
          for (const p of threadPairs) {
            if (looksLikeObjectionOrEdgeInbound(p.inbound)) continue;
            pairs.push({
              platform: 'smartlead',
              client: clientName,
              campaign_id: cid,
              lead_id: String(lid),
              lead_email: lead.lead?.email ?? lead.email ?? null,
              inbound: p.inbound,
              outbound: p.outbound,
            });
          }
        } catch {
          /* skip */
        }
      }
      offset += 100;
      const totalLeads = batch.total ?? 0;
      if (offset >= totalLeads || leads.length < 100) break;
    }
    await sleep(SL_DELAY_MS * 2);
  }
  console.log(`[SmartLead] ${clientName}: ${pairs.length} inbound->outbound pairs (non-objection filter)`);
  return pairs;
}

async function heyreachGetConversations(apiKey, { offset, limit, accountIds }) {
  const body = { offset, limit };
  if (accountIds && accountIds.length) body.accountIds = accountIds;
  const res = await fetch(`${HR_BASE}/inbox/GetConversationsV2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HeyReach GetConversationsV2 ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function pairFromHeyreachMessages(msgs) {
  const sorted = [...msgs].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (String(m.sender || '') !== 'ME') continue;
    const out = String(m.body || '').trim();
    if (!out) continue;
    let j = i - 1;
    while (j >= 0) {
      const prev = sorted[j];
      if (String(prev.sender || '') === 'ME') {
        j--;
        continue;
      }
      const inn = String(prev.body || '').trim();
      if (inn) pairs.push({ inbound: inn, outbound: out });
      break;
    }
  }
  return pairs;
}

async function exportHeyreachPairs(clientName, apiKey) {
  const pairs = [];
  if (!apiKey) return pairs;
  const raw = process.env.HEYREACH_ACCOUNT_IDS;
  const accountIds = raw
    ? raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n))
    : [];

  let offset = 0;
  const limit = 50;
  let scanned = 0;

  while (scanned < MAX_CONVERSATIONS) {
    let data;
    try {
      data = await heyreachGetConversations(apiKey, { offset, limit, accountIds: accountIds.length ? accountIds : undefined });
    } catch (e) {
      console.warn('[HeyReach] GetConversationsV2 failed', e.message);
      break;
    }
    const items = data.items || data.data || [];
    if (!items.length) break;

    for (const conv of items) {
      scanned++;
      if (scanned > MAX_CONVERSATIONS) break;
      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      const threadPairs = pairFromHeyreachMessages(msgs);
      for (const p of threadPairs) {
        if (looksLikeObjectionOrEdgeInbound(p.inbound)) continue;
        pairs.push({
          platform: 'heyreach',
          client: clientName,
          conversation_id: conv.id || null,
          inbound: p.inbound,
          outbound: p.outbound,
        });
      }
    }

    if (items.length < limit) break;
    offset += limit;
  }

  console.log(`[HeyReach] ${clientName}: ${pairs.length} inbound->outbound pairs (non-objection filter)`);
  return pairs;
}

async function loadClientsFromDb() {
  const url = resolveDatabaseUrl();
  if (!url) return null;
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, smartlead_api_key, heyreach_api_key FROM clients WHERE active IS DISTINCT FROM false`
    );
    return rows;
  } finally {
    await pool.end();
  }
}

async function main() {
  const clients = await loadClientsFromDb();
  const singleSl = process.env.SMARTLEAD_API_KEY;
  const singleHr = process.env.HEYREACH_API_KEY;

  let targets = [];
  if (clients && clients.length) {
    targets = clients.map((c) => ({
      name: c.name,
      smartlead_api_key: c.smartlead_api_key,
      heyreach_api_key: c.heyreach_api_key,
    }));
  } else if (singleSl || singleHr) {
    targets = [{ name: process.env.EXPORT_CLIENT_NAME || 'single', smartlead_api_key: singleSl || null, heyreach_api_key: singleHr || null }];
  } else {
    console.error('Set DATABASE_URL (Postgres) or SMARTLEAD_API_KEY / HEYREACH_API_KEY');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const all = [];

  for (const t of targets) {
    all.push(...(await exportSmartLeadPairs(t.name, t.smartlead_api_key)));
    all.push(...(await exportHeyreachPairs(t.name, t.heyreach_api_key)));
  }

  const jsonl = path.join(OUT_DIR, `reply-pairs-${stamp}.jsonl`);
  const jsonPath = path.join(OUT_DIR, `reply-pairs-${stamp}.json`);
  const fd = fs.createWriteStream(jsonl);
  for (const row of all) {
    fd.write(JSON.stringify(row) + '\n');
  }
  fd.end();
  fs.writeFileSync(jsonPath, JSON.stringify(all, null, 2));

  const canon = all
    .filter((p) => p.inbound.length >= 15 && p.outbound.length >= 10)
    .slice(0, 80);

  const voiceFile = path.join(OUT_DIR, `voice-prompt-suggested-${stamp}.txt`);
  const examplesBlock = canon
    .slice(0, 12)
    .map(
      (p, i) =>
        `Example ${i + 1}:\nProspect: ${p.inbound.slice(0, 500)}${p.inbound.length > 500 ? '...' : ''}\nYou: ${p.outbound.slice(0, 800)}${p.outbound.length > 800 ? '...' : ''}\n`
    )
    .join('\n');

  const voicePrompt = `You are ghostwriting replies for Joshua / SalesGlider Growth. Match this voice exactly.

Style rules (from real threads):
- Short, direct, warm. Sound like a practitioner who sells IT/MSP services, not a marketer.
- Lead with acknowledgment or answer the specific question they asked; avoid filler openers like "Great question" or long preambles.
- Social proof is concrete when used: revenue closed, years in IT sales, "performance-based" / no retainer, 30-day intro, ~5 meetings/month type framing.
- Often offer a Loom or a very short call; Calendly/booking link when scheduling.
- Sign naturally when it fits the channel (first name + SalesGlider Growth on email-style threads).
- Do not use em dashes (—) or en dashes (–); use commas or a single hyphen (-) if needed.

Canon examples (prospect message -> your reply). Mirror length, pacing, and CTA:

${examplesBlock}`;

  fs.writeFileSync(voiceFile, voicePrompt);

  console.log(`\nDone.\n  ${jsonl}\n  ${jsonPath}\n  ${voiceFile}\nTotal pairs: ${all.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
