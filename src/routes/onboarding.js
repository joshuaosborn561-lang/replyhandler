/**
 * Onboarding bot: create or update one replyhandler client and (optionally)
 * hook its SmartLead campaigns' EMAIL_REPLY webhooks to it (smartlead_campaign_id
 * and/or campaign_ids[]). Optional smartlead_client_id enables auto-routing of
 * new campaigns under that SmartLead client (see services/campaign-auto-route).
 *
 *   POST /admin/onboarding/client   (header ADMIN_API_KEY, required — fail closed)
 *
 * Pure addition: no portal provision, no ICP build, no campaign status change.
 * Response never returns keys or tokens (presence booleans only).
 */
const { Router } = require('express');
const db = require('../db');
const smartlead = require('../services/smartlead');
const { requireAdminApiKey } = require('../utils/admin-auth');
const { webhookUrls } = require('../utils/public-client');
const { normalizeClientBooking } = require('../utils/booking-bridge-destinations');
const { resetCampaignRouteCache } = require('../services/campaign-routing');
const { autoRouteClientCampaigns } = require('../services/campaign-auto-route');

const SLACK_CHANNEL_RE = /^[CG][A-Z0-9]{6,}$/;

function validate(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body must be JSON'];
  if (!body.client_id && !String(body.name || '').trim()) errors.push('name (or client_id) is required');
  if (body.slack_channel_id != null && !SLACK_CHANNEL_RE.test(String(body.slack_channel_id))) {
    errors.push('slack_channel_id must be a Slack channel id like C0123ABCD');
  }
  if (body.booking_link != null && body.booking_link !== '' && !/^https:\/\//i.test(String(body.booking_link))) {
    errors.push('booking_link must be an https URL');
  }
  if (body.smartlead_campaign_id != null && !/^\d+$/.test(String(body.smartlead_campaign_id))) {
    errors.push('smartlead_campaign_id must be numeric');
  }
  if (body.campaign_ids != null) {
    if (!Array.isArray(body.campaign_ids) || body.campaign_ids.some((c) => !/^\d+$/.test(String(c)))) {
      errors.push('campaign_ids must be an array of numeric campaign ids');
    } else if (body.campaign_ids.length > 100) {
      errors.push('campaign_ids accepts at most 100 ids per call');
    }
  }
  if (body.smartlead_client_id != null && body.smartlead_client_id !== '' && !/^\d+$/.test(String(body.smartlead_client_id))) {
    errors.push('smartlead_client_id must be numeric');
  }
  return errors;
}

function safeView(client) {
  return {
    id: client.id,
    name: client.name,
    active: client.active,
    slack_channel_id: client.slack_channel_id,
    booking_link: client.booking_link,
    booking_destination_url: client.booking_destination_url,
    has_slack_bot_token: !!client.slack_bot_token,
    has_smartlead_api_key: !!client.smartlead_api_key,
    smartlead_use_master_key: client.smartlead_use_master_key === true,
    smartlead_client_id: client.smartlead_client_id || null,
    ...webhookUrls(client.id),
  };
}

/** Default bot token: the one the SalesGlider client uses (AI Reply Handler bot). */
async function defaultSlackToken(q) {
  const { rows } = await q(
    `SELECT slack_bot_token FROM clients
      WHERE active IS DISTINCT FROM false AND slack_bot_token IS NOT NULL AND slack_bot_token <> ''
      ORDER BY (lower(name) = 'salesglider') DESC, created_at ASC LIMIT 1`
  );
  return rows[0]?.slack_bot_token || null;
}

/** Union of smartlead_campaign_id and campaign_ids, deduped, as strings. */
function campaignIdsFrom(body) {
  const ids = [];
  if (body.smartlead_campaign_id != null && body.smartlead_campaign_id !== '') ids.push(String(body.smartlead_campaign_id));
  for (const c of body.campaign_ids || []) ids.push(String(c));
  return [...new Set(ids)];
}

