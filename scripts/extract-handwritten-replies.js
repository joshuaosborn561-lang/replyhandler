#!/usr/bin/env node
/**
 * Pull all inbound -> handwritten outbound reply pairs across all clients.
 *
 * "Handwritten" = sent outside our app, OR a heavily-edited draft.
 * Excludes:
 *   - The first message in a thread (cold open, not a reply)
 *   - AI drafts approved as-is (would create training feedback loop)
 *   - Auto-replies / very short / OOO inbounds
 *
 * Usage: DATABASE_URL=... node scripts/extract-handwritten-replies.js
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { resolveDatabaseUrl, pgSslOption } = require('./railway-database-url');

const SL_BASE = 'https://server.smartlead.ai/api/v1';
const HR_BASE = 'https://api.heyreach.io/api/public';
const OUT_DIR = path.join(process.cwd(), 'training-exports');
const SL_DELAY_MS = 1100;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&rsquo;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop the "> On X wrote" quoted history so we only see the new text the human typed. */
function stripQuotedHistory(s) {
  if (!s) return '';
  let t = String(s);
  // Common "On <date>, <name> wrote:" markers
  t = t.split(/On .{0,80}wrote:/i)[0];
  // Outlook "From: ... Sent: ..." block
  t = t.split(/(^|\n)\s*From:\s/i)[0];
  // ----- Original Message -----
  t = t.split(/-{2,}\s*Original Message\s*-{2,}/i)[0];
  // Lines that start with ">"
  t = t.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
  return t.trim();
}

function cleanBody(raw) {
  return stripQuotedHistory(stripHtml(raw));
}

function fingerprint(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 25)
    .join(' ');
}

