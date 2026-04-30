#!/usr/bin/env node
/**
 * Export YOUR outbound replies from SmartLead + HeyReach for Gemini training / few-shot examples.
 *
 * SmartLead: pulls message-history per lead; keeps rows where type === 'SENT' (your side of the thread).
 * HeyReach: pulls GetConversationsV2; keeps messages where sender === 'ME'.
 *
 * Usage:
 *   # All clients from Postgres (Railway: railway run node scripts/export-manual-replies-for-training.js)
 *   DATABASE_URL=... node scripts/export-manual-replies-for-training.js
 *
 *   # Single account without DB:
 *   SMARTLEAD_API_KEY=... HEYREACH_API_KEY=... HEYREACH_ACCOUNT_IDS=154688 node scripts/export-manual-replies-for-training.js
 *
 * Env:
 *   OUT_DIR              output directory (default: ./training-exports)
 *   MAX_CAMPAIGNS        max SmartLead campaigns to scan (default: 50)
 *   MAX_LEADS_PER_CAMPAIGN  max leads per campaign (default: 50; each lead = 2 API calls)
 *   MAX_CONVERSATIONS    max HeyReach conversations to scan (default: 500)
 *   SMARTLEAD_DELAY_MS   throttle between SmartLead calls (default: 1100) — avoids 429 rate limits
 *   HEYREACH_ACCOUNT_IDS comma-separated LinkedIn account ids for GetConversationsV2 (optional)
 *
 * Railway:
 *   Link Postgres service, then: railway run -- node scripts/export-manual-replies-for-training.js
 *   (builds DATABASE_URL from TCP proxy if internal hostname is not resolvable)
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/**
 * Railway often injects DATABASE_URL with host postgres.railway.internal (not resolvable off-platform).
 * If RAILWAY_TCP_PROXY_* + POSTGRES_* are present (Postgres plugin), build a reachable URL.
 */
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
const MAX_CAMPAIGNS = parseInt(process.env.MAX_CAMPAIGNS || '50', 10);
const MAX_LEADS_PER_CAMPAIGN = parseInt(process.env.MAX_LEADS_PER_CAMPAIGN || '50', 10);
const MAX_CONVERSATIONS = parseInt(process.env.MAX_CONVERSATIONS || '500', 10);
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
      console.warn(`[SmartLead] 429 — retry in ${wait}ms`);
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

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 80)}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractCampaignList(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload;
  const candidates = [payload.data, payload.campaigns, payload.items];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  // SmartLead sometimes returns { "0": {...}, "1": {...} } (numeric keys, not an array)
  const vals = Object.values(payload);
  if (vals.length && vals.every((v) => v && typeof v === 'object' && (v.id != null || v.campaign_id != null))) {
    return vals;
  }
  return [];
}

async function listSmartleadCampaigns(apiKey) {
  await sleep(SL_DELAY_MS);
  const url = `${SL_BASE}/campaigns?api_key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJsonWithRetry(url);
  return extractCampaignList(data);
}

function campaignIdFromRow(row) {
  if (row == null) return null;
  if (typeof row === 'number' || typeof row === 'string') return String(row);
  return String(row.id ?? row.campaign_id ?? row.campaignId ?? '');
}

async function fetchCampaignLeads(apiKey, campaignId, offset, limit) {
  await sleep(SL_DELAY_MS);
  const url = `${SL_BASE}/campaigns/${campaignId}/leads?api_key=${encodeURIComponent(apiKey)}&offset=${offset}&limit=${limit}`;
  const data = await fetchJsonWithRetry(url);
  // SmartLead returns { total_leads, data, offset, limit } — not always "leads"
  const leads = data.data || data.leads || data.items || [];
  const total = data.total_leads ?? data.total ?? data.count ?? leads.length;
  return { leads, total };
}

async function fetchSmartleadHistory(apiKey, campaignId, leadId) {
  await sleep(SL_DELAY_MS);
  const url = `${SL_BASE}/campaigns/${campaignId}/leads/${leadId}/message-history?api_key=${encodeURIComponent(apiKey)}&show_plain_text_response=true`;
  return fetchJsonWithRetry(url);
}

async function exportSmartLead(clientName, apiKey) {
  const out = [];
  if (!apiKey) return out;

  let campaigns;
  try {
    campaigns = await listSmartleadCampaigns(apiKey);
  } catch (e) {
    console.warn('[SmartLead] list campaigns failed', e.message);
    return out;
  }

  const rows = campaigns.slice(0, MAX_CAMPAIGNS);
  console.log(`[SmartLead] ${clientName}: scanning ${rows.length} campaigns`);

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
          const list = Array.isArray(hist.history)
            ? hist.history
            : Array.isArray(hist)
              ? hist
              : [];
          for (const m of list) {
            const t = String(m.type || m.direction || '').toUpperCase();
            if (t !== 'SENT' && t !== 'OUTBOUND') continue;
            const body = stripHtml(m.email_body || m.body || '');
            if (!body || body.length < 10) continue;
            out.push({
              platform: 'smartlead',
              client: clientName,
              campaign_id: cid,
              lead_id: String(lid),
              lead_email: lead.lead?.email ?? lead.email ?? null,
              sent_at: m.time || m.sent_at || null,
              subject: m.subject || null,
              body,
            });
          }
        } catch (e) {
          // skip bad lead
        }
      }
      offset += 100;
      const totalLeads = batch.total ?? 0;
      if (offset >= totalLeads || leads.length < 100) break;
    }
    await sleep(SL_DELAY_MS * 2);
  }

  console.log(`[SmartLead] ${clientName}: ${out.length} outbound messages`);
  return out;
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

async function exportHeyReach(clientName, apiKey) {
  const out = [];
  if (!apiKey) return out;

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
      for (const m of msgs) {
        const sender = String(m.sender || '');
        if (sender !== 'ME') continue;
        const body = String(m.body || '').trim();
        if (!body || body.length < 10) continue;
        out.push({
          platform: 'heyreach',
          client: clientName,
          conversation_id: conv.id || null,
          linkedin_account_id: conv.linkedInAccountId || null,
          sent_at: m.createdAt || null,
          body,
        });
      }
    }

    if (items.length < limit) break;
    offset += limit;
  }

  console.log(`[HeyReach] ${clientName}: ${out.length} outbound messages (from ${scanned} conversations scanned)`);
  return out;
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
    const sl = await exportSmartLead(t.name, t.smartlead_api_key);
    const hr = await exportHeyReach(t.name, t.heyreach_api_key);
    all.push(...sl, ...hr);
  }

  const jsonl = path.join(OUT_DIR, `outbound-replies-${stamp}.jsonl`);
  const json = path.join(OUT_DIR, `outbound-replies-${stamp}.json`);

  const fd = fs.createWriteStream(jsonl);
  for (const row of all) {
    fd.write(JSON.stringify(row) + '\n');
  }
  fd.end();

  fs.writeFileSync(json, JSON.stringify(all, null, 2));

  // Plain text corpus for copy-paste into Gemini / fine-tune
  const txt = path.join(OUT_DIR, `outbound-replies-${stamp}.txt`);
  fs.writeFileSync(
    txt,
    all.map((r) => `--- ${r.platform} | ${r.client} ---\n${r.body}\n`).join('\n')
  );

  console.log(`\nDone. Wrote:\n  ${jsonl}\n  ${json}\n  ${txt}\nTotal records: ${all.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
