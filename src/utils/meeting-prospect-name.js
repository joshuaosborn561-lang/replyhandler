'use strict';

/**
 * The meeting email names the person who booked. A scheduler page often puts
 * the client contact (the page host, or the notify mailbox) in that name
 * field while the email and company are the prospect's. Drop only that
 * contact name. A name that matches the prospect's own email stays.
 */

const { notifyEmails } = require('../services/client-cc');
const { resolveAvailabilityBookingUrl } = require('./booking-bridge-destinations');

const ROLE_LOCALS = new Set([
  'info', 'office', 'admin', 'administrator', 'sales', 'team', 'hello', 'contact', 'support',
  'service', 'services', 'accounting', 'accounts', 'billing', 'ops', 'operations', 'marketing',
  'mail', 'email', 'inbox', 'leads', 'lead', 'reception', 'general', 'enquiries', 'inquiries',
  'help', 'jobs', 'careers', 'bookings', 'booking', 'orders', 'noreply', 'owner', 'manager',
  'dispatch', 'estimating', 'estimates', 'customerservice',
]);

const GENERIC_SLUGS = new Set([
  '30min', '15min', '45min', '60min', 'meeting', 'meetings', 'intro', 'intro-call', 'book',
  'booking', 'call', 'team', 'calendar', 'schedule', 'strategy', 'user', 'meetingtype',
]);

function tokens(value) {
  return String(value || '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 2);
}

function compact(value) {
  return tokens(value).join('');
}

function nameMatchesEmail(name, email) {
  const local = String(email || '').split('@')[0].split('+')[0].toLowerCase().replace(/[^a-z]/g, '');
  const nameTokens = tokens(name);
  const nameCompact = nameTokens.join('');
  if (!local || local.length < 5 || nameCompact.length < 5) return false;
  if (local === nameCompact || local.includes(nameCompact) || nameCompact.includes(local)) return true;
  if (nameTokens.length >= 2) {
    const first = nameTokens[0];
    const last = nameTokens[nameTokens.length - 1];
    if (local.includes(first) && local.includes(last)) return true;
  }
  return false;
}

/** True when this name is a client contact we already know, not the booker. */
function isClientSideName(name, identities) {
  const nameTokens = tokens(name);
  const nameCompact = nameTokens.join('');
  if (nameCompact.length < 5) return false;
  for (const id of identities || []) {
    const idTokens = tokens(id);
    const idCompact = idTokens.join('');
    if (idCompact.length < 5) continue;
    if (idCompact === nameCompact) return true;
    if (idTokens.length >= 2 && idTokens.every((t) => nameTokens.includes(t))) return true;
  }
  return false;
}

function shouldDropProspectName(name, email, identities) {
  if (!String(name || '').trim()) return false;
  if (nameMatchesEmail(name, email)) return false;
  return isClientSideName(name, identities);
}

function usable(name, email, identities) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return '';
  if (shouldDropProspectName(n, email, identities)) return '';
  return n;
}

/**
 * Keep `given` when it is the booker. Otherwise the first alternative that
 * is not the client contact (a CRM name, or the reply's stored name).
 */
function chooseProspectName({ given, email, alternatives, identities } = {}) {
  const keep = usable(given, email, identities);
  if (keep) return keep;
  for (const alt of alternatives || []) {
    const hit = usable(alt, email, identities);
    if (hit) return hit;
  }
  return '';
}

function identityFromNotify(email) {
  const local = String(email || '').split('@')[0].split('+')[0].toLowerCase();
  const first = local.split(/[._-]+/).find(Boolean) || '';
  const flat = local.replace(/[^a-z]/g, '');
  if (!flat || flat.length < 5) return '';
  if (ROLE_LOCALS.has(flat) || ROLE_LOCALS.has(first) || ROLE_LOCALS.has(local.replace(/[._-]+/g, ''))) return '';
  return local.replace(/[._-]+/g, ' ').trim();
}

function hostIdentityFromBookingUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '').trim()); } catch { return ''; }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  let slug = '';
  if (host === 'meetings.hubspot.com' || /^meetings-[a-z0-9]+\.hubspot\.com$/.test(host)) {
    slug = parts[0] || '';
  } else if (host === 'calendly.com') {
    slug = parts[0] || '';
  } else {
    slug = parts.find((p) => /^[a-z]{2,}[-_][a-z]{2,}$/i.test(p)) || '';
  }
  slug = slug.toLowerCase();
  if (!slug || GENERIC_SLUGS.has(slug) || /\d/.test(slug)) return '';
  if (compact(slug).length < 5) return '';
  return slug.replace(/[-_]+/g, ' ');
}

function identitiesFromSources({ emails, bookingUrls } = {}) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const id = String(raw || '').replace(/\s+/g, ' ').trim();
    const key = compact(id);
    if (key.length < 5 || seen.has(key)) return;
    seen.add(key);
    out.push(id);
  };
  for (const email of emails || []) add(identityFromNotify(email));
  for (const url of bookingUrls || []) add(hostIdentityFromBookingUrl(url));
  return out;
}

function bookingUrlForClient(row) {
  if (!row) return '';
  return resolveAvailabilityBookingUrl({
    name: row.client_name || row.name || '',
    booking_link: row.booking_link || '',
    booking_destination_url: row.booking_destination_url || '',
  });
}

function identitiesForClient(row) {
  if (!row) return [];
  return identitiesFromSources({
    emails: notifyEmails(row),
    bookingUrls: [bookingUrlForClient(row), row.booking_destination_url, row.booking_link],
  });
}

function identitiesForClients(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    for (const id of identitiesForClient(row)) {
      const key = compact(id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

/** Display name on a mailbox header, or '' when the header is only an address. */
function displayNameFromHeader(from) {
  const s = String(from || '').trim();
  const angled = s.match(/^(.*?)\s*<[^>]+>\s*$/);
  const display = (angled ? angled[1] : s).replace(/^["']|["']$/g, '').trim();
  if (!display || display.includes('@')) return '';
  return display.replace(/\s+/g, ' ');
}

/**
 * Name to print for a stored meeting. Prefers the reply's full name, then
 * the meeting name, and skips either when it is the client contact.
 */
function prospectDisplayName(row) {
  const src = row || {};
  const full = String(src.lead_full_name || '').trim();
  const stored = String(src.lead_name || '').trim();
  return chooseProspectName({
    given: full || stored,
    email: src.lead_email,
    alternatives: [full, stored],
    identities: identitiesForClient(src),
  });
}

module.exports = {
  nameMatchesEmail,
  isClientSideName,
  shouldDropProspectName,
  chooseProspectName,
  identityFromNotify,
  hostIdentityFromBookingUrl,
  identitiesFromSources,
  identitiesForClient,
  identitiesForClients,
  displayNameFromHeader,
  prospectDisplayName,
};