async function fetchJsonRetry(url, opts = {}, retries = 4) {
  for (let i = 0; i <= retries; i += 1) {
    const res = await fetch(url, opts);
    const text = await res.text();
    if (res.status === 429 && i < retries) {
      await sleep(2000 * (i + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  }
  throw new Error('retries exhausted');
}

const AI_PHRASES = [
  'we have a few options',
  'want to make sure something works for you',
  'our ceo can walk through',
  'thanks for getting back to me',
  'happy to find something that works on your end',
  'appreciate you sharing that',
];

function looksLikeAi(text) {
  const s = String(text || '').toLowerCase();
  return AI_PHRASES.filter((p) => s.includes(p)).length >= 2;
}

function isBadInbound(text) {
  const s = String(text || '').trim();
  if (s.length < 12) return true;
  const low = s.toLowerCase();
  if (/\bout of (the )?office\b/.test(low)) return true;
  if (/\bauto(matic)? reply\b/.test(low)) return true;
  if (/\bunsubscribe\b/.test(low) && s.length < 100) return true;
  if (/\bno longer (employed|with)\b/.test(low) && s.length < 200) return true;
  if (/\bis not monitored\b/.test(low)) return true;
  return false;
}

async function listSmartleadCampaigns(apiKey) {
  await sleep(SL_DELAY_MS);
  const data = await fetchJsonRetry(`${SL_BASE}/campaigns?api_key=${encodeURIComponent(apiKey)}`);
  return Array.isArray(data) ? data : (data.data || []);
}

async function inboxRepliesPage(apiKey, offset, limit, campaignIds) {
  await sleep(SL_DELAY_MS);
  const url = `${SL_BASE}/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=true`;
  const body = {
    offset,
    limit,
    filters: {
      emailStatus: 'Replied',
      ...(campaignIds && campaignIds.length ? { campaignId: campaignIds } : {}),
    },
    sortBy: 'REPLY_TIME_DESC',
  };
  return fetchJsonRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function pairsFromSmartleadHistory(history, leadName) {
  const list = Array.isArray(history) ? history : [];
  const sorted = list
    .map((m) => ({
      type: String(m.type || '').toUpperCase(),
      time: m.time || m.sent_at || m.received_at || '',
      body: cleanBody(m.email_body || m.body || m.text || ''),
    }))
    .filter((m) => m.body)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const pairs = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const out = sorted[i];
    if (out.type !== 'SENT' && out.type !== 'OUTBOUND') continue;
    const inn = sorted[i - 1];
    if (inn.type !== 'REPLY' && inn.type !== 'INBOUND') continue;
    pairs.push({ inbound: inn.body, outbound: out.body, leadName });
  }
  return pairs;
}

async function exportSmartlead(client, aiFingerprints) {
  const out = [];
  if (!client.smartlead_api_key) return out;

  let offset = 0;
  const pageSize = 20;
  let totalScanned = 0;
  while (offset < 2000) {
    let page;
    try { page = await inboxRepliesPage(client.smartlead_api_key, offset, pageSize); }
    catch (e) { console.warn(`[${client.name}] inbox page failed: ${e.message}`); break; }
    const rows = page.data || [];
    if (!rows.length) break;
    for (const row of rows) {
      totalScanned += 1;
      const leadName = `${row.lead_first_name || ''} ${row.lead_last_name || ''}`.trim();
      const hist = row.email_history || row.emailHistory || [];
      const pairs = pairsFromSmartleadHistory(hist, leadName);
      for (const p of pairs) {
        if (looksLikeAi(p.outbound)) continue;
        if (aiFingerprints.has(fingerprint(p.outbound))) continue;
        if (isBadInbound(p.inbound)) continue;
        out.push({
          source: 'smartlead',
          client: client.name,
          lead: leadName,
          inbound: p.inbound,
          outbound: p.outbound,
        });
      }
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  console.log(`  [SmartLead] scanned ${totalScanned} reply threads, kept ${out.length} pairs`);
  return out;
}

async function exportHeyreach(client, aiFingerprints) {
  const out = [];
  if (!client.heyreach_api_key) return out;
  let offset = 0;
  const limit = 50;
  while (offset < 500) {
    let data;
    try {
      const res = await fetch(`${HR_BASE}/inbox/GetConversationsV2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': client.heyreach_api_key },
        body: JSON.stringify({ offset, limit }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
      data = JSON.parse(text);
    } catch (e) { console.warn(`[${client.name}] HeyReach failed: ${e.message}`); break; }
    const items = data.items || data.data || [];
    if (!items.length) break;
    for (const conv of items) {
      const msgs = (conv.messages || [])
        .map((m) => ({
          sender: String(m.sender || ''),
          time: m.createdAt || '',
          body: cleanBody(m.body || ''),
        }))
        .filter((m) => m.body)
        .sort((a, b) => String(a.time).localeCompare(String(b.time)));
      for (let i = 1; i < msgs.length; i += 1) {
        const out2 = msgs[i];
        if (out2.sender !== 'ME') continue;
        const inn = msgs[i - 1];
        if (inn.sender === 'ME') continue;
        if (looksLikeAi(out2.body)) continue;
        if (aiFingerprints.has(fingerprint(out2.body))) continue;
        if (isBadInbound(inn.body)) continue;
        out.push({
          source: 'heyreach',
          client: client.name,
          lead: conv.leadName || conv.profile?.firstName || '',
          inbound: inn.body,
          outbound: out2.body,
        });
      }
    }
    if (items.length < limit) break;
    offset += limit;
  }
  return out;
}

async function loadAiFingerprints(db) {
  const fps = new Set();
  const { rows } = await db.query(
    `SELECT draft_reply, sent_reply FROM pending_replies WHERE draft_reply IS NOT NULL OR sent_reply IS NOT NULL`,
  );
  for (const r of rows) {
    if (r.draft_reply) fps.add(fingerprint(stripQuotedHistory(r.draft_reply)));
    if (r.sent_reply) fps.add(fingerprint(stripQuotedHistory(r.sent_reply)));
  }
  return fps;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const conn = resolveDatabaseUrl();
  const db = new Client({ connectionString: conn, ssl: pgSslOption(conn) });
  await db.connect();

  const aiFingerprints = await loadAiFingerprints(db);
  console.log(`AI fingerprints in DB: ${aiFingerprints.size}`);

  const { rows: clients } = await db.query(
    `SELECT id, name, smartlead_api_key, heyreach_api_key FROM clients WHERE active=true ORDER BY name`,
  );

  const all = [];
  for (const client of clients) {
    console.log(`\n=== ${client.name} ===`);
    const sl = await exportSmartlead(client, aiFingerprints);
    const hr = await exportHeyreach(client, aiFingerprints);
    console.log(`[${client.name}] handwritten pairs: SL=${sl.length} HR=${hr.length}`);
    all.push(...sl, ...hr);
  }

  await db.end();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const jsonl = path.join(OUT_DIR, `handwritten-${stamp}.jsonl`);
  fs.writeFileSync(jsonl, all.map((r) => JSON.stringify(r)).join('\n'));

  const summary = {};
  for (const r of all) {
    summary[r.client] = (summary[r.client] || 0) + 1;
  }
  console.log('\nDONE');
  console.log('Total handwritten pairs:', all.length);
  console.log('By client:', summary);
  console.log('File:', jsonl);
}

main().catch((e) => { console.error(e); process.exit(1); });
