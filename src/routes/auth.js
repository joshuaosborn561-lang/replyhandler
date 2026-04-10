const { Router } = require('express');
const db = require('../db');
const google = require('../services/google-calendar');
const microsoft = require('../services/microsoft-calendar');

const router = Router();

// ─── Google OAuth ────────────────────────────────────────────────────
router.get('/auth/google/connect/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { rows: [client] } = await db.query('SELECT id FROM clients WHERE id = $1', [clientId]);
  if (!client) return res.status(404).send('Client not found');

  const url = google.getAuthUrl(clientId);
  res.redirect(url);
});

router.get('/auth/google/callback', async (req, res) => {
  const { code, state: clientId, error } = req.query;

  if (error) {
    console.error('[Auth] Google OAuth error', { error });
    return res.redirect(`/dashboard?auth=error&provider=google`);
  }

  try {
    const tokens = await google.exchangeCode(code);
    const email = await google.getUserEmail(tokens.access_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await db.query(
      `INSERT INTO calendar_connections (client_id, provider, email, access_token, refresh_token, token_expires_at)
       VALUES ($1, 'google', $2, $3, $4, $5)
       ON CONFLICT (client_id, provider)
       DO UPDATE SET email = $2, access_token = $3, refresh_token = $4, token_expires_at = $5, updated_at = now()`,
      [clientId, email, tokens.access_token, tokens.refresh_token, expiresAt]
    );

    console.log('[Auth] Google Calendar connected', { clientId, email });
    res.redirect(`/dashboard?auth=success&provider=google`);
  } catch (err) {
    console.error('[Auth] Google callback failed', { err: err.message });
    res.redirect(`/dashboard?auth=error&provider=google`);
  }
});

// ─── Microsoft OAuth ─────────────────────────────────────────────────
router.get('/auth/microsoft/connect/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { rows: [client] } = await db.query('SELECT id FROM clients WHERE id = $1', [clientId]);
  if (!client) return res.status(404).send('Client not found');

  const url = microsoft.getAuthUrl(clientId);
  res.redirect(url);
});

router.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state: clientId, error } = req.query;

  if (error) {
    console.error('[Auth] Microsoft OAuth error', { error });
    return res.redirect(`/dashboard?auth=error&provider=microsoft`);
  }

  try {
    const tokens = await microsoft.exchangeCode(code);
    const email = await microsoft.getUserEmail(tokens.access_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await db.query(
      `INSERT INTO calendar_connections (client_id, provider, email, access_token, refresh_token, token_expires_at)
       VALUES ($1, 'microsoft', $2, $3, $4, $5)
       ON CONFLICT (client_id, provider)
       DO UPDATE SET email = $2, access_token = $3, refresh_token = $4, token_expires_at = $5, updated_at = now()`,
      [clientId, email, tokens.access_token, tokens.refresh_token, expiresAt]
    );

    console.log('[Auth] Microsoft Calendar connected', { clientId, email });
    res.redirect(`/dashboard?auth=success&provider=microsoft`);
  } catch (err) {
    console.error('[Auth] Microsoft callback failed', { err: err.message });
    res.redirect(`/dashboard?auth=error&provider=microsoft`);
  }
});

// ─── Status endpoint for dashboard ──────────────────────────────────
router.get('/auth/calendar-status/:clientId', async (req, res) => {
  const { rows } = await db.query(
    'SELECT provider, email, created_at FROM calendar_connections WHERE client_id = $1',
    [req.params.clientId]
  );
  res.json(rows);
});

// ─── Disconnect ─────────────────────────────────────────────────────
router.delete('/auth/calendar/:clientId/:provider', async (req, res) => {
  await db.query(
    'DELETE FROM calendar_connections WHERE client_id = $1 AND provider = $2',
    [req.params.clientId, req.params.provider]
  );
  res.json({ ok: true });
});

module.exports = router;
