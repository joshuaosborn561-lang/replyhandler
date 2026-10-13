#!/usr/bin/env node
/**
 * Dry-run (default): print the EMAIL_REPLY webhooks to add on campaigns
 * that have an inbound_forward_rules campaign_id, without touching live
 * SmartLead. Never deletes the Allo "Caller reply to Allo" hook.
 *
 * Do not run with --apply unless Josh has reviewed the plan. This script
 * does not run itself on deploy.
 *
 *   node scripts/register-inbound-forward-webhooks.js
 *   node scripts/register-inbound-forward-webhooks.js --apply
 */
const { Client } = require('pg');
const { resolveDatabaseUrl, pgSslOption } = require('./railway-database-url');

const SL_BASE = 'https://server.smartlead.ai/api/v1';
const WEBHOOK_NAME = 'Inbound forward';
const ALLO_HOOK_NAME = 'Caller reply to Allo';
const DEFAULT_ORIGIN = 'https://app-production-9354.up.railway.app';

function applyRequested() {
  return process.argv.includes('--apply');
}

function webhookUrl() {
  const domain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  const origin = domain
    ? `https://${domain.replace(/^https?:\/\//, '')}`
    : DEFAULT_ORIGIN;
  const secret = String(process.env.INBOUND_FORWARD_WEBHOOK_SECRET || '').trim();
  const base = `${origin.replace(/\/$/, '')}/webhook/inbound-forward`;
  return secret ? `${base}?secret=${encodeURIComponent(secret)}` : base;
}

function apiKey() {
  return String(process.env.SMARTLEAD_MASTER_API_KEY || process.env.SMARTLEAD_API_KEY || '').trim();
}

async function slFetch(method, path, body) {
  const key = apiKey();
  if (!key) throw new Error('SMARTLEAD_MASTER_API_KEY or SMARTLEAD_API_KEY is required');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${SL_BASE}${path}${sep}api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    throw new Error(`SmartLead ${method} ${path} failed (${res.status}): ${String(text).slice(0, 400)}`);
  }
  return json;
}

function alreadyHasInboundForward(hooks, url) {
  return (hooks || []).some((h) => {
    const events = (h.event_types || h.eventTypes || []).map((e) => String(e).toUpperCase());
    const hookUrl = String(h.webhook_url || h.webhookUrl || '');
    return events.includes('EMAIL_REPLY') && hookUrl.split('?')[0] === url.split('?')[0];
  });
}

function alloHookPresent(hooks) {
  return (hooks || []).some((h) => {
    const name = String(h.name || '');
    const events = (h.event_types || h.eventTypes || []).map((e) => String(e).toUpperCase());
    return name === ALLO_HOOK_NAME || events.includes('LEAD_CATEGORY_UPDATED');
  });
}

async function loadCampaignIds(pg) {
  if (!pg) {
    return ['4085158', '4085159', '4085160'];
  }
  const { rows } = await pg.query(
    `SELECT DISTINCT campaign_id
       FROM inbound_forward_rules
      WHERE active IS DISTINCT FROM false
        AND campaign_id IS NOT NULL
        AND btrim(campaign_id) <> ''
      ORDER BY campaign_id`
  );
  return rows.map((r) => String(r.campaign_id));
}

async function main() {
  const apply = applyRequested();
  const url = webhookUrl();
  console.log(apply ? '[InboundForward] APPLY mode' : '[InboundForward] DRY RUN — no SmartLead writes');
  console.log('[InboundForward] Target URL:', url);
  console.log('[InboundForward] Keep existing hook:', ALLO_HOOK_NAME);

  let pg = null;
  const conn = resolveDatabaseUrl();
  if (conn) {
    pg = new Client({ connectionString: conn, ssl: pgSslOption(conn) });
    await pg.connect();
  } else {
    console.log('[InboundForward] No DATABASE_URL — using seeded Gabe Calls ids only');
  }

  try {
    const campaignIds = await loadCampaignIds(pg);
    if (!campaignIds.length) {
      console.log('[InboundForward] No campaign_id rules found');
      return;
    }

    for (const campaignId of campaignIds) {
      let hooks = [];
      try {
        hooks = await slFetch('GET', `/campaigns/${encodeURIComponent(campaignId)}/webhooks`) || [];
      } catch (err) {
        console.error(`[InboundForward] ${campaignId}: could not list webhooks — ${err.message}`);
        continue;
      }
      if (!Array.isArray(hooks)) hooks = hooks?.data || hooks?.webhooks || [];

      const alloOk = alloHookPresent(hooks);
      const already = alreadyHasInboundForward(hooks, url);
      console.log(`[InboundForward] Campaign ${campaignId}`);
      console.log(`  existing hooks: ${(hooks || []).map((h) => h.name || '(unnamed)').join(', ') || '(none)'}`);
      console.log(`  Allo hook present: ${alloOk ? 'yes' : 'NO — do not apply until it is restored'}`);
      console.log(`  EMAIL_REPLY inbound-forward already on: ${already ? 'yes' : 'no'}`);

      if (already) {
        console.log('  action: skip (already registered)');
        continue;
      }
      if (!alloOk) {
        console.log('  action: skip (refusing to touch a campaign that lost the Allo hook)');
        continue;
      }

      const createBody = {
        name: WEBHOOK_NAME,
        webhook_url: url,
        email_campaign_id: Number(campaignId),
        event_types: ['EMAIL_REPLY'],
      };
      console.log('  planned create (POST /webhook/create):');
      console.log(`    ${JSON.stringify(createBody)}`);

      if (!apply) {
        console.log('  action: dry-run only');
        continue;
      }

      await slFetch('POST', '/webhook/create', createBody);
      console.log('  action: created EMAIL_REPLY inbound-forward (Allo hook left in place)');
    }

    if (!apply) {
      console.log('\nTo register after review:');
      console.log('  railway run node scripts/register-inbound-forward-webhooks.js --apply');
      console.log('Or in SmartLead UI on each Gabe Calls campaign, add a webhook:');
      console.log(`  Name: ${WEBHOOK_NAME}`);
      console.log(`  URL:  ${url}`);
      console.log('  Event: EMAIL_REPLY');
      console.log(`  Leave "${ALLO_HOOK_NAME}" (LEAD_CATEGORY_UPDATED) untouched.`);
    }
  } finally {
    if (pg) await pg.end();
  }
}

main().catch((err) => {
  console.error('[InboundForward] Failed:', err.message);
  process.exit(1);
});
