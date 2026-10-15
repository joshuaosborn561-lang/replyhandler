/**
 * Gate for every /admin route.
 *
 * Require header ADMIN_API_KEY (alias x-admin-api-key). Fail closed when the
 * env var is missing — do not 404-and-open the way WEBHOOK_TEST_SECRET did.
 */

const crypto = require('crypto');

function configuredAdminKey(env = process.env) {
  return String(env.ADMIN_API_KEY || '').trim();
}

function readAdminHeader(req) {
  if (!req || typeof req.get !== 'function') return '';
  return String(
    req.get('ADMIN_API_KEY') || req.get('x-admin-api-key') || '',
  ).trim();
}

function evaluateAdminAuth(env, headerValue) {
  const secret = configuredAdminKey(env);
  if (!secret) {
    return { ok: false, status: 503, error: 'admin auth not configured' };
  }
  const token = String(headerValue || '');
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

function requireAdminApiKey(req, res, next) {
  const result = evaluateAdminAuth(process.env, readAdminHeader(req));
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  if (typeof next === 'function') next();
}

module.exports = {
  configuredAdminKey,
  readAdminHeader,
  evaluateAdminAuth,
  requireAdminApiKey,
};
