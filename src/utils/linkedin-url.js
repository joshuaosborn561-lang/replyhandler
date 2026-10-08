/**
 * Pull a prospect LinkedIn URL out of SmartLead / HeyReach / inbox shapes.
 * Lists often store it as `linkedin_profile`; webhooks bury it in custom_fields.
 */

const DIRECT_KEYS = [
  'linkedin_profile',
  'linkedin_profile_url',
  'linkedin_url',
  'linkedinUrl',
  'person_linkedin_url',
  'profileUrl',
  'profile_url',
  'linkedin',
];

function normalizeLinkedinUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    return /linkedin\.com\//i.test(s) ? s : '';
  }
  if (/linkedin\.com\//i.test(s)) return `https://${s.replace(/^\/+/, '')}`;
  return '';
}

function fromCustomFields(custom) {
  if (!custom) return '';
  if (Array.isArray(custom)) {
    for (const row of custom) {
      if (!row || typeof row !== 'object') continue;
      const name = String(row.name || row.key || row.field || '');
      if (!/linkedin/i.test(name)) continue;
      const url = normalizeLinkedinUrl(row.value || row.val || row.url);
      if (url) return url;
    }
    return '';
  }
  if (typeof custom === 'object') {
    for (const [key, val] of Object.entries(custom)) {
      if (!/linkedin/i.test(key)) continue;
      const url = normalizeLinkedinUrl(val);
      if (url) return url;
    }
  }
  return '';
}

function fromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of DIRECT_KEYS) {
    const url = normalizeLinkedinUrl(obj[key]);
    if (url) return url;
  }
  return fromCustomFields(
    obj.custom_fields || obj.customFields || obj.lead_custom_fields || obj.customField
  );
}

/**
 * First LinkedIn URL found across payload / lead_data / inbox row / fetched lead.
 * @returns {string|null}
 */
function extractLinkedinUrl(...sources) {
  for (const src of sources) {
    const url = fromObject(src);
    if (url) return url;
    if (src && typeof src === 'object') {
      const nested = fromObject(src.lead || src.lead_data || src.correspondentProfile);
      if (nested) return nested;
    }
  }
  return null;
}

module.exports = {
  normalizeLinkedinUrl,
  extractLinkedinUrl,
};
