const crypto = require('crypto');

function secret() {
  return String(process.env.WEBHOOK_TEST_SECRET || '').trim();
}

function createOAuthState({ provider, clientId = null, ttlMs = 10 * 60 * 1000 }) {
  const key = secret();
  if (!key) throw new Error('WEBHOOK_TEST_SECRET is required for OAuth state');
  const payload = {
    provider,
    clientId,
    expiresAt: Date.now() + ttlMs,
    nonce: crypto.randomBytes(18).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyOAuthState(state, expectedProvider) {
  const key = secret();
  if (!key || !state) return null;
  const [encoded, signature] = String(state).split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
  if (payload.provider !== expectedProvider) return null;
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now()) return null;
  return payload;
}

module.exports = { createOAuthState, verifyOAuthState };
