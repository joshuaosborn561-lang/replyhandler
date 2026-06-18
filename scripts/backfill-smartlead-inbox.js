#!/usr/bin/env node
/**
 * Backfill SmartLead master-inbox replies via webhook (works even when poller lookback skips them).
 *
 * Usage:
 *   node scripts/backfill-smartlead-inbox.js Nieto
 *   node scripts/backfill-smartlead-inbox.js Nieto --unread-only --limit 10
 *   node scripts/backfill-smartlead-inbox.js Nieto --dry-run
 *
 * Env: BASE_URL (default production app URL)
 */

const {
  latestInboundFromSmartleadHistory,
  normalizeSmartleadCampaignId,
  normalizeSmartleadLeadId,
} = require('../src/utils/smartlead-webhook-helpers');

const SL_BASE = 'https://server.smartlead.ai/api/v1';
const BASE = (process.env.BASE_URL || 'https://app-production-9354.up.railway.app').replace(/\/$/, '');
const DELAY_MS = parseInt(process.env.BACKFILL_DELAY_MS || '2500', 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i === process.argv.length - 1) return null;
  return process.argv[i + 1];
}

async function fetchInboxPage(apiKey, offset, limit) {
  const url = `${SL_BASE}/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=true`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      limit,
      filters: { emailStatus: 'Replied' },
      sortBy: 'REPLY_TIME_DESC',
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`inbox-replies ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function buildWebhookPayload(row, inbound) {
  const statsId = (row.email_history || []).find((m) => String(m.type || '').toUpperCase() === 'SENT')?.stats_id;
  return {
    event_type: 'EMAIL_REPLY',
    email_campaign_id: row.email_campaign_id,
    email_lead_id: row.email_lead_id,
    sl_email_lead_id: row.email_lead_id,
    stats_id: statsId || null,
    lead_email: row.lead_email,
    lead_first_name: row.lead_first_name,
    lead_last_name: row.lead_last_name,
    reply_message: { body: inbound, text: inbound, message: inbound },
  };
}

async function main() {
  const clientNeedle = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);
  if (!clientNeedle) {
    console.error('Usage: node scripts/backfill-smartlead-inbox.js <ClientName> [--unread-only] [--limit N] [--dry-run]');
    process.exit(1);
  }

  const unreadOnly = process.argv.includes('--unread-only');
  const dryRun = process.argv.includes('--dry-run');
  const limit = parseInt(argValue('--limit') || '50', 10);
  const maxPages = parseInt(process.env.BACKFILL_MAX_PAGES || '5', 10);

  const clients = await fetch(`${BASE}/admin/clients`).then((r) => r.json());
  const client = clients.find((c) => c.active && String(c.name).toLowerCase().includes(clientNeedle.toLowerCase()));
  if (!client) throw new Error(`No active client matching "${clientNeedle}"`);
  if (!client.smartlead_api_key) throw new Error(`${client.name} has no SmartLead API key`);

  console.log(`[Backfill] ${client.name} (${client.id}) unreadOnly=${unreadOnly} limit=${limit} dryRun=${dryRun}`);

  const rows = [];
  for (let page = 0; page < maxPages && rows.length < limit; page++) {
    const payload = await fetchInboxPage(client.smartlead_api_key, page * 20, 20);
    const batch = payload.data || [];
    if (!batch.length) break;
    for (const row of batch) {
      if (unreadOnly && !row.has_new_unread_email) continue;
      rows.push(row);
      if (rows.length >= limit) break;
    }
    if (batch.length < 20) break;
  }

  console.log(`[Backfill] Inbox candidates: ${rows.length}`);

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const hist = { history: row.email_history || [] };
    const inbound = latestInboundFromSmartleadHistory(hist, row.lead_email);
    const campaignId = normalizeSmartleadCampaignId(row) || row.email_campaign_id;
    const leadId = normalizeSmartleadLeadId(row) || row.email_lead_id;
    const name = `${row.lead_first_name || ''} ${row.lead_last_name || ''}`.trim() || row.lead_email;

    if (!campaignId || !leadId || !inbound) {
      skipped++;
      console.log(`  skip ${name}: missing ids or inbound`);
      continue;
    }

    if (dryRun) {
      console.log(`  dry-run ${name}: ${inbound.slice(0, 80).replace(/\s+/g, ' ')}`);
      continue;
    }

    const whPayload = buildWebhookPayload(row, inbound);
    try {
      const res = await fetch(`${BASE}/webhook/smartlead/${client.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(whPayload),
      });
      const body = await res.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }

      if (parsed.skipped) {
        skipped++;
        console.log(`  skip ${name}: ${parsed.reason || 'skipped'}`);
      } else if (parsed.replyId || parsed.classification) {
        posted++;
        console.log(`  posted ${name}: ${parsed.classification || 'ok'} (${parsed.replyId || ''})`);
      } else if (parsed.error) {
        failed++;
        console.log(`  fail ${name}: ${parsed.error}`);
      } else {
        posted++;
        console.log(`  ok ${name}: ${body.slice(0, 120)}`);
      }
    } catch (err) {
      failed++;
      console.log(`  error ${name}: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`[Backfill] Done posted=${posted} skipped=${skipped} failed=${failed}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
