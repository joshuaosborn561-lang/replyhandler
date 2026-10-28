'use strict';

/**
 * Smartlead side of the Day-30 nurture: queue one approved email.
 *
 * A human approves a #nurture card, then the lead is imported into the nurture
 * campaign with the approved text in custom fields (nurture_subject,
 * nurture_body). The campaign's sequence must render those two fields; if it
 * does not (for example the old generic 7-step sequence) nothing is imported.
 *
 * Every function takes injectable dependencies so tests never hit the network.
 * The API key is passed in and never logged.
 */

const smartlead = require('./smartlead');

const BASE_URL = 'https://server.smartlead.ai/api/v1';
const SUBJECT_FIELD = 'nurture_subject';
const BODY_FIELD = 'nurture_body';
const ACTIVE_LEAD_STATUSES = new Set(['STARTED', 'INPROGRESS', 'IN_PROGRESS', 'ACTIVE']);

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text to the HTML Smartlead renders: escaped, line breaks kept. */
function bodyToHtml(body) {
  return escapeHtml(String(body || '').replace(/\r\n/g, '\n')).replace(/\n/g, '<br>');
}

/** True when the campaign sequence renders the approved subject and body fields. */
async function sequenceUsesNurtureFields(apiKey, campaignId, { getSequence = smartlead.getCampaignSequence } = {}) {
  const steps = await getSequence(apiKey, campaignId);
  if (!Array.isArray(steps) || !steps.length) return false;
  const bodyMarker = new RegExp(`\\{\\{\\s*${BODY_FIELD}\\s*\\}\\}`);
  const subjectMarker = new RegExp(`\\{\\{\\s*${SUBJECT_FIELD}\\s*\\}\\}`);
  // Every step must render the approved text, or a generic step would send unapproved copy.
  return steps.every((s) => bodyMarker.test(String(s.body || '')) && subjectMarker.test(String(s.subject || '')));
}

/**
 * Is it safe to queue this lead? Fails closed: any lookup error blocks.
 * Blocks when the lead is unsubscribed, already in the nurture campaign, or
 * still active in another campaign (never double-touch).
 */
async function checkLeadBeforeImport(apiKey, email, campaignId, { lookup = smartlead.lookupLeadByEmail } = {}) {
  let found;
  try {
    found = await lookup(apiKey, email);
  } catch (err) {
    return { ok: false, reason: 'lookup_failed', detail: err.message };
  }
  if (!found) return { ok: true, leadId: null };
  const lead = found.lead || {};
  if (lead.is_unsubscribed === true || String(lead.is_unsubscribed).toLowerCase() === 'true') {
    return { ok: false, reason: 'unsubscribed' };
  }
  const target = String(campaignId);
  const rows = Array.isArray(lead.lead_campaign_data) ? lead.lead_campaign_data : [];
  for (const r of rows) {
    const cid = String((r && (r.campaign_id || r.campaignId)) || '');
    if (!cid) continue;
    if (cid === target) return { ok: false, reason: 'already_in_campaign', leadId: found.leadId };
    const status = String((r && (r.status || r.lead_status)) || '').toUpperCase();
    if (ACTIVE_LEAD_STATUSES.has(status)) return { ok: false, reason: 'in_other_campaign' };
  }
  return { ok: true, leadId: found.leadId };
}

/** Import one lead with the approved subject and body. Never overrides blocklist or unsubscribes. */
async function importNurtureLead(apiKey, campaignId, lead, { fetchImpl = smartlead.fetchWith429Retry } = {}) {
  const cid = Number(campaignId);
  if (!Number.isInteger(cid) || cid <= 0) throw new Error('campaign id must be a positive integer');
  const [firstName, ...rest] = String(lead.name || '').trim().split(/\s+/);
  const payload = {
    lead_list: [{
      email: String(lead.email || '').trim().toLowerCase(),
      first_name: firstName || '',
      last_name: rest.join(' '),
      company_name: lead.company || '',
      custom_fields: {
        [SUBJECT_FIELD]: String(lead.subject || ''),
        [BODY_FIELD]: bodyToHtml(lead.body),
        nurture_touch_id: String(lead.touchId || ''),
        nurture_kind: String(lead.kind || 'day30'),
        hs_contact_id: String(lead.hubspotContactId || ''),
      },
    }],
    settings: {
      ignore_global_block_list: false,
      ignore_unsubscribe_list: false,
      ignore_duplicate_leads_in_other_campaign: false,
    },
  };
  const res = await fetchImpl(`${BASE_URL}/campaigns/${cid}/leads?api_key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new Error(`SmartLead import failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const uploaded = Number(data && data.upload_count) || 0;
  if (uploaded >= 1) return { ok: true, uploaded };
  if (Number(data && data.block_count) > 0) return { ok: false, reason: 'blocklisted' };
  if (Array.isArray(data && data.unsubscribed_leads) && data.unsubscribed_leads.length) {
    return { ok: false, reason: 'unsubscribed' };
  }
  if (Number(data && (data.duplicate_count || data.already_added_to_campaign)) > 0) {
    return { ok: false, reason: 'already_in_campaign' };
  }
  return { ok: false, reason: 'not_imported' };
}

module.exports = {
  SUBJECT_FIELD,
  BODY_FIELD,
  bodyToHtml,
  sequenceUsesNurtureFields,
  checkLeadBeforeImport,
  importNurtureLead,
};
