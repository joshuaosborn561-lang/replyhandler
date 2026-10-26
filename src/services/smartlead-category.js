/**
 * SmartLead's own reply classification.
 *
 * SmartLead already categorises every reply in the master inbox. Running Gemini
 * over the same text produced a second, sometimes disagreeing opinion for no
 * benefit — so for email we use SmartLead's category and keep Gemini for
 * LinkedIn, which has no equivalent.
 *
 * Exception: mixed / conditional replies. SmartLead often stamps "Not
 * Interested" from the opening ("let's hold off for now") even when the rest
 * of the body is a question or interest. Those are classified from the full
 * body and must reach Slack as a conversation.
 *
 * Category names vary by account (they are user-editable in SmartLead), so
 * matching is on normalised substrings rather than exact strings, and anything
 * unrecognised falls through to notify-with-draft. Never guess your way into a
 * silent drop.
 */

const { looksLikeMixedIntent, promoteMixedIntent, SLACK_POSITIVES } = require('../utils/mixed-intent');
const { looksLikeAutomatedNotice } = require('../utils/smartlead-webhook-helpers');

const CATEGORY_FIELDS = [
  'lead_category', 'leadCategory',
  'lead_category_id', 'leadCategoryId',
  'lead_category_name', 'leadCategoryName',
  'category', 'category_id', 'categoryId', 'categoryName', 'category_name',
  'reply_category', 'replyCategory',
  'sl_lead_category', 'slLeadCategory',
];

/** Pull the category string out of a webhook payload or master-inbox row. */
function extractCategory(source) {
  if (!source || typeof source !== 'object') return '';
  for (const field of CATEGORY_FIELDS) {
    const v = source[field];
    if (v == null) continue;
    // Some shapes nest it: { lead_category: { name: 'Interested' } } or { id: 1 }
    if (typeof v === 'object') {
      // LEAD_CATEGORY_UPDATED sends { new_id, new_name, old_id, old_name }.
      if (v.new_name != null && String(v.new_name).trim()) return String(v.new_name).trim();
      if (v.new_id != null && String(v.new_id).trim() !== '') return String(v.new_id).trim();
      const nested = v.name || v.label || v.category || v.value || v.id;
      if (nested != null && nested !== '') return String(nested).trim();
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
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
 * SmartLead now sends the category as a number on EMAIL_REPLY webhooks.
 * Names remain supported because older payloads and the category list API
 * still use labels (and labels are account-editable).
 */
const NUMERIC_CATEGORY = {
  1: 'INTERESTED',
  2: 'MEETING_PROPOSED',
  3: 'NOT_INTERESTED',
  4: 'REMOVE_ME',
  5: 'QUESTION',
  6: 'OOO',
  7: 'WRONG_PERSON',
};

function numericCategoryId(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * Map a SmartLead category onto our classification vocabulary.
 * @returns {string|null} classification, or null when the category is unknown
 */
function categoryToClassification(raw) {
  const n = numericCategoryId(raw);
  if (n != null && NUMERIC_CATEGORY[n]) return NUMERIC_CATEGORY[n];

  const c = norm(raw);
  if (!c) return null;

  if (c.includes('meeting') || c.includes('demo')) return 'MEETING_PROPOSED';
  if (c.includes('interested') && !c.includes('not interested')) return 'INTERESTED';
  if (c.includes('not interested')) return 'NOT_INTERESTED';
  if (c.includes('do not contact') || c.includes('unsubscribe') || c.includes('opt out')) return 'REMOVE_ME';
  if (c.includes('out of office') || c === 'ooo' || c.includes('vacation')) return 'OOO';
  if (c.includes('wrong person')) return 'WRONG_PERSON';
  if (c.includes('information request') || c.includes('info request') || c.includes('question') || c.includes('more info')) return 'QUESTION';
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
    // Unknown SmartLead category: do not stamp OTHER. Caller uses our
    // classifier (Jev / Gemini) instead.
    continue;
  }
  return null;
}

/**
 * Combine SmartLead's inbox category with our full-body classification.
 * Mixed / conditional bodies always win over a SmartLead Not Interested
 * (or any other drop-worthy label). Clear declines still follow SmartLead.
 */
function applySmartleadCategory({
  slCategory,
  classification,
  inboundMessage,
  reasoning = '',
} = {}) {
  if (looksLikeAutomatedNotice(inboundMessage)) {
    return {
      classification: 'AUTOMATED_NOTICE',
      reasoning: `Automated notice; SmartLead category not applied. ${reasoning}`.trim(),
      source: 'automated_notice',
    };
  }

  const bodyClass = promoteMixedIntent(classification, inboundMessage);
  const mixed = looksLikeMixedIntent(inboundMessage);

  if (mixed) {
    const note = slCategory && slCategory.classification !== bodyClass
      ? `Body classified over SmartLead category "${slCategory.raw}" (mixed/conditional reply) → ${bodyClass}.`
      : `Mixed/conditional reply classified from full body → ${bodyClass}.`;
    return {
      classification: bodyClass,
      reasoning: `${note} ${reasoning}`.trim(),
      source: 'body_mixed_intent',
    };
  }

  const slClass = slCategory?.classification || null;
  if (slClass === 'NOT_INTERESTED' && SLACK_POSITIVES.has(String(bodyClass || '').toUpperCase())) {
    return {
      classification: bodyClass,
      reasoning: `SmartLead category "${slCategory.raw}" ignored; full body is ${bodyClass}. ${reasoning}`.trim(),
      source: 'body_over_smartlead',
    };
  }

  if (slCategory && slClass !== classification) {
    return {
      classification: slClass,
      reasoning: `SmartLead category "${slCategory.raw}" → ${slClass}. ${reasoning}`.trim(),
      source: slCategory.source || 'smartlead_category',
    };
  }

  return {
    classification: bodyClass || classification,
    reasoning,
    source: slCategory ? 'smartlead_agree' : 'gemini',
  };
}

/**
 * SmartLead category id whose name maps to our classification.
 * Default "Not Interested" is id 3, but names are account-editable — match
 * the mapped label, never a hardcoded id.
 */
function categoryIdForClassification(categories, classification) {
  const want = String(classification || '').toUpperCase();
  if (!want) return null;
  const list = Array.isArray(categories) ? categories : [];
  for (const cat of list) {
    if (!cat || cat.id == null) continue;
    const mapped = categoryToClassification(cat.name || cat.label || cat.category);
    if (mapped === want) return cat.id;
  }
  return null;
}

module.exports = {
  extractCategory,
  categoryToClassification,
  classifyFromSmartlead,
  applySmartleadCategory,
  categoryIdForClassification,
  NUMERIC_CATEGORY,
};
