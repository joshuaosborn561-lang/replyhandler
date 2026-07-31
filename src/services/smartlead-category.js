/**
 * SmartLead's own reply classification.
 *
 * SmartLead already categorises every reply in the master inbox. Running Gemini
 * over the same text produced a second, sometimes disagreeing opinion for no
 * benefit — so for email we use SmartLead's category and keep Gemini for
 * LinkedIn, which has no equivalent.
 *
 * Category names vary by account (they are user-editable in SmartLead), so
 * matching is on normalised substrings rather than exact strings, and anything
 * unrecognised falls through to notify-with-draft. Never guess your way into a
 * silent drop.
 */

const CATEGORY_FIELDS = [
  'lead_category', 'leadCategory',
  'lead_category_name', 'leadCategoryName',
  'category', 'categoryName', 'category_name',
  'reply_category', 'replyCategory',
  'sl_lead_category', 'slLeadCategory',
];

/** Pull the category string out of a webhook payload or master-inbox row. */
function extractCategory(source) {
  if (!source || typeof source !== 'object') return '';
  for (const field of CATEGORY_FIELDS) {
    const v = source[field];
    if (v == null) continue;
    // Some shapes nest it: { lead_category: { name: 'Interested' } }
    if (typeof v === 'object') {
      const nested = v.name || v.label || v.category || v.value;
      if (nested) return String(nested).trim();
      continue;
    }
    const s = String(v).trim();
    if (s) return s;
  }
  // One level down, for payloads that wrap the lead.
  for (const key of ['lead', 'leadData', 'data', 'stats']) {
    const nested = source[key];
    if (nested && typeof nested === 'object') {
      const found = extractCategory(nested);
      if (found) return found;
    }
  }
  return '';
}

function norm(s) {
  return String(s || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Map a SmartLead category onto our classification vocabulary.
 * @returns {string|null} classification, or null when the category is unknown
 */
function categoryToClassification(raw) {
  const c = norm(raw);
  if (!c) return null;

  if (c.includes('meeting') || c.includes('demo')) return 'MEETING_PROPOSED';
  if (c.includes('interested') && !c.includes('not interested')) return 'INTERESTED';
  if (c.includes('not interested')) return 'NOT_INTERESTED';
  if (c.includes('do not contact') || c.includes('unsubscribe') || c.includes('opt out')) return 'REMOVE_ME';
  if (c.includes('out of office') || c === 'ooo' || c.includes('vacation')) return 'OOO';
  if (c.includes('wrong person')) return 'WRONG_PERSON';
  if (c.includes('information request') || c.includes('question') || c.includes('more info')) return 'QUESTION';
  if (c.includes('objection')) return 'OBJECTION';
  if (c.includes('competitor')) return 'COMPETITOR';
  // "Team member", "Forwarded", anything bespoke: unknown to us.
  return null;
}

/**
 * Classification for a SmartLead reply from SmartLead's own category.
 *
 * @returns {{classification: string, source: string, raw: string}|null}
 *   null when no usable category is present, so the caller falls back to Gemini
 *   rather than assuming anything.
 */
function classifyFromSmartlead(...sources) {
  for (const source of sources) {
    const raw = extractCategory(source);
    if (!raw) continue;
    const classification = categoryToClassification(raw);
    if (classification) {
      return { classification, source: 'smartlead_category', raw };
    }
    // A category we do not recognise still means SmartLead saw a real reply.
    // Treat it as worth a look rather than dropping to a guess.
    return { classification: 'OTHER', source: 'smartlead_category_unmapped', raw };
  }
  return null;
}

module.exports = {
  extractCategory,
  categoryToClassification,
  classifyFromSmartlead,
};
