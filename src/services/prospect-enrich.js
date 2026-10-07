/**
 * Prospect enrichment — call joshuaosborn561-lang/email-waterfall.
 *
 * Do not walk vendors here. ReplyHandler posts Slack cards; the MCP/HTTP
 * service owns GetLeads → Smartlead → AI Ark → LeadMagic → Prospeo →
 * FullEnrich. FullEnrich is last-tier email AND cellphone.
 *
 * Slack cards need the compact hit back immediately, so this POSTs
 * /enrich-one (same as the enrich_person MCP tool). enrich_waterfall
 * returns counts only and cannot feed a card.
 */

const TIER_ORDER = ['getleads', 'smartlead', 'aiark', 'leadmagic', 'prospeo', 'fullenrich'];

const CONSUMER_DOMAINS = /gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com/i;

const ENRICH_TIMEOUT_MS = 120_000;

function normalizeMaxTier(raw) {
  const s = String(raw || process.env.EMAIL_WATERFALL_MAX_TIER || 'fullenrich')
    .trim()
    .toLowerCase();
  if (s === 'lm') return 'leadmagic';
  if (s === 'fe') return 'fullenrich';
  return TIER_ORDER.includes(s) ? s : 'fullenrich';
}

function allowsTier(maxTier, tier) {
  return TIER_ORDER.indexOf(tier) <= TIER_ORDER.indexOf(normalizeMaxTier(maxTier));
}

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
  email, linkedinUrl, maxTier, reason,
} = {}) {
  const workEmail = String(email || '').trim().toLowerCase() || null;
  const domainHint = domainFromEmail(workEmail);
  const website = websiteFrom(domainHint, null);
  return {
    email: workEmail,
    phone: null,
    linkedinUrl: String(linkedinUrl || '').trim() || null,
    website,
    sources: {
      email: workEmail ? 'reply' : null,
      website: website ? 'email_domain' : null,
    },
    maxTier: normalizeMaxTier(maxTier),
    reason: reason || null,
  };
}

function fromHit(hit, input) {
  const workEmail = String(hit?.email || input.email || '').trim().toLowerCase() || null;
  const domainHint = domainFromEmail(workEmail) || String(hit?.domain || '').trim() || null;
  const phone = String(hit?.phone || '').trim() || null;
  const linkedinUrl = String(hit?.linkedin_url || input.linkedinUrl || '').trim() || null;
  const website = websiteFrom(domainHint, hit?.website);
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
    sources,
    maxTier: normalizeMaxTier(hit?.max_tier || input.maxTier),
    reason: hit?.ok === false ? (hit?.reason || 'enrich_one_failed') : null,
  };
}

/**
 * @param {{
 *   email?: string|null,
 *   linkedinUrl?: string|null,
 *   leadName?: string|null,
 *   companyName?: string|null,
 *   maxTier?: string,
 *   clientTag?: string|null,
 * }} input
 */
async function enrichProspect({
  email, linkedinUrl, leadName, companyName, maxTier, clientTag,
} = {}) {
  const cap = normalizeMaxTier(maxTier);
  const base = waterfallBaseUrl();
  if (!base) {
    console.warn('[ProspectEnrich] EMAIL_WATERFALL_URL unset — not walking vendors here');
    return emptyResult({ email, linkedinUrl, maxTier: cap, reason: 'waterfall_url_unset' });
  }

  const workEmail = String(email || '').trim().toLowerCase();
  const { firstName, lastName } = splitLeadName(leadName);
  const body = {
    client_tag: clientTagFor(clientTag),
    email: workEmail,
    first_name: firstName,
    last_name: lastName,
    full_name: String(leadName || '').trim(),
    linkedin_url: String(linkedinUrl || '').trim(),
    company_name: String(companyName || '').trim(),
    domain: domainFromEmail(workEmail) || '',
    need: 'both',
    max_tier: cap,
    write_supabase: false,
  };

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
  return fromHit(hit, { email: workEmail, linkedinUrl, maxTier: cap });
}

/** @deprecated use enrichProspect — kept for older callers */
async function enrichCellPhone(input) {
  const r = await enrichProspect(input);
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