/** Ensure one campaign's EMAIL_REPLY hook points at this client. Never throws. */
async function ensureHook(sl, hookKey, campaignId, target) {
  if (!hookKey) return { registered: false, reason: 'no smartlead_api_key on client' };
  try {
    const hooks = await sl.listCampaignWebhooks(hookKey, campaignId);
    if ((hooks || []).some((h) => sl.webhookHasEmailReply(h, target))) return { registered: true, created: false, url: target };
    await sl.createEmailReplyWebhook(hookKey, campaignId, target);
    return { registered: true, created: true, url: target };
  } catch (err) {
    return { registered: false, error: err.message.replace(/api_key=[^&\s]+/g, 'api_key=***') };
  }
}

async function upsertOnboardingClient(body, deps = {}) {
  const q = deps.query || ((sql, p) => db.query(sql, p));
  const sl = deps.smartlead || smartlead;
  const dryRun = body.dry_run === true || /^(1|true|yes)$/i.test(String(body.dry_run || ''));

  let existing = null;
  if (body.client_id) {
    ({ rows: [existing] } = await q('SELECT * FROM clients WHERE id = $1', [body.client_id]));
    if (!existing) return { status: 404, json: { error: 'client not found' } };
  } else {
    ({ rows: [existing] } = await q(
      `SELECT * FROM clients WHERE lower(name) = lower($1) AND active IS DISTINCT FROM false
        ORDER BY created_at ASC LIMIT 1`,
      [String(body.name).trim()]
    ));
  }

  const name = String(body.name || existing?.name || '').trim();
  const channel = body.slack_channel_id || existing?.slack_channel_id || null;
  if (!channel) return { status: 400, json: { error: 'slack_channel_id is required for a new client' } };
  const token = body.slack_bot_token || existing?.slack_bot_token || await defaultSlackToken(q);
  if (!token) return { status: 500, json: { error: 'no default Slack bot token found' } };
  const booked = normalizeClientBooking({
    name,
    booking_link: body.booking_link != null ? body.booking_link : existing?.booking_link,
    booking_destination_url: existing?.booking_destination_url,
  });
  const slKey = body.smartlead_api_key || existing?.smartlead_api_key || null;
  // Campaign on the shared master account: route it, use the env master key at
  // runtime, never store that key on this client.
  const campaignIds = campaignIdsFrom(body);
  const smartleadClientId = body.smartlead_client_id != null
    ? (String(body.smartlead_client_id) || null)
    : (existing?.smartlead_client_id || null);
  const useMaster = !slKey && (campaignIds.length > 0 || !!smartleadClientId);
  const env = deps.env || process.env;
  const master = String(env.SMARTLEAD_MASTER_API_KEY || '').trim();
  if (useMaster && !master) return { status: 500, json: { error: 'SMARTLEAD_MASTER_API_KEY not set on server' } };

  const plan = {
    action: existing ? 'update' : 'create',
    client_id: existing?.id || null,
    name,
    slack_channel_id: channel,
    booking_link: booked.booking_link || null,
    smartlead_campaign_id: body.smartlead_campaign_id || null,
    campaign_ids: campaignIds,
    smartlead_client_id: smartleadClientId,
    smartlead_key: slKey ? 'client' : (useMaster ? 'master (runtime, not stored)' : 'none'),
    campaign_route: useMaster && campaignIds.length === 1 ? campaignIds[0] : null,
    campaign_routes: useMaster ? campaignIds : [],
  };
  if (dryRun) return { status: 200, json: { ok: true, dry_run: true, plan } };

  let client;
  if (existing) {
    ({ rows: [client] } = await q(
      `UPDATE clients SET name=$1, slack_channel_id=$2, slack_bot_token=$3, booking_link=$4,
              booking_destination_url=$5, smartlead_api_key=$6, updated_at=now()
        WHERE id=$7 RETURNING *`,
      [name, channel, token, booked.booking_link || null, booked.booking_destination_url || null, slKey, existing.id]
    ));
  } else {
    ({ rows: [client] } = await q(
      `INSERT INTO clients (name, slack_bot_token, slack_channel_id, booking_link,
              booking_destination_url, smartlead_api_key, voice_prompt)
       VALUES ($1,$2,$3,$4,$5,$6,'') RETURNING *`,
      [name, token, channel, booked.booking_link || null, booked.booking_destination_url || null, slKey]
    ));
  }

  if (useMaster) {
    ({ rows: [client] } = await q(
      'UPDATE clients SET smartlead_use_master_key = true, updated_at = now() WHERE id = $1 RETURNING *',
      [client.id]
    ));
  }
  if (body.smartlead_client_id != null) {
    ({ rows: [client] } = await q(
      'UPDATE clients SET smartlead_client_id = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [smartleadClientId, client.id]
    ));
  }
  // Routes are ADDED per campaign (campaign_id is the primary key); other
  // campaigns already routed to this client are never removed.
  if (useMaster && campaignIds.length) {
    for (const cid of campaignIds) {
      await q(
        `INSERT INTO smartlead_campaign_routes (campaign_id, client_id) VALUES ($1, $2)
         ON CONFLICT (campaign_id) DO UPDATE SET client_id = EXCLUDED.client_id, updated_at = now()`,
        [cid, client.id]
      );
    }
    resetCampaignRouteCache();
  }
  const out = { ok: true, action: plan.action, client: safeView(client) };
  if (useMaster && campaignIds.length === 1) out.campaign_route = { campaign_id: campaignIds[0], client_id: client.id };
  const hookKey = slKey || (useMaster ? master : null);
  if (campaignIds.length) {
    const target = webhookUrls(client.id).smartlead_webhook_url;
    const results = [];
    for (const cid of campaignIds) {
      results.push({ campaign_id: cid, routed: useMaster, webhook: await ensureHook(sl, hookKey, cid, target) });
    }
    if (campaignIds.length === 1) out.webhook = results[0].webhook;
    else out.campaigns = results;
  }
  if (useMaster) {
    const { rows } = await q('SELECT campaign_id FROM smartlead_campaign_routes WHERE client_id = $1 ORDER BY campaign_id', [client.id]);
    out.routed_campaign_ids = (rows || []).map((r) => String(r.campaign_id));
  }
  console.log('[Onboarding] client upsert', { id: client.id, action: plan.action, webhook: out.webhook?.registered, campaigns: campaignIds.length });
  return { status: existing ? 200 : 201, json: out };
}

