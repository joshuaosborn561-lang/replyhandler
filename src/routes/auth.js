const { Router } = require('express');
const db = require('../db');
const google = require('../services/google-calendar');
const microsoft = require('../services/microsoft-calendar');
const gmail = require('../services/gmail-send');

const router = Router();

function gmailConnectAuthorized(req) {
  // Only gate if an explicit primary-Gmail connect secret is set.
  // Do NOT reuse WEBHOOK_TEST_SECRET — that blocked the one-time mailbox connect.
  const expected = String(process.env.PRIMARY_GMAIL_CONNECT_SECRET || '').trim();
  if (!expected) return true;
  const got = String(req.query.secret || req.headers['x-webhook-test-secret'] || '').trim();
  return got && got === expected;
}

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

// ─── Primary Gmail (SalesGlider notify mailbox) ──────────────────────
router.get('/auth/gmail/connect', async (req, res) => {
  if (!gmailConnectAuthorized(req)) {
    return res.status(401).send('Unauthorized — pass ?secret=WEBHOOK_TEST_SECRET');
  }
  if (!gmail.isConfigured()) {
    return res.status(500).send('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured on this server');
  }
  try {
    const url = gmail.getAuthUrl();
    res.redirect(url);
  } catch (err) {
    console.error('[Auth] Gmail connect failed', { err: err.message });
    res.status(500).send(err.message);
  }
});

router.get('/auth/gmail/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    console.error('[Auth] Gmail OAuth error', { error });
    return res.status(400).send(`Gmail OAuth error: ${error}`);
  }
  if (!code) return res.status(400).send('Missing code');

  try {
    const tokens = await gmail.exchangeCode(code);
    if (!tokens.refresh_token) {
      return res.status(400).send(
        'No refresh_token returned. Revoke app access at https://myaccount.google.com/permissions then retry /auth/gmail/connect with prompt=consent.'
      );
    }
    const email = await gmail.getUserEmail(tokens.access_token);
    const expected = gmail.expectedFromEmail();
    if (expected && email !== expected) {
      console.warn('[Auth] Gmail connected email differs from PRIMARY_GMAIL_FROM', { email, expected });
    }
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);
    await gmail.upsertAccount({
      email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
    });
    console.log('[Auth] Primary Gmail connected', { email });
    res.status(200).send(
      `Primary Gmail connected as <strong>${email}</strong>. Client notifies will send from this mailbox. You can close this tab.`
    );
  } catch (err) {
    console.error('[Auth] Gmail callback failed', { err: err.message });
    res.status(500).send(`Gmail connect failed: ${err.message}`);
  }
});

router.get('/auth/gmail/status', async (req, res) => {
  try {
    const account = await gmail.getAccount();
    res.json({
      configured: gmail.isConfigured(),
      connected: Boolean(account),
      email: account?.email || null,
      expectedFrom: gmail.expectedFromEmail(),
      redirectUri: gmail.getRedirectUri(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
