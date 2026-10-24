/**
 * Reply enrichment policy — cost ceiling, vendor order, Veriphone gate.
 *
 * ReplyHandler never calls LeadMagic. Paid work goes through email-waterfall
 * /enrich-one with approve_cost_usd. These helpers are the local estimate
 * and gate so a webhook retry cannot walk past the ceiling.
 */

const TIER_ORDER = Object.freeze([
  'getleads',
  'smartlead',
  'aiark',
  'prospeo',
  'fullenrich',
]);

/** Legacy max_tier names: keep the old spend boundary (stop before Prospeo). */
const LEGACY_MAX_TIER = Object.freeze({
  leadmagic: 'aiark',
  lm: 'aiark',
  lead_magic: 'aiark',
});

const DEFAULT_CEILING_USD = 0.25;
const HOT_CEILING_USD = 1.0;
const HOT_CLASSIFICATIONS = Object.freeze(['INTERESTED', 'MEETING_PROPOSED']);

/** On-hit book prices (USD). Misses are $0. Used only to estimate before a paid call. */
const EMAIL_ON_HIT_USD = Object.freeze({
  getleads: 0,
  smartlead: 0,
  aiark: 0.0037,
  prospeo: 0.0148,
  fullenrich: 0.055,
});

const PHONE_ON_HIT_USD = Object.freeze({
  getleads: 0,
  smartlead: 0,
  aiark: 0.0183,
  prospeo: 0.148,
  fullenrich: 0.55,
});

const FORBIDDEN_WRITE_COLUMNS = Object.freeze(['dl_status', 'sg_exclude', 'skip_*']);

function normalizeMaxTier(raw) {
  const s = String(raw || process.env.EMAIL_WATERFALL_MAX_TIER || 'fullenrich')
    .trim()
    .toLowerCase();
  if (s === 'fe') return 'fullenrich';
  if (LEGACY_MAX_TIER[s]) return LEGACY_MAX_TIER[s];
  return TIER_ORDER.includes(s) ? s : 'fullenrich';
}

function allowsTier(maxTier, tier) {
  const cap = normalizeMaxTier(maxTier);
  const t = String(tier || '').trim().toLowerCase();
  if (LEGACY_MAX_TIER[t]) return false;
  return TIER_ORDER.indexOf(t) !== -1 && TIER_ORDER.indexOf(t) <= TIER_ORDER.indexOf(cap);
}

