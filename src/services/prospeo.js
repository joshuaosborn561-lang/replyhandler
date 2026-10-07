/**
 * Prospeo — email-waterfall tier after LeadMagic.
 * POST https://api.prospeo.io/enrich-person  Auth: X-KEY
 */

function apiKey() {
  return String(process.env.PROSPEO_API_KEY || '').trim();
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

function personPayload({ firstName, lastName, domain, companyName, linkedinUrl, fullName } = {}) {
  const data = {};
  if (linkedinUrl) data.linkedin_url = String(linkedinUrl).trim();
  if (firstName) data.first_name = String(firstName).trim();
  if (lastName) data.last_name = String(lastName).trim();
  const full = String(fullName || `${firstName || ''} ${lastName || ''}`).trim();
  if (full && !(firstName && lastName)) data.full_name = full;
  if (domain) data.company_website = String(domain).trim();
  if (companyName) data.company_name = String(companyName).trim();
  const hasLinkedin = Boolean(data.linkedin_url);
  const hasNameCompany = Boolean(
    ((data.first_name && data.last_name) || data.full_name)
    && (data.company_website || data.company_name)
  );
  return hasLinkedin || hasNameCompany ? data : null;
}

async function enrichPerson(data, { enrichMobile = false } = {}) {
  if (!apiKey()) return { phone: null, skipped: 'not_configured' };
  const payload = personPayload(data);
  if (!payload) return { phone: null, skipped: 'no_identifier' };

  const res = await fetch('https://api.prospeo.io/enrich-person', {
    method: 'POST',
    headers: {
      'X-KEY': apiKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      only_verified_email: !enrichMobile,
      enrich_mobile: Boolean(enrichMobile),
      data: payload,
    }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!res.ok || body.error === true) {
    throw new Error(`Prospeo enrich-person failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const person = body.person && typeof body.person === 'object' ? body.person : {};
  let mobile = person.mobile || person.phone || person.cellphone;
  if (mobile && typeof mobile === 'object') {
    mobile = mobile.mobile || mobile.phone || mobile.number || mobile.mobile_number || '';
  }
  const emailObj = person.email && typeof person.email === 'object' ? person.email : {};
  const email = String(emailObj.email || person.work_email || '').trim().toLowerCase();
  const linkedin = person.linkedin_url || person.linkedin || payload.linkedin_url || null;
  return {
    phone: normalizePhone(mobile),
    email: email.includes('@') && !email.includes('*') ? email : null,
    linkedinUrl: linkedin ? String(linkedin) : null,
  };
}

async function findMobile(input) {
  return enrichPerson(input, { enrichMobile: true });
}

module.exports = {
  isConfigured,
  findMobile,
  enrichPerson,
};
