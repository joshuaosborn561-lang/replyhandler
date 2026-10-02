/**
 * Mirror a ReplyHandler client to the client portal.
 * Failures never roll back onboarding here.
 */

const PORTAL_PATH = '/functions/v1/provision-client';
const TIMEOUT_MS = 10_000;
const RETRY_WAIT_MS = 5_000;

function normalizeContactEmail(value) {
  const s = String(value || '').trim().toLowerCase();
  return s.includes('@') ? s : null;
}

function portalConfigured() {
  return !!(
    String(process.env.PORTAL_URL || '').trim()
    && String(process.env.PORTAL_WEBHOOK_SECRET || '').trim()
  );
}

function provisionUrl() {
  const base = String(process.env.PORTAL_URL || '').trim().replace(/\/+$/, '');
  return `${base}${PORTAL_PATH}`;
}

/**
 * Invite emails go out when contact_email is present.
 * Set PORTAL_SKIP_INVITE=true only to suppress them again.
 */
function invitesDisabled() {
  const raw = String(process.env.PORTAL_SKIP_INVITE ?? 'false').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function buildProvisionPayload(client) {
  const contactEmail = normalizeContactEmail(client?.contact_email);
  return {
    handler_client_id: client.id,
    name: client.name || null,
    contact_email: contactEmail,
    skip_invite: !contactEmail || invitesDisabled(),
    smartlead_api_key: client.smartlead_api_key || null,
    heyreach_api_key: client.heyreach_api_key || null,
    allo_api_key: client.allo_api_key || null,
    booking_link: client.booking_link || null,
    active: client.active !== false,
  };
}

function extractLoginLink(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [
    body.login_link,
    body.loginLink,
    body.invite_link,
    body.inviteLink,
    body.invite_url,
    body.inviteUrl,
    body.url,
  ];
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (/^https?:\/\//i.test(s)) return s;
  }
  return null;
}

function extractWarning(body) {
  if (!body || typeof body !== 'object') return null;
  const raw = body.warning != null ? body.warning : body.warnings;
  if (Array.isArray(raw)) {
    const parts = raw.map((w) => String(w || '').trim()).filter(Boolean);
    return parts.length ? parts.join('; ') : null;
  }
  const s = String(raw || '').trim();
  return s || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      const err = new Error(`portal provision failed (${res.status})`);
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
 * POST this client to the portal. Never throws to the caller.
 * One retry after 5s. 10s timeout per attempt.
 */
async function provisionClientToPortal(client, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const sleepFn = deps.sleepFn || sleep;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const retryWaitMs = deps.retryWaitMs == null ? RETRY_WAIT_MS : deps.retryWaitMs;

  if (!portalConfigured()) {
    console.log('[Portal] Skip provision — PORTAL_URL or PORTAL_WEBHOOK_SECRET unset', {
      clientId: client?.id,
    });
    return { ok: false, skipped: true, reason: 'not_configured' };
  }

  const url = provisionUrl();
  const secret = String(process.env.PORTAL_WEBHOOK_SECRET).trim();
  const payload = buildProvisionPayload(client);

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const body = await postOnce(url, payload, secret, fetchFn, timeoutMs);
      const loginLink = extractLoginLink(body);
      const warning = extractWarning(body);
      console.log('[Portal] Provisioned client', {
        clientId: client.id,
        name: client.name,
        skipInvite: payload.skip_invite,
        hasLoginLink: !!loginLink,
        warning: warning || undefined,
        attempt,
      });
      return { ok: true, loginLink, warning, skipInvite: payload.skip_invite, body };
    } catch (err) {
      lastErr = err;
      console.warn('[Portal] Provision attempt failed', {
        clientId: client?.id,
        attempt,
        err: err.message,
      });
      if (attempt === 1) await sleepFn(retryWaitMs);
    }
  }

  console.error('[Portal] Provision failed after retry', {
    clientId: client?.id,
    err: lastErr?.message,
  });
  return { ok: false, skipped: false, error: lastErr?.message || 'provision_failed' };
}

async function provisionAllClients(clients, deps = {}) {
  const results = [];
  for (const client of clients || []) {
    const r = await provisionClientToPortal(client, deps);
    results.push({
      clientId: client.id,
      name: client.name,
      ok: !!r.ok,
      skipped: !!r.skipped,
      skipInvite: r.skipInvite,
      loginLink: r.loginLink || null,
      warning: r.warning || null,
      error: r.error || null,
    });
  }
  return results;
}

module.exports = {
  PORTAL_PATH,
  TIMEOUT_MS,
  RETRY_WAIT_MS,
  normalizeContactEmail,
  portalConfigured,
  buildProvisionPayload,
  extractLoginLink,
  extractWarning,
  invitesDisabled,
  provisionClientToPortal,
  provisionAllClients,
};
