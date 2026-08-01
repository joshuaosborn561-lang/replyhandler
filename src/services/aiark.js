/**
 * AI Ark (ai-ark.com) enrichment — X-TOKEN header.
 * Reverse lookup (email → LinkedIn/profile) + mobile phone finder.
 */

const BASE = 'https://api.ai-ark.com/api/developer-portal';
const { fetchWithTimeout } = require('../utils/fetch-with-timeout');

function apiKey() {
  return String(process.env.AIARK_API_KEY || process.env.AI_ARK_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(apiKey());
}

function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^(n\/?a|none|null|unknown|-)$/i.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return s;
}

async function postJson(path, body) {
  const key = apiKey();
  if (!key) throw new Error('AIARK_API_KEY not configured');
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TOKEN': key,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Reverse lookup by email → LinkedIn URL + website/company hints.
 */
async function reverseLookupByEmail(email) {
  const workEmail = String(email || '').trim().toLowerCase();
  if (!workEmail || !isConfigured()) {
    return { linkedinUrl: null, website: null, phone: null, skipped: !workEmail ? 'no_email' : 'not_configured' };
  }

  const { ok, status, data } = await postJson('/v1/people/reverse-lookup', { search: workEmail });
  if (!ok || !data) {
    return { linkedinUrl: null, website: null, phone: null, skipped: `http_${status}` };
  }

  // Response may be a person object or wrapped
  const person = data.profile || data.data || data;
  const link = data.link || person.link || {};
  const linkedinUrl = link.linkedin || data.linkedin || person.linkedin || null;

  let website = null;
  const experiences = data.experiences || person.experiences || [];
  if (Array.isArray(experiences) && experiences[0]) {
    const company = experiences[0].company || experiences[0].account || {};
    website = company.website || company.domain || company.url || null;
  }
  if (!website && data.company) {
    website = data.company.website || data.company.domain || null;
  }

  return {
    linkedinUrl: linkedinUrl ? String(linkedinUrl) : null,
    website: website ? String(website) : null,
    phone: null,
    rawName: (data.profile && data.profile.full_name) || person.full_name || null,
  };
}

/**
 * Find mobile via LinkedIn URL and/or name+domain.
 */
async function findMobile({ linkedinUrl, name, domain } = {}) {
  if (!isConfigured()) return { phone: null, skipped: 'not_configured' };

  const body = {};
  if (linkedinUrl) body.linkedin = String(linkedinUrl).trim();
  if (!body.linkedin && name && domain) {
    body.name = String(name).trim();
    body.domain = String(domain).replace(/^https?:\/\//, '').split('/')[0].trim();
  }
  if (!body.linkedin && !(body.name && body.domain)) {
    return { phone: null, skipped: 'no_identifier' };
  }

  const { ok, status, data } = await postJson('/v2/people/mobile-phone-finder', body);
  if (!ok) {
    return { phone: null, skipped: `http_${status}` };
  }

  // V2 envelope: { status, error, data: { linkedin, data: [["+1..."]] } }
  const payload = data?.data != null ? data.data : data;
  if (!payload) return { phone: null, skipped: 'not_found' };

  let phone = null;
  const nested = payload.data || payload.phones || payload.phone || payload.mobile;
  if (Array.isArray(nested)) {
    // [["+1..."], ...] or ["+1..."]
    const flat = nested.flat(Infinity).map(String);
    phone = normalizePhone(flat.find((p) => normalizePhone(p)));
  } else {
    phone = normalizePhone(nested) || normalizePhone(payload.mobile_number);
  }

  const li = payload.linkedin || linkedinUrl || null;
  return { phone, linkedinUrl: li ? String(li) : null };
}

module.exports = {
  isConfigured,
  reverseLookupByEmail,
  findMobile,
  normalizePhone,
};
