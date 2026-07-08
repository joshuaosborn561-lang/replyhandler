#!/usr/bin/env node
/**
 * One-off: mark MSRS positive replies (today ET) as "Positive Reply" in SmartLead.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/backfill-msrs-smartlead-categories.js [--dry-run]
 */
const { Client } = require('pg');
const { resolveDatabaseUrl, pgSslOption } = require('./railway-database-url');
const {
  looksLikeOutOfOffice,
  looksLikeNotInterested,
  stripHtmlToText,
} = require('../src/utils/smartlead-webhook-helpers');

const SL_BASE = 'https://server.smartlead.ai/api/v1';
const MSRS_CLIENT_ID = 'fe8380d4-57ad-4dc9-adcb-4a939cbab32d';
const POSITIVE_REPLY_CATEGORY_ID = 131482; // MSRS custom "Positive Reply"

function norm(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&rsquo;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looksLikeUnsubscribe(text) {
  const s = norm(text);
  return /\bunsubscribe\b/.test(s) || /\bremove me from\b/.test(s);
}

function looksLikeAutoRedirect(text) {
  const s = norm(text);
  if (/\bno longer (employed|with|working)\b/.test(s)) return true;
  if (/\bis no longer with\b/.test(s)) return true;
  if (/\bis no longer employed\b/.test(s)) return true;
  if (/\bthis email (is not monitored|box is no longer|address is no longer)\b/.test(s)) return true;
  if (/\bplease direct (all|any|your)\b/.test(s) && /\b(correspondence|email|inquiries)\b/.test(s)) return true;
  if (/\bretiring\b/.test(s) || /\bi have retired\b/.test(s)) return true;
  if (/\bverify that you are a real live human\b/.test(s)) return true;
  if (/\bwrong person\b/.test(s) || /\bsent this to the wrong person\b/.test(s)) return true;
  if (/\bnot a good contact\b/.test(s) || /\bbetter off sharing with someone else\b/.test(s)) return true;
  if (/\bbetter spent with those who do\b/.test(s)) return true;
  if (/\bwould not be in need of your services\b/.test(s)) return true;
  if (/\bcan't accept tickets\b/.test(s) || /\bcannot accept gifts\b/.test(s)) return true;
  if (/\bagainst board policy\b/.test(s)) return true;
  if (/\btickets would be better used elsewhere\b/.test(s)) return true;
  if (/\bpass the tickets along to someone else\b/.test(s)) return true;
  if (/\b(i will )?decline\b/.test(s) && !/\bhowever\b/.test(s) && !/\bneed (some|roof|work|vendor)\b/.test(s)) return true;
  if (/\bno need for any roofing\b/.test(s)) return true;
  if (/\bhomeowners are responsible\b/.test(s)) return true;
  if (/\bdon't have any commercial properties under my remit\b/.test(s)) return true;
  if (/\bmanage single family home rentals\b/.test(s) && /\bwould not be in need\b/.test(s)) return true;
  if (/\bcontract security company\b/.test(s)) return true;
  if (/\bwe don't own any commercial buildings or have a need\b/.test(s)) return true;
  if (/\bwe just had our roof replaced\b/.test(s) && /\b(not interested|would not be interested)\b/.test(s)) return true;
  return false;
}

function looksLikePositive(text) {
  const s = norm(text);
  if (!s) return false;

  if (/\b(set up a call|schedule a (quick )?call|happy to schedule|open to a call|available (for|between|tuesday|monday|until|for the rest))\b/.test(s)) return true;
  if (/\b(give me a call|call anytime|what is (the )?number|what is your number|give you a buzz|you can give me a call)\b/.test(s)) return true;
  if (/\b(would love|love to get|love the tickets|yes,? i would love the tickets|yes,? i'll take|i'll take them|i would gladly accept|yes, i'll take them)\b/.test(s)) return true;
  if (/\b(need (some )?roof|roof work|roof repairs|looking for a vendor|new vendors|how much to seal|onboard new vendors)\b/.test(s)) return true;
  if (/\b(let me know when we can connect|when can we connect|discuss with you what you have to offer)\b/.test(s)) return true;
  if (/\bwhat is the date of the tickets\b/.test(s)) return true;
  if (/\b(will definitely call when a project|always in need of new vendors)\b/.test(s)) return true;
  if (/\blooking for a vendor that can help\b/.test(s)) return true;
  if (/\bhowever,? we have (veterans|this property)\b/.test(s)) return true;
  if (/\b(don't own|do not own|we lease|lease our building|we're just the largest tenant|largest tenant)\b/.test(s)) return true;
  if (/\b(tickets|tix)\b/.test(s) && /\b(vendor|contact info|call)\b/.test(s)) return true;
  if (/\bwhat is the number to your office\b/.test(s)) return true;
  if (/\bthank you for reaching out\b/.test(s) && /\b(happy to schedule|learn more about your services)\b/.test(s)) return true;

  return false;
}

function isPositiveReply(inboundMessage) {
  const text = stripHtmlToText(inboundMessage) || inboundMessage || '';
  if (looksLikeUnsubscribe(text)) return false;
  if (looksLikeOutOfOffice(text)) return false;
  if (looksLikeNotInterested(text)) return false;
  if (looksLikeAutoRedirect(text)) return false;
  return looksLikePositive(text);
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadCampaignLeadMap(apiKey, campaignId) {
  const byEmail = new Map();
  const byLeadId = new Map();
  let offset = 0;
  const pageSize = 100;

  while (true) {
    const url = `${SL_BASE}/campaigns/${encodeURIComponent(campaignId)}/leads?api_key=${encodeURIComponent(apiKey)}&limit=${pageSize}&offset=${offset}`;
    const payload = await fetchJson(url);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!rows.length) break;

    for (const row of rows) {
      const mapId = row.campaign_lead_map_id;
      const leadId = row.lead?.id;
      const email = String(row.lead?.email || '').trim().toLowerCase();
      const categoryId = row.lead_category_id ?? null;
      if (!mapId) continue;
      const entry = { mapId: String(mapId), categoryId, leadId: leadId != null ? String(leadId) : null, email };
      if (email) byEmail.set(email, entry);
      if (leadId != null) byLeadId.set(String(leadId), entry);
    }

    if (rows.length < pageSize) break;
    offset += pageSize;
    await sleep(1100);
  }

  return { byEmail, byLeadId };
}

async function updateCategory(apiKey, emailLeadMapId, categoryId) {
  const url = `${SL_BASE}/master-inbox/update-category?api_key=${encodeURIComponent(apiKey)}`;
  return fetchJson(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email_lead_map_id: Number(emailLeadMapId),
      category_id: categoryId,
    }),
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const conn = resolveDatabaseUrl();
  if (!conn) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }

  const db = new Client({ connectionString: conn, ssl: pgSslOption(conn) });
  await db.connect();

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [MSRS_CLIENT_ID]);
  if (!client?.smartlead_api_key) {
    console.error('MSRS client or SmartLead API key not found');
    process.exit(1);
  }

  const { rows } = await db.query(
    `SELECT id, lead_name, lead_email, campaign_id, lead_id, inbound_message
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'smartlead'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
      ORDER BY created_at ASC`,
    [MSRS_CLIENT_ID],
  );

  const positives = rows.filter((r) => isPositiveReply(r.inbound_message));
  console.log(`MSRS positives today: ${positives.length} (of ${rows.length} total replies)`);

  const campaignIds = [...new Set(positives.map((r) => String(r.campaign_id)).filter(Boolean))];
  const maps = new Map();
  for (const cid of campaignIds) {
    console.log(`Loading campaign lead map for campaign ${cid}...`);
    const { byEmail, byLeadId } = await loadCampaignLeadMap(client.smartlead_api_key, cid);
    maps.set(cid, { byEmail, byLeadId });
  }

  const results = { updated: 0, skipped_already: 0, missing_map: 0, failed: 0 };

  for (const row of positives) {
    const cid = String(row.campaign_id);
    const map = maps.get(cid);
    const email = String(row.lead_email || '').trim().toLowerCase();
    const leadId = row.lead_id != null ? String(row.lead_id) : null;
    const hit = (email && map?.byEmail.get(email)) || (leadId && map?.byLeadId.get(leadId));

    if (!hit) {
      console.warn(`✗ MISSING MAP | ${row.lead_name} <${row.lead_email}>`);
      results.missing_map += 1;
      continue;
    }

    if (Number(hit.categoryId) === POSITIVE_REPLY_CATEGORY_ID) {
      console.log(`○ SKIP (already Positive Reply) | ${row.lead_name}`);
      results.skipped_already += 1;
      continue;
    }

    if (dryRun) {
      console.log(`DRY RUN | ${row.lead_name} → category ${POSITIVE_REPLY_CATEGORY_ID} (map ${hit.mapId}, was ${hit.categoryId ?? 'none'})`);
      results.updated += 1;
      continue;
    }

    try {
      await updateCategory(client.smartlead_api_key, hit.mapId, POSITIVE_REPLY_CATEGORY_ID);
      console.log(`✓ UPDATED | ${row.lead_name} (map ${hit.mapId}, was ${hit.categoryId ?? 'none'})`);
      results.updated += 1;
      await sleep(1200);
    } catch (err) {
      console.error(`✗ FAILED | ${row.lead_name}: ${err.message}`);
      results.failed += 1;
    }
  }

  await db.end();
  console.log('\nDone:', results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
