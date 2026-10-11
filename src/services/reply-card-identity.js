/**
 * Cheap identity for Slack reply cards — LinkedIn + company website.
 *
 * Order: fields already on the reply/lead, then contact tables, then the
 * work-email domain (never gmail/outlook/…). Paid waterfall only if LinkedIn
 * is still missing, capped at $0.05. Never writes dl_status / sg_exclude / skip_*.
 */

const {
  domainFromEmail,
  asWebsite,
  websiteFrom,
  CONSUMER_DOMAINS,
  clientTagFor,
  enrichProspect,
} = require('./prospect-enrich');
const { lookupReplyIdentity } = require('./reply-contact-cache');
const { dropMaxTierToFit, estimateNeedUsd, canAfford } = require('./reply-enrich-policy');

const LINK_LOOKUP_CEILING_USD = Number(process.env.REPLY_LINK_LOOKUP_CEILING_USD || 0.05);

const LINKEDIN_KEYS = [
  'linkedin_url', 'linkedinUrl', 'linkedin', 'linked_in', 'linkedIn',
  'li_url', 'profile_url', 'profileUrl', 'linkedin_profile',
];
const WEBSITE_KEYS = [
  'website', 'lead_website', 'leadWebsite', 'company_website', 'companyWebsite',
  'company_url', 'companyUrl', 'website_url', 'websiteUrl', 'domain',
  'company_domain', 'companyDomain', 'org_website', 'website_org',
];

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const v = obj[key];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function customBag(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj.custom_fields || obj.customFields || obj.custom || obj.fields || null;
}

function pickLinkedin(...sources) {
  for (const src of sources) {
    const direct = firstString(src, LINKEDIN_KEYS);
    if (direct) return normalizeLinkedin(direct);
    const custom = firstString(customBag(src), LINKEDIN_KEYS);
    if (custom) return normalizeLinkedin(custom);
  }
  return null;
}

function pickWebsite(...sources) {
  for (const src of sources) {
    const direct = firstString(src, WEBSITE_KEYS);
    if (direct) {
      const site = asWebsite(direct);
      if (site && !isConsumerHost(site)) return site;
    }
    const custom = firstString(customBag(src), WEBSITE_KEYS);
    if (custom) {
      const site = asWebsite(custom);
      if (site && !isConsumerHost(site)) return site;
    }
  }
  return null;
}

function normalizeLinkedin(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) && /linkedin\.com\//i.test(s)) return s;
  if (/linkedin\.com\//i.test(s)) return `https://${s.replace(/^\/+/, '')}`;
  return null;
}

