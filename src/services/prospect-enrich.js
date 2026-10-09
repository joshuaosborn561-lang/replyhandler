/**
 * Prospect enrichment — call joshuaosborn561-lang/email-waterfall.
 *
 * Do not walk vendors here. ReplyHandler posts Slack cards; the HTTP
 * service owns GetLeads → Smartlead → AI Ark → Prospeo → FullEnrich.
 * LeadMagic is gone (legacy max_tier aliases map to aiark).
 *
 * Slack cards need the compact hit back immediately, so this POSTs
 * /enrich-one (same as the enrich_person MCP tool). enrich_waterfall
 * returns counts only and cannot feed a card.
 *
 * Pass need, approve_cost_usd, and verify_phone. Never log lead rows.
 */

const {
  TIER_ORDER,
  normalizeMaxTier,
  allowsTier,
} = require('./reply-enrich-policy');

const CONSUMER_DOMAINS = /gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com/i;

const ENRICH_TIMEOUT_MS = 120_000;

function domainFromEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return null;
  return e.slice(at + 1) || null;
}

function asWebsite(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.includes('.') && !s.includes(' ')) return `https://${s}`;
  return null;
}

function splitLeadName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function waterfallBaseUrl() {
  return String(process.env.EMAIL_WATERFALL_URL || '').trim().replace(/\/+$/, '');
}

function clientTagFor(raw) {
  const tag = String(raw || process.env.EMAIL_WATERFALL_CLIENT_TAG || 'replyhandler')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return tag || 'replyhandler';
}

function websiteFrom(domainHint, hitWebsite) {
  const fromHit = asWebsite(hitWebsite);
  if (fromHit) return fromHit;
  if (domainHint && !CONSUMER_DOMAINS.test(domainHint)) return `https://${domainHint}`;
  return null;
}

function emptyResult({
  email, linkedinUrl, maxTier, reason, need,
} = {}) {
  const workEmail = String(email || '').trim().toLowerCase() || null;
  const domainHint = domainFromEmail(workEmail);
  const website = websiteFrom(domainHint, null);
  return {
    email: workEmail,
    phone: null,
    linkedinUrl: String(linkedinUrl || '').trim() || null,
    website,
    domain: domainHint,
    sources: {
      email: workEmail ? 'reply' : null,
      website: website ? 'email_domain' : null,
    },
    maxTier: normalizeMaxTier(maxTier),
    need: need || null,
    reason: reason || null,
    spentUsd: 0,
    estimateUsd: 0,
    phoneValid: null,
    phoneType: null,
    deprecatedMaxTier: null,
    stoppedAtCeiling: false,
  };
}

function fromHit(hit, input) {
  const workEmail = String(hit?.email || input.email || '').trim().toLowerCase() || null;
  const domainHint = domainFromEmail(workEmail) || String(hit?.domain || input.domain || '').trim() || null;
  const phone = String(hit?.phone || '').trim() || null;
  const linkedinUrl = String(hit?.linkedin_url || input.linkedinUrl || '').trim() || null;
  const website = websiteFrom(domainHint, hit?.website);
  const spentUsd = Number(hit?.spent_usd ?? hit?.cost_usd ?? 0) || 0;
  const estimateUsd = Number(hit?.estimate_usd ?? hit?.quoted_usd ?? 0) || 0;
  const sources = {
    email: hit?.sources?.email || hit?.email_tier || (workEmail ? 'reply' : null),
    phone: hit?.sources?.phone || hit?.phone_tier || null,
    linkedin: hit?.sources?.linkedin || hit?.dm_tier || null,
    website: website && !hit?.website ? 'email_domain' : (hit?.website ? (hit?.sources?.linkedin || 'waterfall') : null),
  };
  return {
    email: workEmail,
    phone,
    linkedinUrl,
    website,
    domain: domainHint,
    sources,
    maxTier: normalizeMaxTier(hit?.max_tier || input.maxTier),
    need: hit?.need || input.need || null,
    reason: hit?.ok === false ? (hit?.reason || 'enrich_one_failed') : (hit?.reason || null),
    spentUsd,
    estimateUsd,
    phoneValid: hit?.phone_valid ?? hit?.veriphone_valid ?? null,
    phoneType: hit?.phone_type || hit?.line_type || null,
    deprecatedMaxTier: hit?.deprecated_max_tier || null,
    stoppedAtCeiling: Boolean(hit?.stopped_at_ceiling),
    rawHit: hit && typeof hit === 'object' ? hit : null,
  };
}

/**
 * @param {{
 *   email?: string|null,
 *   phone?: string|null,
 *   linkedinUrl?: string|null,
 *   leadName?: string|null,
 *   companyName?: string|null,
 *   domain?: string|null,
 *   maxTier?: string,
 *   clientTag?: string|null,
 *   need?: 'email'|'phone'|'both',
 *   approveCostUsd?: number|null,
 *   verifyPhone?: boolean,
 *   estimateOnly?: boolean,
 * }} input
 */
async function enrichProspect({
  email,
  phone,
  linkedinUrl,
  leadName,
  companyName,
  domain,
  maxTier,
  clientTag,
  need = 'email',
  approveCostUsd = null,
  verifyPhone = false,
  estimateOnly = false,
} = {}) {
  const cap = normalizeMaxTier(maxTier);
  const base = waterfallBaseUrl();
  if (!base) {
    console.warn('[ProspectEnrich] EMAIL_WATERFALL_URL unset — not walking vendors here');
    return emptyResult({ email, linkedinUrl, maxTier: cap, reason: 'waterfall_url_unset', need });
  }

  const workEmail = String(email || '').trim().toLowerCase();
  const { firstName, lastName } = splitLeadName(leadName);
  const domainHint = String(domain || '').trim() || domainFromEmail(workEmail) || '';
  const body = {
    client_tag: clientTagFor(clientTag),
    email: workEmail,
    first_name: firstName,
    last_name: lastName,
    full_name: String(leadName || '').trim(),
    linkedin_url: String(linkedinUrl || '').trim(),
    company_name: String(companyName || '').trim(),
    domain: domainHint,
    phone: String(phone || '').trim(),
    need,
    max_tier: cap,
    write_supabase: false,
    verify_phone: Boolean(verifyPhone) || need === 'phone',
  };
  if (approveCostUsd != null && Number.isFinite(Number(approveCostUsd))) {
    body.approve_cost_usd = Number(approveCostUsd);
  }
  if (estimateOnly) body.estimate_only = true;

  const res = await fetch(`${base}/enrich-one`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
  });
  const text = await res.text();
  let hit = null;
  try {
    hit = text ? JSON.parse(text) : null;
  } catch {
    hit = null;
  }
  if (!res.ok) {
    throw new Error(`email-waterfall ${res.status}: ${String(text || '').slice(0, 300)}`);
  }
  if (!hit || typeof hit !== 'object') {
    throw new Error('email-waterfall returned a non-JSON enrich-one body');
  }
  return fromHit(hit, {
    email: workEmail, linkedinUrl, maxTier: cap, need, domain: domainHint,
  });
}

/** @deprecated use enrichProspect — kept for older callers */
async function enrichCellPhone(input) {
  const r = await enrichProspect({ ...input, need: 'phone', verifyPhone: true });
  return { phone: r.phone, provider: r.sources.phone || null, linkedinUrl: r.linkedinUrl };
}

module.exports = {
  enrichProspect,
  enrichCellPhone,
  domainFromEmail,
  asWebsite,
  normalizeMaxTier,
  allowsTier,
  clientTagFor,
  waterfallBaseUrl,
  TIER_ORDER,
  splitLeadName,
};
