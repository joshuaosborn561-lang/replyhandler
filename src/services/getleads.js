/**
 * GetLeads (app.getleads.io) — contact lookup / enrichment.
 * Auth: Bearer GETLEADS_API_KEY (glb_live_…).
 */

const BASE = 'https://app.getleads.io';

function apiKey() {
  return String(process.env.GETLEADS_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(apiKey());
}

function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // Reject obvious placeholders
  if (/^(n\/?a|none|null|unknown|-)$/i.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return s;
}

async function postJson(path, body) {
  const key = apiKey();
  if (!key) throw new Error('GETLEADS_API_KEY not configured');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'X-API-Key': key,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`GetLeads ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return data;
}

/**
 * Look up a contact by work email and return cellphone when present.
 * @returns {{ phone: string|null, linkedinUrl: string|null, source: string, raw?: object }}
 */
async function findPhoneByEmail(email) {
  const workEmail = String(email || '').trim().toLowerCase();
  if (!workEmail || !workEmail.includes('@')) {
    return { phone: null, linkedinUrl: null, source: 'getleads', skipped: 'no_email' };
  }
  if (!isConfigured()) {
    return { phone: null, linkedinUrl: null, source: 'getleads', skipped: 'not_configured' };
  }

  const data = await postJson('/api/v1/contacts/search', {
    email_address: workEmail,
    limit: 1,
  });
  const contact = Array.isArray(data?.contacts) ? data.contacts[0] : null;
  if (!contact) {
    return { phone: null, linkedinUrl: null, source: 'getleads', skipped: 'not_found' };
  }

  const phone = normalizePhone(contact.cellphone) || normalizePhone(contact.direct_phone);
  const linkedinUrl = contact.person_linkedin_url || contact.linkedin_url || null;
  const website = contact.website_org || contact.org_website || contact.org_domain || null;
  return {
    phone,
    linkedinUrl: linkedinUrl ? String(linkedinUrl) : null,
    website: website ? String(website) : null,
    source: 'getleads',
    raw: { email_address: contact.email_address, job_title: contact.job_title },
  };
}

/**
 * Resolve LinkedIn URL from work email (enrich waterfall helper).
 */
async function linkedinFromEmail(email) {
  const workEmail = String(email || '').trim().toLowerCase();
  if (!workEmail || !isConfigured()) return null;
  try {
    const data = await postJson('/api/v1/enrich/from-email', {
      items: [{ email: workEmail }],
    });
    const row = Array.isArray(data?.results) ? data.results[0] : null;
    const url = row?.profileUrl || row?.data?.person_linkedin_url || null;
    return url ? String(url) : null;
  } catch (err) {
    console.warn('[GetLeads] linkedinFromEmail failed', { err: err.message });
    return null;
  }
}

module.exports = {
  isConfigured,
  findPhoneByEmail,
  linkedinFromEmail,
  normalizePhone,
};