function hostOf(urlOrDomain) {
  const s = String(urlOrDomain || '').trim().replace(/^https?:\/\//i, '').split('/')[0];
  return s.toLowerCase();
}

function isConsumerHost(urlOrDomain) {
  return CONSUMER_DOMAINS.test(hostOf(urlOrDomain));
}

function websiteFromEmail(email) {
  return websiteFrom(domainFromEmail(email), null);
}

/**
 * Sync resolve from anything already on the card / lead / reply.
 * No network. Website from a company domain or a non-free-mail work email.
 */
function resolveLinksFromFields({
  card = {},
  reply = {},
  leadData = {},
  payload = {},
} = {}) {
  const linkedinUrl =
    pickLinkedin(card, reply, leadData, payload)
    || normalizeLinkedin(card.leadLinkedinUrl || card.linkedinUrl || reply.linkedin_url);
  const website =
    pickWebsite(card, reply, leadData, payload)
    || asWebsite(card.leadWebsite || card.website || reply.lead_website)
    || websiteFromEmail(card.leadEmail || card.email || reply.lead_email);
  return {
    linkedinUrl: linkedinUrl || null,
    website: website && !isConsumerHost(website) ? website : null,
    email: String(card.leadEmail || card.email || reply.lead_email || '').trim().toLowerCase() || null,
  };
}

async function resolveCardIdentity({
  card = {},
  reply = {},
  leadData = {},
  payload = {},
  db,
  clientTag,
  excludeReplyId,
  identityLookup = lookupReplyIdentity,
} = {}) {
  const fromFields = resolveLinksFromFields({ card, reply, leadData, payload });
  let linkedinUrl = fromFields.linkedinUrl;
  let website = fromFields.website;
  let email = fromFields.email;
  const sources = {
    linkedin: linkedinUrl ? 'lead' : null,
    website: website ? (pickWebsite(card, reply, leadData, payload) || asWebsite(card.leadWebsite || reply.lead_website) ? 'lead' : 'email_domain') : null,
  };

  if ((!linkedinUrl || !website) && db && (linkedinUrl || email)) {
    const cache = await identityLookup(db, {
      linkedinUrl: linkedinUrl || card?.linkedinUrl || reply?.linkedin_url || null,
      email,
      excludeReplyId,
      clientTag: clientTagFor(clientTag),
    });
    if (!email && cache.email) email = cache.email;
    if (!linkedinUrl && cache.linkedinUrl) {
      linkedinUrl = normalizeLinkedin(cache.linkedinUrl);
      sources.linkedin = cache.sources?.linkedin || 'cache';
    }
    if (!website && cache.website && !isConsumerHost(cache.website)) {
      website = asWebsite(cache.website);
      sources.website = cache.sources?.website || 'cache';
    }
    if (!website && cache.domain && !isConsumerHost(cache.domain)) {
      website = websiteFrom(cache.domain, null);
      sources.website = 'cache_domain';
    }
    if (!website && email) {
      website = websiteFromEmail(email);
      if (website) sources.website = 'email_domain';
    }
  }

  return { linkedinUrl: linkedinUrl || null, website: website || null, email, sources };
}

/**
 * Paid LinkedIn lookup when cheap sources missed. Estimate first; default
 * ceiling $0.05 covers getleads + AI Ark + Prospeo email-by-URL, not FullEnrich.
 */
async function lookupMissingLinkedin({
  email, leadName, companyName, domain, linkedinUrl, clientTag, ceilingUsd = LINK_LOOKUP_CEILING_USD,
} = {}) {
  const remaining = Number(ceilingUsd);
  if (!(remaining > 0)) return { linkedinUrl: null, website: null, skipped: 'ceiling' };
  const fitted = dropMaxTierToFit({ need: 'email', maxTier: 'prospeo', remainingUsd: remaining });
  if (!fitted) return { linkedinUrl: null, website: null, skipped: 'ceiling' };
  const estimateUsd = estimateNeedUsd('email', fitted);
  if (!canAfford({ spentUsd: 0, nextUsd: estimateUsd, ceilingUsd: remaining })) {
    return { linkedinUrl: null, website: null, skipped: 'ceiling', estimateUsd };
  }
  const hit = await enrichProspect({
    email,
    leadName,
    companyName,
    domain: domain || domainFromEmail(email),
    linkedinUrl,
    need: 'email',
    maxTier: fitted,
    approveCostUsd: remaining,
    clientTag,
  });
  return {
    linkedinUrl: normalizeLinkedin(hit.linkedinUrl),
    website: hit.website && !isConsumerHost(hit.website) ? asWebsite(hit.website) : null,
    email: hit.email || email || null,
    spentUsd: hit.spentUsd || 0,
    skipped: null,
  };
}

function linkLookupCeilingUsd() {
  const n = Number(process.env.REPLY_LINK_LOOKUP_CEILING_USD || LINK_LOOKUP_CEILING_USD);
  return Number.isFinite(n) && n > 0 ? n : 0.05;
}

module.exports = {
  LINK_LOOKUP_CEILING_USD,
  LINKEDIN_KEYS,
  WEBSITE_KEYS,
  pickLinkedin,
  pickWebsite,
  normalizeLinkedin,
  isConsumerHost,
  websiteFromEmail,
  resolveLinksFromFields,
  resolveCardIdentity,
  lookupMissingLinkedin,
  linkLookupCeilingUsd,
};
