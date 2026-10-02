/**
 * Push a just-classified positive inbound to the client portal.
 * Failures never block Slack or the webhook response.
 */

const { portalConfigured } = require('./portal-provision');

const PORTAL_PATH = '/functions/v1/new-positive-reply';
const TIMEOUT_MS = 10_000;
const RETRY_WAIT_MS = 5_000;
const SNIPPET_MAX = 500;

const POSITIVE_CLASSIFICATIONS = new Set([
  'INTERESTED',
  'MEETING_PROPOSED',
  'QUESTION',
]);

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
]);

function isPositivePortalClassification(classification) {
  return POSITIVE_CLASSIFICATIONS.has(String(classification || '').toUpperCase());
}

function channelFromPlatform(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'heyreach' || p === 'linkedin') return 'linkedin';
  if (p === 'call' || p === 'allo') return 'call';
  return 'email';
}

function snippetFromInbound(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= SNIPPET_MAX) return s;
  return `${s.slice(0, SNIPPET_MAX - 3)}...`;
}

function companyFromEmail(email) {
  const at = String(email || '').trim().toLowerCase().split('@')[1] || '';
  if (!at || GENERIC_EMAIL_DOMAINS.has(at)) return null;
  return at;
}

function extractCompany(...sources) {
  for (const src of sources) {
    if (typeof src === 'string' && src.trim()) return src.trim();
    if (!src || typeof src !== 'object') continue;
    const raw = src.company_name || src.company || src.companyName
      || src.organization || src.org || src.leadCompany;
    const s = String(raw || '').trim();
    if (s) return s;
  }
  return null;
}

function normalizeEmail(value) {
  const s = String(value || '').trim().toLowerCase();
  return s.includes('@') ? s : null;
}

function isoRepliedAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const s = String(value || '').trim();
  if (s) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function buildPositiveReplyPayload({
  clientId,
  platform,
  email,
  name,
  company,
  campaignId,
  leadId,
  snippet,
  repliedAt,
} = {}) {
  const normalizedEmail = normalizeEmail(email);
  return {
    handler_client_id: clientId || null,
    email: normalizedEmail,
    name: String(name || '').trim() || null,
    company: extractCompany(company) || companyFromEmail(normalizedEmail),
    campaign_id: campaignId != null && String(campaignId).trim() ? String(campaignId) : null,
    lead_id: leadId != null && String(leadId).trim() ? String(leadId) : null,
    snippet: snippetFromInbound(snippet),
    replied_at: isoRepliedAt(repliedAt),
    channel: channelFromPlatform(platform),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function provisionUrl() {
  const base = String(process.env.PORTAL_URL || '').trim().replace(/\/+$/, '');
  return `${base}${PORTAL_PATH}`;
}

async function postOnce(url, payload, secret, fetchFn, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-portal-secret': secret,
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`portal positive-reply failed (${res.status})`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST one positive inbound to the portal. Never throws.
 */
async function notifyPortalPositiveReply(input = {}, deps = {}) {
  const classification = input.classification;
  if (!isPositivePortalClassification(classification)) {
    return { ok: false, skipped: true, reason: 'not_positive' };
  }

  if (!portalConfigured()) {
    return { ok: false, skipped: true, reason: 'not_configured' };
  }

  const fetchFn = deps.fetchFn || fetch;
  const sleepFn = deps.sleepFn || sleep;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const retryWaitMs = deps.retryWaitMs == null ? RETRY_WAIT_MS : deps.retryWaitMs;
  const db = deps.db;

  let repliedAt = input.repliedAt;
  if (!repliedAt && input.replyId && db) {
    try {
      const { rows } = await db.query(
        'SELECT created_at FROM pending_replies WHERE id = $1',
        [input.replyId]
      );
      if (rows[0]?.created_at) repliedAt = rows[0].created_at;
    } catch (err) {
      console.warn('[Portal] Could not load created_at for positive-reply', {
        replyId: input.replyId,
        err: err.message,
      });
    }
  }

  const payload = buildPositiveReplyPayload({ ...input, repliedAt });
  const url = provisionUrl();
  const secret = String(process.env.PORTAL_WEBHOOK_SECRET).trim();

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await postOnce(url, payload, secret, fetchFn, timeoutMs);
      console.log('[Portal] Positive reply forwarded', {
        clientId: payload.handler_client_id,
        channel: payload.channel,
        email: payload.email,
        attempt,
      });
      return { ok: true, skipped: false, payload };
    } catch (err) {
      lastErr = err;
      console.warn('[Portal] Positive-reply attempt failed', {
        clientId: payload.handler_client_id,
        attempt,
        err: err.message,
      });
      if (attempt === 1) await sleepFn(retryWaitMs);
    }
  }

  console.error('[Portal] Positive-reply failed after retry', {
    clientId: payload.handler_client_id,
    err: lastErr?.message,
  });
  return { ok: false, skipped: false, error: lastErr?.message || 'positive_reply_failed', payload };
}

module.exports = {
  PORTAL_PATH,
  TIMEOUT_MS,
  RETRY_WAIT_MS,
  POSITIVE_CLASSIFICATIONS,
  isPositivePortalClassification,
  channelFromPlatform,
  snippetFromInbound,
  companyFromEmail,
  extractCompany,
  buildPositiveReplyPayload,
  notifyPortalPositiveReply,
};
