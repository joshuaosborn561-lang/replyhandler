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
  return String(parseCookies(req.headers?.cookie)[COOKIE_NAME] || '');
}

function constantTimeEqual(value, expected) {
  const a = Buffer.from(String(value || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyAdminSecret(req) {
  const expected = getAdminSecret();
  if (!expected) return false;
  return constantTimeEqual(readProvidedSecret(req), expected);
}

function wantsHtml(req) {
  return String(req.headers?.accept || '').includes('text/html') ||
    String(req.originalUrl || req.path || '').startsWith('/dashboard');
}

function denyAdminSecret(req, res) {
  const configured = Boolean(getAdminSecret());
  const status = configured ? 401 : 404;
  if (wantsHtml(req)) {
    const message = configured
      ? 'Unauthorized. Open /dashboard?secret=YOUR_WEBHOOK_TEST_SECRET once to sign in.'
      : 'Not found.';
    return res.status(status).type('text/plain').send(message);
  }
  return res.status(status).json({ error: configured ? 'unauthorized' : 'not found' });
}

function requireAdminSecret(req, res, next) {
  if (!verifyAdminSecret(req)) return denyAdminSecret(req, res);
  return next();
}

function requireAdminSecretOrSetCookie(req, res, next) {
  if (!verifyAdminSecret(req)) return denyAdminSecret(req, res);

  if (req.query?.secret) {
    const secure = Boolean(process.env.RAILWAY_PUBLIC_DOMAIN) ||
      String(req.headers?.['x-forwarded-proto'] || '').toLowerCase() === 'https';
    res.cookie(COOKIE_NAME, getAdminSecret(), {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
      path: '/',
    });
    return res.redirect('/dashboard');
  }
  return next();
}

module.exports = {
  COOKIE_NAME,
  getAdminSecret,
  readProvidedSecret,
  verifyAdminSecret,
  denyAdminSecret,
  requireAdminSecret,
  requireAdminSecretOrSetCookie,
};
