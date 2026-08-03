const { fetchWithTimeout } = require('../utils/fetch-with-timeout');

function apiKey() {
  return String(process.env.LEADMAGIC_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(apiKey());
}

function isMobileFinderConfigured() {
  return isConfigured();
}

function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^(n\/?a|none|null|unknown|-)$/i.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return s;
}

async function profileToEmail(linkedinUrl) {
  if (!apiKey()) throw new Error('LEADMAGIC_API_KEY not configured');
  const res = await fetchWithTimeout('https://api.leadmagic.io/v1/people/profile-to-email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey(),
    },
    body: JSON.stringify({ linkedin_url: linkedinUrl }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LeadMagic profileToEmail failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.email || null;
}

/**
 * Find mobile via LeadMagic mobile-finder.
 * @see https://leadmagic.io/docs/v1/reference/mobile-finder
 */
async function findMobile({ workEmail, personalEmail, profileUrl } = {}) {
  if (!apiKey()) {
    return { phone: null, skipped: 'not_configured' };
  }
  const body = {};
  if (profileUrl) body.profile_url = String(profileUrl).trim();
  if (workEmail) body.work_email = String(workEmail).trim().toLowerCase();
  if (personalEmail) body.personal_email = String(personalEmail).trim().toLowerCase();
  if (!body.profile_url && !body.work_email && !body.personal_email) {
    return { phone: null, skipped: 'no_identifier' };
  }

  const res = await fetchWithTimeout('https://api.leadmagic.io/v1/people/mobile-finder', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey(),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!res.ok) {
    throw new Error(`LeadMagic mobile-finder failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const phone = normalizePhone(data.mobile_number || data.phone || data.mobile);
  return { phone, message: data.message || null, creditsConsumed: data.credits_consumed };
}

module.exports = {
  profileToEmail,
  findMobile,
  isConfigured,
  isMobileFinderConfigured,
};
