/**
 * Pull the lead's own phone number from the data the reply source already
 * hands us (Smartlead lead / custom fields, HeyReach profile). Free; no vendor.
 */

const PHONE_KEY_RE = /^(phone|phone_?number|mobile|mobile_?phone|cell|cell_?phone|direct_?phone|work_?phone|telephone|tel|company_?phone|personal_?phone)$/i;

function cleanPhone(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return s;
}

function phoneFromObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return '';
  for (const [k, v] of Object.entries(obj)) {
    if (PHONE_KEY_RE.test(String(k).replace(/[\s-]/g, '_')) && typeof v !== 'object') {
      const p = cleanPhone(v);
      if (p) return p;
    }
  }
  for (const k of ['custom_fields', 'customFields', 'custom_variables', 'lead', 'lead_data']) {
    const nested = obj[k];
    if (nested && typeof nested === 'object') {
      const p = phoneFromObject(nested, depth + 1);
      if (p) return p;
    }
  }
  return '';
}

/** First usable phone from any of the given source objects, else ''. */
function extractLeadPhone(...sources) {
  for (const s of sources) {
    const p = phoneFromObject(s);
    if (p) return p;
  }
  return '';
}

module.exports = { extractLeadPhone, cleanPhone };
