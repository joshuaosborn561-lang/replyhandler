#!/usr/bin/env node
/**
 * Compare SmartLead master-inbox recent replies vs pending_replies in DB.
 * Usage: node scripts/diagnose-missed-smartlead.js [clientNameSubstring]
 */
const { Pool } = require('pg');
const { resolveDatabaseUrl, pgSslOption } = require('./railway-database-url');

const SL_BASE = 'https://server.smartlead.ai/api/v1';
const BASE = (process.env.BASE_URL || 'https://app-production-9354.up.railway.app').replace(/\/$/, '');
const needle = (process.argv[2] || 'salesglider').toLowerCase();

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function inboxReplies(apiKey) {
  const url = `${SL_BASE}/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=true`;
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset: 0,
      limit: 10,
      filters: { emailStatus: 'Replied' },
      sortBy: 'REPLY_TIME_DESC',
    }),
  });
}

function pickReplies(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const arr = payload.data || payload.messages || payload.replies || payload.items || [];
  return Array.isArray(arr) ? arr : [];
}

function leadKey(row) {
  const cid = row.campaign_id || row.campaignId || row.campaign?.id;
  const lid = row.lead_id || row.leadId || row.sl_email_lead_id || row.email_lead_id || row.id;
  const email = (row.lead_email || row.email || row.to_email || '').toLowerCase();
  return `${cid}|${lid}|${email}`;
}

function latestReplyText(row) {
  const hist = row.message_history || row.messageHistory || row.history;
  if (Array.isArray(hist) && hist.length) {
    const replies = hist.filter((m) => String(m.type || m.direction || '').toUpperCase() === 'REPLY');
    if (replies.length) {
      const last = replies[replies.length - 1];
      return String(last.email_body || last.body || last.text || '').slice(0, 120);
    }
  }
  return String(
    row.last_reply || row.latest_reply || row.reply_message?.text || row.reply_body || row.preview || ''
  ).slice(0, 120);
}

async function main() {
  const clientsRes = await fetch(`${BASE}/admin/clients`);
  const clients = await clientsRes.json();
  const client = clients.find((c) => c.active && String(c.name).toLowerCase().includes(needle));
  if (!client) {
    console.error('No active client matching', needle);
    process.exit(1);
  }
  console.log('Client:', client.name, client.id);

  const dbUrl = resolveDatabaseUrl();
  let dbRows = [];
  if (dbUrl) {
    const pool = new Pool({ connectionString: dbUrl, ssl: pgSslOption(dbUrl) });
    const { rows } = await pool.query(
      `SELECT lead_name, lead_email, campaign_id, lead_id, classification, status, inbound_message, created_at
         FROM pending_replies
        WHERE client_id = $1 AND platform = 'smartlead'
          AND created_at > now() - interval '7 days'
        ORDER BY created_at DESC
        LIMIT 100`,
      [client.id]
    );
    dbRows = rows;
    await pool.end();
  } else {
    console.warn('No DATABASE_URL — skipping DB compare');
  }

  console.log(`DB pending_replies (7d): ${dbRows.length}`);
  for (const r of dbRows.slice(0, 15)) {
    console.log(`  - ${r.created_at.toISOString?.() || r.created_at} ${r.lead_name} ${r.classification} ${r.status}`);
  }

  if (!client.smartlead_api_key) {
    console.error('No SmartLead API key on client');
    process.exit(1);
  }

  const inbox = await inboxReplies(client.smartlead_api_key, 20);
  const replies = pickReplies(inbox);
  console.log(`\nSmartLead inbox recent replies: ${replies.length}`);

  const dbKeys = new Set(
    dbRows.map((r) => `${r.campaign_id}|${r.lead_id}|${String(r.lead_email || '').toLowerCase()}`)
  );

  for (const row of replies.slice(0, 20)) {
    const name = row.lead_name || row.first_name || row.name || row.to_name || '?';
    const email = row.lead_email || row.email || row.to_email || '';
    const key = leadKey(row);
    const inDb = dbKeys.has(key);
    const preview = latestReplyText(row);
    const cat = row.lead_category || row.category || row.lead_category_name || '';
    console.log(`\n${inDb ? '✓ IN DB' : '✗ MISSING'} | ${name} <${email}>`);
    console.log(`  campaign=${row.campaign_id || row.campaignId} lead=${row.lead_id || row.leadId || row.sl_email_lead_id}`);
    if (cat) console.log(`  category=${cat}`);
    if (preview) console.log(`  reply: ${preview.replace(/\s+/g, ' ')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
