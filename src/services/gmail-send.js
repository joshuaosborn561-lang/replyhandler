/**
 * Primary-domain Gmail sender (used to notify clients on reply).
 * OAuth client: GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET (separate from per-client calendar Google OAuth).
 */

const db = require('../db');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function clientId() {
  return String(process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '').trim();
}

function clientSecret() {
  return String(process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '').trim();
}

function expectedFromEmail() {
  return String(process.env.PRIMARY_GMAIL_FROM || '').trim().toLowerCase();
}

function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

function getRedirectUri() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${process.env.PORT || 3000}`;
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return `${protocol}://${domain}/auth/gmail/callback`;
}

function getAuthUrl() {
  if (!isConfigured()) throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured');
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    ...(expectedFromEmail() ? { login_hint: expectedFromEmail() } : {}),
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function exchangeCode(code) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`Gmail token exchange failed: ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${await res.text()}`);
  return res.json();
}

async function getUserEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to get Gmail user info: ${await res.text()}`);
  const data = await res.json();
  return String(data.email || '').toLowerCase();
}

async function upsertAccount({ email, accessToken, refreshToken, expiresAt }) {
  await db.query(
    `INSERT INTO primary_mail_accounts (provider, email, access_token, refresh_token, token_expires_at)
     VALUES ('gmail', $1, $2, $3, $4)
     ON CONFLICT (provider)
     DO UPDATE SET
       email = EXCLUDED.email,
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, primary_mail_accounts.refresh_token),
       token_expires_at = EXCLUDED.token_expires_at,
       updated_at = now()`,
    [email, accessToken, refreshToken, expiresAt]
  );
}

async function getAccount() {
  const { rows } = await db.query(
    `SELECT * FROM primary_mail_accounts WHERE provider = 'gmail' LIMIT 1`
  );
  return rows[0] || null;
}

async function getValidAccessToken() {
  const account = await getAccount();
  if (!account) {
    throw new Error('Primary Gmail not connected — visit /auth/gmail/connect');
  }
  if (account.token_expires_at && new Date(account.token_expires_at) > new Date(Date.now() + 60_000)) {
    return { token: account.access_token, account };
  }
  const tokens = await refreshAccessToken(account.refresh_token);
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);
  await db.query(
    `UPDATE primary_mail_accounts
        SET access_token = $1, token_expires_at = $2, updated_at = now()
      WHERE id = $3`,
    [tokens.access_token, expiresAt, account.id]
  );
  return { token: tokens.access_token, account: { ...account, access_token: tokens.access_token } };
}

function encodeSubject(subject) {
  const s = String(subject || '');
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function toBase64Url(raw) {
  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildRawMime({ from, to, subject, htmlBody, textBody }) {
  const toList = Array.isArray(to) ? to.join(', ') : String(to);
  const boundary = `sg_${Date.now().toString(36)}`;
  const html = String(htmlBody || '');
  const text = String(textBody || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const lines = [
    `From: ${from}`,
    `To: ${toList}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ];
  return toBase64Url(lines.join('\r\n'));
}

/**
 * Send email from the connected primary Gmail account.
 * @param {{ to: string|string[], subject: string, htmlBody: string, textBody?: string }} opts
 */
async function sendMail({ to, subject, htmlBody, textBody }) {
  const recipients = (Array.isArray(to) ? to : String(to || '').split(/[,;]+/))
    .map((e) => e.trim())
    .filter((e) => e.includes('@'));
  if (!recipients.length) throw new Error('Gmail sendMail: no recipients');

  const { token, account } = await getValidAccessToken();
  const from = account.email || expectedFromEmail();
  const raw = buildRawMime({
    from,
    to: recipients,
    subject,
    htmlBody,
    textBody,
  });

  const res = await fetch(`${GMAIL_API}/users/me/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Gmail send failed (${res.status}): ${body.slice(0, 400)}`);
  }
  try {
    return { ...(JSON.parse(body) || {}), from, to: recipients };
  } catch {
    return { ok: true, from, to: recipients, raw: body };
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  getRedirectUri,
  exchangeCode,
  getUserEmail,
  upsertAccount,
  getAccount,
  expectedFromEmail,
  sendMail,
};