function isHotClassification(classification) {
  return HOT_CLASSIFICATIONS.includes(String(classification || '').toUpperCase());
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Default $0.25. INTERESTED / MEETING_PROPOSED use $1.00 so FullEnrich
 * mobile can run. Per-client columns and env vars override.
 */
function resolveReplyEnrichCeiling({ classification, client = {}, env = process.env } = {}) {
  const hot = isHotClassification(classification);
  const envKey = hot ? 'REPLY_ENRICH_CEILING_HOT_USD' : 'REPLY_ENRICH_CEILING_USD';
  const clientKey = hot ? 'reply_enrich_ceiling_hot_usd' : 'reply_enrich_ceiling_usd';
  const fallback = hot ? HOT_CEILING_USD : DEFAULT_CEILING_USD;
  const ceilingUsd =
    positiveNumber(client[clientKey]) ||
    positiveNumber(env[envKey]) ||
    fallback;
  return { ceilingUsd, hot };
}

function onHitPriceUsd(need, tier) {
  const prices = String(need) === 'phone' ? PHONE_ON_HIT_USD : EMAIL_ON_HIT_USD;
  return Number(prices[String(tier || '').toLowerCase()] || 0);
}

/** Worst-case on-hit walk up to maxTier. Free tiers are $0. */
function estimateNeedUsd(need, maxTier) {
  const cap = normalizeMaxTier(maxTier);
  let sum = 0;
  for (const tier of TIER_ORDER) {
    if (!allowsTier(cap, tier)) continue;
    if (String(need) === 'phone' && tier === 'smartlead') continue;
    sum += onHitPriceUsd(need, tier);
  }
  return Number(sum.toFixed(6));
}

function canAfford({ spentUsd = 0, nextUsd = 0, ceilingUsd } = {}) {
  return Number(spentUsd) + Number(nextUsd) <= Number(ceilingUsd) + 1e-9;
}

/**
 * Drop max_tier until the worst-case walk fits in remaining budget.
 * Returns null when even the free prefix does not (should not happen).
 */
function dropMaxTierToFit({ need, maxTier, remainingUsd } = {}) {
  let tier = normalizeMaxTier(maxTier);
  for (;;) {
    const estimate = estimateNeedUsd(need, tier);
    if (canAfford({ spentUsd: 0, nextUsd: estimate, ceilingUsd: remainingUsd })) {
      return tier;
    }
    const idx = TIER_ORDER.indexOf(tier);
    if (idx <= 0) return null;
    tier = TIER_ORDER[idx - 1];
  }
}

/**
 * FullEnrich mobile (~$0.55) only for INTERESTED / MEETING_PROPOSED
 * when the remaining ceiling can cover the on-hit price.
 */
function allowsFullEnrichMobile({ classification, remainingUsd } = {}) {
  return (
    isHotClassification(classification) &&
    canAfford({ spentUsd: 0, nextUsd: PHONE_ON_HIT_USD.fullenrich, ceilingUsd: remainingUsd })
  );
}

function resolvePhoneMaxTier({ classification, remainingUsd } = {}) {
  return allowsFullEnrichMobile({ classification, remainingUsd }) ? 'fullenrich' : 'prospeo';
}

function resolveEmailMaxTier({ remainingUsd, preferred = 'fullenrich' } = {}) {
  return dropMaxTierToFit({
    need: 'email',
    maxTier: preferred,
    remainingUsd,
  }) || 'getleads';
}

/**
 * Accept only a number Veriphone confirms valid + mobile.
 * Landline / VoIP / invalid stay on the alt slot and do not stop the waterfall.
 */
function gateMobilePhone(hit = {}) {
  const phone = String(hit.phone || '').trim() || null;
  if (!phone) return { mobile: null, alt: null, reason: 'no_phone' };

  const valid = hit.phone_valid;
  const type = String(hit.phone_type || hit.line_type || '').trim().toLowerCase();
  const isMobile = type === 'mobile';
  const isValid = valid === true || (valid === 'true');

  if (isValid && isMobile) {
    return { mobile: phone, alt: null, reason: null };
  }
  if (valid === false || valid === 'false') {
    return { mobile: null, alt: phone, reason: 'veriphone_invalid' };
  }
  if (type && type !== 'mobile') {
    return { mobile: null, alt: phone, reason: `not_mobile:${type}` };
  }
  return { mobile: null, alt: phone, reason: 'veriphone_unconfirmed' };
}

function remainingCeiling(ceilingUsd, spentUsd) {
  return Math.max(0, Number(ceilingUsd) - Number(spentUsd || 0));
}

function spentFromHit(hit) {
  const raw = hit?.spent_usd ?? hit?.cost_usd ?? hit?.spentUsd ?? hit?.costUsd ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = {
  TIER_ORDER,
  LEGACY_MAX_TIER,
  DEFAULT_CEILING_USD,
  HOT_CEILING_USD,
  HOT_CLASSIFICATIONS,
  EMAIL_ON_HIT_USD,
  PHONE_ON_HIT_USD,
  FORBIDDEN_WRITE_COLUMNS,
  normalizeMaxTier,
  allowsTier,
  isHotClassification,
  resolveReplyEnrichCeiling,
  onHitPriceUsd,
  estimateNeedUsd,
  canAfford,
  dropMaxTierToFit,
  allowsFullEnrichMobile,
  resolvePhoneMaxTier,
  resolveEmailMaxTier,
  gateMobilePhone,
  remainingCeiling,
  spentFromHit,
};
