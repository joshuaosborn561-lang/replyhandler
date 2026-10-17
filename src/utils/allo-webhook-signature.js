/**
 * Allo webhook HMAC-SHA256 verification.
 *
 * Headers: webhook-id, webhook-timestamp, webhook-signature (v1,<base64>).
 * Signed content: `{id}.{timestamp}.{raw_body}`.
 * Secret is `whsec_` + base64 key bytes.
 *
 * @see https://help.withallo.com/en/v2/api-reference/webhooks/verifying-signatures
 */

const crypto = require('crypto');

const MAX_SKEW_SECONDS = 300;

function header(headers, name) {
  if (!headers) return '';
  const want = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    return String(headers.get(name) || headers.get(want) || '').trim();
  }
  const raw = headers[name] || headers[want] || headers[name.toLowerCase()];
  return String(raw || '').trim();
}

function signingSecretBytes(secret) {
  const s = String(secret || '').trim();
  if (!s) return null;
  const b64 = s.startsWith('whsec_') ? s.slice('whsec_'.length) : s;
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

function parseSignatures(headerValue) {
  const out = [];
  for (const part of String(headerValue || '').split(/\s+/)) {
    const comma = part.indexOf(',');
    if (comma < 0) continue;
    const version = part.slice(0, comma);
    const sig = part.slice(comma + 1);
    if (version === 'v1' && sig) out.push(sig);
  }
  return out;
}

function timingSafeEqualB64(a, b) {
  try {
    const aa = Buffer.from(String(a || ''), 'base64');
    const bb = Buffer.from(String(b || ''), 'base64');
    if (!aa.length || aa.length !== bb.length) return false;
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

/**
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
function verifyAlloWebhookSignature({ rawBody, headers, secret, nowSec } = {}) {
  const key = signingSecretBytes(secret);
  if (!key) {
    return { ok: false, status: 503, error: 'allo_webhook_not_configured' };
  }

  const webhookId = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signature = header(headers, 'webhook-signature');

  if (!webhookId || !timestamp || !signature) {
    return { ok: false, status: 401, error: 'missing_signature' };
  }

  const ts = Number(timestamp);
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, error: 'timestamp_expired' };
  }

  const payload = rawBody == null ? '' : Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedContent = `${webhookId}.${timestamp}.${payload}`;
  const computed = crypto.createHmac('sha256', key).update(signedContent).digest('base64');
  const candidates = parseSignatures(signature);
  if (!candidates.length || !candidates.some((sig) => timingSafeEqualB64(sig, computed))) {
    return { ok: false, status: 401, error: 'invalid_signature' };
  }

  return { ok: true, webhookId };
}

function signAlloWebhook({ rawBody, webhookId, timestamp, secret }) {
  const key = signingSecretBytes(secret);
  if (!key) throw new Error('missing Allo signing secret');
  const payload = rawBody == null ? '' : Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedContent = `${webhookId}.${timestamp}.${payload}`;
  const computed = crypto.createHmac('sha256', key).update(signedContent).digest('base64');
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${computed}`,
  };
}

module.exports = {
  MAX_SKEW_SECONDS,
  verifyAlloWebhookSignature,
  signAlloWebhook,
  signingSecretBytes,
};
