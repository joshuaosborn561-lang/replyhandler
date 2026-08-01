const crypto = require('crypto');

const COOKIE_NAME = 'sg_admin';
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function getAdminSecret() {
  return String(process.env.WEBHOOK_TEST_SECRET || '').trim();
}

function parseCookies(header) {
  const out = {};
  for (const pair of String(header || '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function readProvidedSecret(req) {
  const header = req.get ? req.get('x-webhook-test-secret') : req.headers?.['x-webhook-test-secret'];
  if (header) return String(header);
  if (req.query?.secret) return String(req.query.secret);
  if (req.body?.secret) return String(req.body.secret);
  return '';
}

function constantTimeEqual(value, expected) {
  const a = Buffer.from(String(value || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyAdminSecret(req) {
  const expected = getAdminSecret();
  if (!expected) return false;
  if (constantTimeEqual(readProvidedSecret(req), expected)) return true;
  const session = String(parseCookies(req.headers?.cookie)[COOKIE_NAME] || '');
  return verifySessionToken(session, expected);
}

function createSessionToken(secret = getAdminSecret()) {
  const expires = Date.now() + COOKIE_MAX_AGE_SECONDS * 1000;
  const payload = `${expires}.${crypto.randomBytes(18).toString('base64url')}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

function verifySessionToken(token, secret = getAdminSecret()) {
  if (!token || !secret) return false;
  const [encoded, signature] = String(token).split('.');
  if (!encoded || !signature) return false;
  let payload;
  try { payload = Buffer.from(encoded, 'base64url').toString('utf8'); } catch { return false; }
  const [expires] = payload.split('.');
  if (!Number.isFinite(Number(expires)) || Number(expires) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return constantTimeEqual(signature, expected);
}

function wantsHtml(req) {
  return String(req.headers?.accept || '').includes('text/html') ||
    String(req.originalUrl || req.path || '').startsWith('/dashboard');
}

function denyAdminSecret(req, res) {
  const configured = Boolean(getAdminSecret());
  const status = configured ? 401 : 404;
  if (wantsHtml(req)) {
    if (configured) return res.redirect('/dashboard/login');
    return res.status(status).type('text/plain').send('Not found.');
  }
  return res.status(status).json({ error: configured ? 'unauthorized' : 'not found' });
}

function requireAdminSecret(req, res, next) {
  if (!verifyAdminSecret(req)) return denyAdminSecret(req, res);
  return next();
}

function setSessionCookie(req, res) {
  const secure = Boolean(process.env.RAILWAY_PUBLIC_DOMAIN) ||
    String(req.headers?.['x-forwarded-proto'] || '').toLowerCase() === 'https';
  res.cookie(COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
    path: '/',
  });
}

function loginPage(error = '') {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ReplyHandler Admin</title></head>
<body style="font:16px system-ui;max-width:420px;margin:12vh auto;padding:24px">
<h1>ReplyHandler Admin</h1>
${error ? `<p style="color:#b00020">${error}</p>` : ''}
<form method="post" action="/dashboard/login">
<label>Admin secret<br><input type="password" name="secret" required autofocus
 style="width:100%;padding:10px;margin:8px 0 16px"></label>
<button type="submit" style="padding:10px 18px">Sign in</button>
</form></body></html>`;
}

function requireAdminSecretOrSetCookie(req, res, next) {
  if (req.path === '/login') {
    if (!getAdminSecret()) return res.status(404).type('text/plain').send('Not found.');
    if (req.method === 'GET') return res.status(200).type('html').send(loginPage());
    if (req.method === 'POST') {
      if (!constantTimeEqual(readProvidedSecret(req), getAdminSecret())) {
        return res.status(401).type('html').send(loginPage('Incorrect secret.'));
      }
      setSessionCookie(req, res);
      return res.redirect('/dashboard');
    }
    return res.status(405).send('Method not allowed');
  }

  if (!verifyAdminSecret(req)) return denyAdminSecret(req, res);

  if (req.query?.secret) {
    setSessionCookie(req, res);
    return res.redirect('/dashboard');
  }
  return next();
}

module.exports = {
  COOKIE_NAME,
  getAdminSecret,
  readProvidedSecret,
  createSessionToken,
  verifySessionToken,
  verifyAdminSecret,
  denyAdminSecret,
  requireAdminSecret,
  requireAdminSecretOrSetCookie,
};
