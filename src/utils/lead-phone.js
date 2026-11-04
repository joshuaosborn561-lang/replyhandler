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

/** Prospect's own text. Quoted history and forwarded tails are not their number. */
function ownReplyText(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  const cuts = [
    /\bOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[\s\S]{0,240}?wrote:/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\nFrom:\s[^\n]+\nSent:\s/i,
  ];
  for (const re of cuts) {
    const at = t.search(re);
    if (at > 0) t = t.slice(0, at);
  }
  return t.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
}

function phoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

/**
 * A phone that literally appears in the prospect's own reply text.
 * Empty when the text has no number. Never builds a number that is not there.
 */
function phoneFromReplyText(text) {
  const own = ownReplyText(text);
  if (!own.trim()) return '';
  const labeled = own.match(/\b(?:tel|phone|mobile|cell|direct)\s*[:.]?\s*(\+?\d[\d\s().-]{8,}\d)/i);
  if (labeled) {
    const p = cleanPhone(labeled[1]);
    const n = phoneDigits(p);
    if (p && n.length >= 10 && n.length <= 15) return p;
  }
  const formatted = own.match(/(?:^|[^\d])(\+?1[\s.-]*)?(?:\(\d{3}\)[\s.-]*|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/);
  if (formatted) {
    const raw = formatted[0].replace(/^[^\d+]*/, '');
    const p = cleanPhone(raw);
    const n = phoneDigits(p);
    if (p && n.length >= 10 && n.length <= 15) return p;
  }
  const bare = own.match(/(?:^|[^\d])(\+?1)?(\d{10,11})(?!\d)/);
  if (bare) {
    const raw = `${bare[1] || ''}${bare[2]}`;
    const p = cleanPhone(raw);
    const n = phoneDigits(p);
    if (n.length >= 10 && n.length <= 11) return p;
  }
  return '';
}

module.exports = { extractLeadPhone, cleanPhone, phoneFromReplyText, ownReplyText };
