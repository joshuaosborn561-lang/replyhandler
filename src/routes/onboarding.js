/**
 * Onboarding bot: create or update one replyhandler client and (optionally)
 * hook ONE SmartLead campaign's EMAIL_REPLY webhook to it.
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

  const plan = {
    action: existing ? 'update' : 'create',
    client_id: existing?.id || null,
    name,
    slack_channel_id: channel,
    booking_link: booked.booking_link || null,
    smartlead_campaign_id: body.smartlead_campaign_id || null,
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

  const out = { ok: true, action: plan.action, client: safeView(client) };
  if (body.smartlead_campaign_id) {
    const target = webhookUrls(client.id).smartlead_webhook_url;
    if (!slKey) {
      out.webhook = { registered: false, reason: 'no smartlead_api_key on client' };
    } else {
      try {
        const hooks = await sl.listCampaignWebhooks(slKey, body.smartlead_campaign_id);
        if ((hooks || []).some((h) => sl.webhookHasEmailReply(h, target))) {
          out.webhook = { registered: true, created: false, url: target };
        } else {
          await sl.createEmailReplyWebhook(slKey, body.smartlead_campaign_id, target);
          out.webhook = { registered: true, created: true, url: target };
        }
      } catch (err) {
        out.webhook = { registered: false, error: err.message.replace(/api_key=[^&\s]+/g, 'api_key=***') };
      }
    }
  }
  console.log('[Onboarding] client upsert', { id: client.id, action: plan.action, webhook: out.webhook?.registered });
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

module.exports = router;
module.exports.upsertOnboardingClient = upsertOnboardingClient;
module.exports.validate = validate;
