const { Router } = require('express');
const db = require('../db');
const { requireAdminSecret } = require('../middleware/adminSecret');
const { setManualRoute } = require('../services/smartlead-campaign-route');

const router = Router();
router.use(requireAdminSecret);

// Explicit repair/override for campaign ownership. Never infer by name.
router.put('/admin/smartlead-routes/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const clientId = String(req.body?.client_id || '').trim();
    if (!campaignId || !clientId) {
      return res.status(400).json({ error: 'campaignId and client_id are required' });
    }
    const { rows } = await db.query('SELECT id, name FROM clients WHERE id = $1', [clientId]);
    if (!rows[0]) return res.status(404).json({ error: 'client not found' });
    const route = await setManualRoute({
      campaignId,
      clientId,
      campaignName: req.body?.campaign_name || null,
    });
    console.log('[Admin] SmartLead campaign route set manually', {
      campaignId,
      clientId,
      client: rows[0].name,
    });
    return res.json(route);
  } catch (err) {
    console.error('[Admin] SmartLead route update failed', { err: err.message });
    return res.status(500).json({ error: err.message });
  }
});

function webhookUrls(clientId) {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + (process.env.PORT || 3000);
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return {
    smartlead_webhook_url: `${protocol}://${domain}/webhook/smartlead/${clientId}`,
    heyreach_webhook_url: `${protocol}://${domain}/webhook/heyreach/${clientId}`,
  };
}

function formatClient(client) {
  return { ...client, ...webhookUrls(client.id) };
}

function normalizeCcListField(value) {
  if (value == null) return null;
  const parts = String(value)
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'));
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.length ? out.join(', ') : null;
}

// Create client
router.post('/admin/clients', async (req, res) => {
  try {
    const {
      name, smartlead_api_key, heyreach_api_key, slack_bot_token,
      slack_channel_id, booking_link, calendly_personal_access_token, voice_prompt, digest_timezone,
      cc_email, cc_emails, cc_round_robin_emails,
    } = req.body;

    if (!name || !slack_bot_token || !slack_channel_id) {
      return res.status(400).json({ error: 'name, slack_bot_token, and slack_channel_id are required' });
    }

    const alwaysCc = normalizeCcListField(cc_emails || cc_email);
    const rr = normalizeCcListField(cc_round_robin_emails);
    const legacyCc = alwaysCc ? alwaysCc.split(',')[0].trim() : null;

    const { rows: [client] } = await db.query(
      `INSERT INTO clients (
         name, smartlead_api_key, heyreach_api_key, slack_bot_token, slack_channel_id,
         booking_link, calendly_personal_access_token, voice_prompt, digest_timezone,
         cc_email, cc_emails, cc_round_robin_emails
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        name,
        smartlead_api_key || null,
        heyreach_api_key || null,
        slack_bot_token,
        slack_channel_id,
        booking_link || null,
        calendly_personal_access_token || null,
        voice_prompt || '',
        digest_timezone || null,
        legacyCc,
        alwaysCc,
        rr,
      ]
    );

    console.log('[Admin] Client created', { id: client.id, name: client.name });
    res.status(201).json(formatClient(client));
  } catch (err) {
    console.error('[Admin] Create client error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// List clients
router.get('/admin/clients', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(rows.map(formatClient));
  } catch (err) {
    console.error('[Admin] List clients error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Update client
router.patch('/admin/clients/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const fields = req.body;
    const allowedFields = [
      'name', 'smartlead_api_key', 'heyreach_api_key', 'slack_bot_token',
      'slack_channel_id', 'booking_link', 'calendly_personal_access_token', 'voice_prompt',
      'active', 'digest_timezone', 'cc_email', 'cc_emails', 'cc_round_robin_emails',
    ];

    const updates = [];
    const values = [];
    let idx = 1;

    // Normalize list fields + keep legacy cc_email in sync with first always-CC address.
    if (Object.prototype.hasOwnProperty.call(fields, 'cc_emails')
      || Object.prototype.hasOwnProperty.call(fields, 'cc_email')) {
      const alwaysCc = normalizeCcListField(fields.cc_emails != null ? fields.cc_emails : fields.cc_email);
      fields.cc_emails = alwaysCc;
      fields.cc_email = alwaysCc ? alwaysCc.split(',')[0].trim() : null;
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'cc_round_robin_emails')) {
      fields.cc_round_robin_emails = normalizeCcListField(fields.cc_round_robin_emails);
    }

    for (const [key, value] of Object.entries(fields)) {
      if (allowedFields.includes(key)) {
        updates.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push(`updated_at = now()`);
    values.push(clientId);

    const { rows: [client] } = await db.query(
      `UPDATE clients SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log('[Admin] Client updated', { id: client.id, name: client.name });
    res.json(formatClient(client));
  } catch (err) {
    console.error('[Admin] Update client error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
