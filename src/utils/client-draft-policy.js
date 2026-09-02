/**
 * Client-specific rules that block drafting (DQ) without silencing Slack.
 *
 * Parlay Tech: exclude all .io and .ai reply email domains from drafting —
 * client request. Cards still post as alert-only with a clear reason.
 */

const { DRAFT_CLASSIFICATIONS } = require('../services/classifier');

/** Stable Parlay Tech client id (prod). Name match is the fallback. */
const PARLAY_CLIENT_IDS = new Set([
  '9760132c-1dd3-4e97-8f29-c5d4d01f5054',
]);

/** TLDs Parlay has DQ'd — no drafts. */
const PARLAY_DQ_TLDS = new Set(['io', 'ai']);

function isParlayClient(client) {
  if (!client) return false;
  if (client.id && PARLAY_CLIENT_IDS.has(String(client.id))) return true;
  return /\bparlay\b/i.test(String(client.name || ''));
}

/**
 * Public suffix-ish TLD of an email address (last label only).
 * "bob@foo.co.uk" → "uk"; "a@startup.io" → "io".
 */
function emailTld(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return null;
  const domain = e.slice(at + 1);
  if (!domain || domain.includes(' ') || !domain.includes('.')) return null;
  const parts = domain.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1] || null;
}

/**
 * @returns {string|null} human reason when drafting must be skipped, else null
 */
function draftSkipReason(client, leadEmail) {
  if (!isParlayClient(client)) return null;
  const tld = emailTld(leadEmail);
  if (tld && PARLAY_DQ_TLDS.has(tld)) {
    return `Parlay DQ: .${tld} domains excluded from drafting at client request`;
  }
  return null;
}

/**
 * Apply client draft policy after classification.
 * Clears the draft and forces alert_only when the lead is DQ'd.
 */
function applyClientDraftPolicy(client, leadEmail, {
  classification,
  draft = null,
  reasoning = '',
} = {}) {
  const reason = draftSkipReason(client, leadEmail);
  const classAllowsDraft = DRAFT_CLASSIFICATIONS.includes(classification);

  if (!reason) {
    return {
      isDraft: classAllowsDraft,
      draft: classAllowsDraft ? draft : null,
      status: classAllowsDraft ? 'pending' : 'alert_only',
      reasoning: reasoning || '',
      skippedDraft: false,
      skipReason: null,
    };
  }

  return {
    isDraft: false,
    draft: null,
    status: 'alert_only',
    reasoning: reasoning ? `${reason}. ${reasoning}` : reason,
    skippedDraft: true,
    skipReason: reason,
  };
}

module.exports = {
  isParlayClient,
  emailTld,
  draftSkipReason,
  applyClientDraftPolicy,
  PARLAY_CLIENT_IDS,
  PARLAY_DQ_TLDS,
};
