/**
 * Campaign-mapped inbound forward rules.
 *
 * Config lives in inbound_forward_rules (campaign id and/or name LIKE
 * pattern → to_emails). This file is matching + denylist only — no
 * per-caller branches.
 */

const { parseEmailList } = require('../services/client-cc');

/** Addresses that must never receive an inbound forward. */
const BLOCKED_INBOUND_FORWARD_EMAILS = new Set([
  'crecimiento@rocketbox.mx',
]);

function likeMatch(value, pattern) {
  if (!pattern) return false;
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(String(value || ''));
}

function matchInboundForwardRules(rules, { campaignId, campaignName } = {}) {
  const id = campaignId != null ? String(campaignId).trim() : '';
  const name = campaignName != null ? String(campaignName).trim() : '';
  const matched = [];
  for (const rule of rules || []) {
    if (!rule || rule.active === false) continue;
    const ruleId = rule.campaign_id != null ? String(rule.campaign_id).trim() : '';
    const idHit = Boolean(ruleId && id && ruleId === id);
    const nameHit = Boolean(
      rule.campaign_name_pattern && name && likeMatch(name, rule.campaign_name_pattern)
    );
    if (idHit || nameHit) matched.push(rule);
  }
  return matched;
}

function collectForwardEmails(rules) {
  const seen = new Set();
  const emails = [];
  const blocked = [];
  for (const rule of rules || []) {
    for (const email of parseEmailList(rule?.to_emails || rule?.to_email)) {
      if (BLOCKED_INBOUND_FORWARD_EMAILS.has(email)) {
        if (!blocked.includes(email)) blocked.push(email);
        continue;
      }
      if (seen.has(email)) continue;
      seen.add(email);
      emails.push(email);
    }
  }
  return { emails, blocked };
}

function inboundForwardLeadKey({ leadId, leadEmail } = {}) {
  const id = leadId != null ? String(leadId).trim() : '';
  if (id) return `id:${id}`;
  const email = String(leadEmail || '').trim().toLowerCase();
  if (email.includes('@')) return `email:${email}`;
  return 'unknown';
}

module.exports = {
  BLOCKED_INBOUND_FORWARD_EMAILS,
  likeMatch,
  matchInboundForwardRules,
  collectForwardEmails,
  inboundForwardLeadKey,
};
