/**
 * Read-only dashboard API. Open — no ADMIN_API_KEY.
 * Never returns SmartLead / HeyReach / Allo keys or Slack tokens.
 */

const { Router } = require('express');
const db = require('../db');
const { toPublicClient, stripSecrets } = require('../utils/public-client');

const router = Router();

router.get('/dashboard/api/clients', async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, active, slack_channel_id, booking_link, booking_destination_url,
              voice_prompt, digest_timezone, cc_email, cc_emails, cc_round_robin_emails,
              contact_email, created_at, updated_at,
              (smartlead_api_key IS NOT NULL AND smartlead_api_key <> '') AS has_smartlead_api_key,
              (heyreach_api_key IS NOT NULL AND heyreach_api_key <> '') AS has_heyreach_api_key,
              (allo_api_key IS NOT NULL AND allo_api_key <> '') AS has_allo_api_key,
              (slack_bot_token IS NOT NULL AND slack_bot_token <> '') AS has_slack_bot_token
         FROM clients
        ORDER BY created_at DESC`
    );
    res.json(stripSecrets(rows.map((row) => toPublicClient(row))));
  } catch (err) {
    console.error('[Dashboard] List clients error', { err: err.message });
    res.status(500).json({ error: 'failed to load clients' });
  }
});

router.get('/dashboard/api/clients/:clientId', async (req, res) => {
  try {
    const { rows: [row] } = await db.query(
      `SELECT id, name, active, slack_channel_id, booking_link, booking_destination_url,
              voice_prompt, digest_timezone, cc_email, cc_emails, cc_round_robin_emails,
              contact_email, created_at, updated_at,
              (smartlead_api_key IS NOT NULL AND smartlead_api_key <> '') AS has_smartlead_api_key,
              (heyreach_api_key IS NOT NULL AND heyreach_api_key <> '') AS has_heyreach_api_key,
              (allo_api_key IS NOT NULL AND allo_api_key <> '') AS has_allo_api_key,
              (slack_bot_token IS NOT NULL AND slack_bot_token <> '') AS has_slack_bot_token
         FROM clients
        WHERE id = $1`,
      [req.params.clientId]
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(stripSecrets(toPublicClient(row)));
  } catch (err) {
    console.error('[Dashboard] Get client error', { err: err.message });
    res.status(500).json({ error: 'failed to load client' });
  }
});

router.get('/dashboard/api/clients/:clientId/calendar', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT provider, email, created_at
         FROM calendar_connections
        WHERE client_id = $1`,
      [req.params.clientId]
    );
    res.json(stripSecrets(rows));
  } catch (err) {
    console.error('[Dashboard] Calendar status error', { err: err.message });
    res.status(500).json({ error: 'failed to load calendar status' });
  }
});

module.exports = router;
