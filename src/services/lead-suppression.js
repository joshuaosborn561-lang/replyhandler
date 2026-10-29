'use strict';

/**
 * One answer to "should this lead get any card or follow-up?" Josh, Oct 29 2026:
 * a lead DQ'd the day before still got a follow-up card and a Day 1 call card.
 * Every reply, follow-up and call card path asks here before it posts.
 *
 *   disqualified  the lead is in disqualified_prospects (Slack DQ button, admin DQ)
 *   disqualified  another reply row for the same lead is already status 'disqualified'
 *   smartlead_dnc SmartLead says the lead unsubscribed or is in "Do Not Contact"
 *
 * Fails open on a lookup error: a database or SmartLead hiccup must never swallow a
 * real reply. Never deletes anything.
 */

const db = require('../db');
const { isDisqualified } = require('./disqualified-prospects');

const DNC_TTL_MS = 10 * 60 * 1000;
const dncCache = new Map();

function envFlag(name, dflt = true, env = process.env) {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

async function siblingDisqualified(clientId, { leadId, leadEmail, platform } = {}, query = (s, p) => db.query(s, p)) {
  const email = leadEmail ? String(leadEmail).trim().toLowerCase() : '';
  const lid = leadId != null ? String(leadId) : '';
  if (!email && !lid) return false;
  const { rows } = await query(
    `SELECT 1 FROM pending_replies
      WHERE client_id = $1
        AND status = 'disqualified'
        AND (
          ($2::text <> '' AND lower(lead_email) = $2)
          OR ($3::text <> '' AND $4::text <> '' AND platform = $4 AND COALESCE(lead_id, '') = $3)
        )
      LIMIT 1`,
    [clientId, email, lid, platform || ''],
  );
  return rows.length > 0;
}

async function smartleadDnc(apiKey, email, { smartlead = require('./smartlead'), now = Date.now() } = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!apiKey || !e) return false;
  const hit = dncCache.get(e);
  if (hit && now - hit.at < DNC_TTL_MS) return hit.value;
  const found = await smartlead.lookupLeadByEmail(apiKey, e);
  let value = false;
  if (found && found.lead) {
    value = found.lead.is_unsubscribed === true;
    if (!value) {
      const cats = await smartlead.fetchLeadCategories(apiKey).catch(() => []);
      const dncIds = new Set(
        (Array.isArray(cats) ? cats : [])
          .filter((c) => c && /do[\s_-]*not[\s_-]*contact/i.test(String(c.name || '')))
          .map((c) => String(c.id)),
      );
      const data = Array.isArray(found.lead.lead_campaign_data) ? found.lead.lead_campaign_data : [];
      value = data.some((c) => c && c.lead_category_id != null && dncIds.has(String(c.lead_category_id)));
    }
  }
  dncCache.set(e, { at: now, value });
  return value;
}

/**
 * @param {{id:string, smartlead_api_key?:string}} client
 * @param {{platform?, campaignId?, leadId?, conversationId?, leadEmail?, linkedinUrl?}} keys
 * @returns {Promise<string|null>} reason, or null when the lead may get cards
 */
async function leadSuppressionReason(client, keys = {}, deps = {}) {
  const clientId = client && client.id;
  if (!clientId) return null;
  const dq = deps.isDisqualified || isDisqualified;
  try {
    if (await dq(clientId, keys)) return 'disqualified';
  } catch (err) {
    console.warn('[LeadSuppression] DQ lookup failed', { err: err.message });
  }
  try {
    if (await (deps.siblingDisqualified || siblingDisqualified)(clientId, keys)) return 'disqualified';
  } catch (err) {
    console.warn('[LeadSuppression] sibling DQ lookup failed', { err: err.message });
  }
  const platform = String(keys.platform || '').toLowerCase();
  if (platform === 'smartlead' && client.smartlead_api_key && keys.leadEmail
    && envFlag('LEAD_SUPPRESSION_SMARTLEAD_DNC', true, deps.env || process.env)) {
    try {
      if (await (deps.smartleadDnc || smartleadDnc)(client.smartlead_api_key, keys.leadEmail)) return 'smartlead_dnc';
    } catch (err) {
      console.warn('[LeadSuppression] SmartLead DNC lookup failed', { err: err.message });
    }
  }
  return null;
}

module.exports = { leadSuppressionReason, siblingDisqualified, smartleadDnc, _dncCache: dncCache };
