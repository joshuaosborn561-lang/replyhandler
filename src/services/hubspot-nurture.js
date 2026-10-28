'use strict';

/**
 * Minimal HubSpot client for the Day-30 nurture system.
 *
 * Reads a contact by email and writes four contact properties. Property
 * definitions are created by scripts/hubspot-nurture-properties.js, never here.
 * `fetchImpl` is injectable so tests never touch the network. The token is read
 * from HUBSPOT_ACCESS_TOKEN and never logged.
 */

const textUtil = require('../utils/nurture-day30-text');

const API = 'https://api.hubapi.com';

function tokenFrom(env) {
  return String((env || {}).HUBSPOT_ACCESS_TOKEN || '').trim();
}

async function hsRequest(method, path, body, { env = process.env, fetchImpl = fetch } = {}) {
  const token = tokenFrom(env);
  if (!token) {
    const err = new Error('HUBSPOT_ACCESS_TOKEN is not set');
    err.code = 'no_token';
    throw err;
  }
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new Error(`HubSpot ${method} ${path.split('?')[0]} failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/** First contact with this email, or null. Returns id plus the phone fields HubSpot holds. */
async function findContactByEmail(email, opts = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const data = await hsRequest('POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: e }] }],
    properties: ['email', 'firstname', 'lastname', 'company', 'phone', 'mobilephone'],
    limit: 1,
  }, opts);
  const hit = data && Array.isArray(data.results) ? data.results[0] : null;
  if (!hit) return null;
  const p = hit.properties || {};
  return {
    id: String(hit.id),
    company: p.company || null,
    phone: p.mobilephone || p.phone || null,
  };
}

/** Write the four nurture properties on a contact. */
async function updateNurtureProperties(contactId, lead, opts = {}) {
  if (!contactId) throw new Error('contactId required');
  const properties = textUtil.hubspotPropsFor(lead);
  await hsRequest('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { properties }, opts);
  return properties;
}

/** Definitions used by the property-creation script. Pure. */
function propertyDefinitions() {
  return textUtil.HUBSPOT_PROPERTIES.map((p) => ({ ...p }));
}

/** Create one property definition. Treats "already exists" (409) as success. */
async function createPropertyDefinition(def, opts = {}) {
  try {
    await hsRequest('POST', '/crm/v3/properties/contacts', def, opts);
    return 'created';
  } catch (err) {
    if (err.status === 409) return 'exists';
    throw err;
  }
}

module.exports = {
  findContactByEmail,
  updateNurtureProperties,
  propertyDefinitions,
  createPropertyDefinition,
  hsRequest,
};
