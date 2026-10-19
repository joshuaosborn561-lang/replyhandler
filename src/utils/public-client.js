/**
 * Public dashboard view of a client row.
 *
 * The open /dashboard/api routes must never return SmartLead / HeyReach /
 * Allo keys or Slack tokens. Presence is a boolean; the secret itself stays
 * on /admin (keyed).
 */

const SECRET_FIELD_RE = /(api[_-]?key|token|secret|password|authorization|private[_-]?key)/i;

const SECRET_FIELDS = [
  'smartlead_api_key',
  'heyreach_api_key',
  'allo_api_key',
  'slack_bot_token',
];

function webhookUrls(clientId) {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${process.env.PORT || 3000}`;
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return {
    smartlead_webhook_url: `${protocol}://${domain}/webhook/smartlead/${clientId}`,
    heyreach_webhook_url: `${protocol}://${domain}/webhook/heyreach/${clientId}`,
  };
}

function looksSecretField(key) {
  const k = String(key || '');
  if (k.startsWith('has_')) return false;
  if (k.endsWith('_webhook_url')) return false;
  if (k === 'slack_channel_id') return false;
  return SECRET_FIELD_RE.test(k);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PREFIX_RE = /^(xox[abposr]-|sk-|ghp_)/i;
const TOKEN_BLOB_RE = /^[A-Za-z0-9_-]{32,}$/;

/** True for Slack/GitHub/OpenAI-style tokens and opaque 32+ blobs that are not UUIDs. */
function looksLikeTokenValue(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  if (TOKEN_PREFIX_RE.test(s)) return true;
  if (UUID_RE.test(s)) return false;
  return TOKEN_BLOB_RE.test(s);
}

function blankTokenValues(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return value;
  if (typeof value === 'string') return looksLikeTokenValue(value) ? '' : value;
  if (Array.isArray(value)) return value.map((v) => blankTokenValues(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = blankTokenValues(val, depth + 1);
  }
  return out;
}

function stripSecretFields(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return undefined;
  if (Array.isArray(value)) return value.map((v) => stripSecretFields(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (looksSecretField(key)) continue;
    out[key] = stripSecretFields(val, depth + 1);
  }
  return out;
}

/**
 * Drop secret-named fields, then blank any remaining token-shaped string
 * regardless of field name (e.g. a bot token stored in slack_channel_id).
 * The value scan runs last on the final object.
 */
function stripSecrets(value) {
  return blankTokenValues(stripSecretFields(value, 0), 0);
}

function toPublicClient(row) {
  const src = row && typeof row === 'object' ? row : {};
  const publicRow = {
    id: src.id,
    name: src.name,
    active: src.active !== false,
    slack_channel_id: src.slack_channel_id || null,
    booking_link: src.booking_link || null,
    booking_destination_url: src.booking_destination_url || null,
    voice_prompt: src.voice_prompt || '',
    digest_timezone: src.digest_timezone || null,
    cc_email: src.cc_email || null,
    cc_emails: src.cc_emails || null,
    cc_round_robin_emails: src.cc_round_robin_emails || null,
    contact_email: src.contact_email || null,
    created_at: src.created_at,
    updated_at: src.updated_at,
    has_smartlead_api_key: Boolean(src.has_smartlead_api_key || src.smartlead_api_key),
    has_heyreach_api_key: Boolean(src.has_heyreach_api_key || src.heyreach_api_key),
    has_allo_api_key: Boolean(src.has_allo_api_key || src.allo_api_key),
    has_slack_bot_token: Boolean(src.has_slack_bot_token || src.slack_bot_token),
    ...webhookUrls(src.id),
  };
  return stripSecrets(publicRow);
}

function assertNoSecretFields(payload, path = '') {
  if (payload == null) return;
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertNoSecretFields(item, `${path}[${i}]`));
    return;
  }
  if (typeof payload !== 'object') return;
  for (const [key, val] of Object.entries(payload)) {
    if (looksSecretField(key)) {
      const err = new Error(`secret field leaked: ${path ? `${path}.` : ''}${key}`);
      err.code = 'SECRET_FIELD';
      throw err;
    }
    assertNoSecretFields(val, path ? `${path}.${key}` : key);
  }
}

function assertNoTokenValues(payload, path = '') {
  if (payload == null) return;
  if (typeof payload === 'string') {
    if (looksLikeTokenValue(payload)) {
      const err = new Error(`token value leaked: ${path || '(root)'}`);
      err.code = 'TOKEN_VALUE';
      throw err;
    }
    return;
  }
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertNoTokenValues(item, `${path}[${i}]`));
    return;
  }
  if (typeof payload !== 'object') return;
  for (const [key, val] of Object.entries(payload)) {
    assertNoTokenValues(val, path ? `${path}.${key}` : key);
  }
}

module.exports = {
  SECRET_FIELDS,
  SECRET_FIELD_RE,
  looksSecretField,
  looksLikeTokenValue,
  stripSecrets,
  toPublicClient,
  webhookUrls,
  assertNoSecretFields,
  assertNoTokenValues,
};