const router = Router();
router.post('/admin/onboarding/client', requireAdminApiKey, async (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  try {
    const r = await upsertOnboardingClient(req.body);
    res.status(r.status).json(r.json);
  } catch (err) {
    console.error('[Onboarding] upsert error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/onboarding/routes', requireAdminApiKey, async (req, res) => {
  try {
    const cid = req.query.client_id;
    const { rows } = cid
      ? await db.query('SELECT campaign_id, client_id, updated_at FROM smartlead_campaign_routes WHERE client_id = $1 ORDER BY campaign_id', [cid])
      : await db.query('SELECT campaign_id, client_id, updated_at FROM smartlead_campaign_routes ORDER BY client_id, campaign_id', []);
    res.json({ ok: true, count: rows.length, routes: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/onboarding/sync-campaigns', requireAdminApiKey, async (req, res) => {
  try {
    const dryRun = req.body?.dry_run === true || /^(1|true|yes)$/i.test(String(req.body?.dry_run || ''));
    const r = await autoRouteClientCampaigns({ dryRun, clientId: req.body?.client_id || null });
    res.json({ ok: true, dry_run: dryRun, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message.replace(/api_key=[^&\s]+/g, 'api_key=***') });
  }
});

module.exports = router;
module.exports.upsertOnboardingClient = upsertOnboardingClient;
module.exports.validate = validate;
module.exports.campaignIdsFrom = campaignIdsFrom;
