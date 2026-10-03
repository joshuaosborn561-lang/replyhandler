#!/usr/bin/env node
/**
 * One-time: push enrichment we already bought onto portal prospects that predate
 * the portal carrying it. Reads pending_replies, sends to the portal's
 * backfill-reply-enrichment function, which only ever fills a column that is
 * currently null and can never insert a row.
 *
 *   node scripts/backfill-portal-enrichment.js --dry-run
 *   node scripts/backfill-portal-enrichment.js
 *
 * Needs PORTAL_URL and PORTAL_WEBHOOK_SECRET, the same pair the live notify uses.
 */
const db = require('../src/db');

const BATCH = 200;
const PATH = '/functions/v1/backfill-reply-enrichment';
const POSITIVE = ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION'];

function channelFromPlatform(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'heyreach' || p === 'linkedin') return 'linkedin';
  if (p === 'call' || p === 'allo') return 'call';
  return 'email';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const base = String(process.env.PORTAL_URL || '').trim().replace(/\/+$/, '');
  const secret = String(process.env.PORTAL_WEBHOOK_SECRET || '').trim();
  if (!base || !secret) {
    console.error('PORTAL_URL and PORTAL_WEBHOOK_SECRET must both be set.');
    process.exit(1);
  }

  const { rows } = await db.query(
    `SELECT client_id, platform, lead_email, lead_phone, lead_phone_provider,
            linkedin_url, lead_website
       FROM pending_replies
      WHERE lead_email IS NOT NULL
        AND classification = ANY($1::text[])
        AND (lead_phone IS NOT NULL OR linkedin_url IS NOT NULL OR lead_website IS NOT NULL)
      ORDER BY created_at DESC`,
    [POSITIVE]
  );

  // One row per client, channel and email. Newest wins, which is why the query
  // sorts by created_at descending and the first write to a key is kept.
  const byKey = new Map();
  for (const r of rows) {
    const email = String(r.lead_email || '').trim().toLowerCase();
    if (!email) continue;
    const channel = channelFromPlatform(r.platform);
    const key = `${r.client_id}|${channel}|${email}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      handler_client_id: r.client_id,
      channel,
      email,
      phone: r.lead_phone || null,
      phone_provider: r.lead_phone_provider || null,
      linkedin_url: r.linkedin_url || null,
      website: r.lead_website || null,
    });
  }

  const items = [...byKey.values()];
  console.log(`[Backfill] ${rows.length} enriched positive replies, ${items.length} unique prospects.`);
  if (dryRun) {
    console.log('[Backfill] Dry run, nothing sent. Sample:', items.slice(0, 3));
    return;
  }

  let updated = 0;
  let skipped = 0;
  const unknown = new Set();
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-portal-secret': secret },
      body: JSON.stringify({ items: batch }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[Backfill] Batch ${i / BATCH + 1} failed (${res.status})`, body);
      process.exitCode = 1;
      continue;
    }
    updated += body.updated || 0;
    skipped += body.skipped || 0;
    for (const id of body.unknown_handler_client_ids || []) unknown.add(id);
    console.log(`[Backfill] Batch ${i / BATCH + 1}: updated ${body.updated}, skipped ${body.skipped}.`);
  }

  console.log(`[Backfill] Done. Updated ${updated}, skipped ${skipped}.`);
  if (unknown.size) {
    console.log('[Backfill] Not in the portal (expected for clients with no portal row):', [...unknown].join(', '));
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('[Backfill] Failed', err);
    process.exit(1);
  });
