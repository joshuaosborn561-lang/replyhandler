'use strict';

/**
 * Addresses that belong to us, never to a client contact, a prospect, or a referral.
 *
 * Josh's inbox, Cayden's, the primary Gmail the app sends from, and anything on our own domains
 * (salesglidergrowth.com and friends) must never show up as "another person on the thread", in the
 * client CC list or checkbox label.
 *
 * Extra addresses / domains can be added with OWN_ADDRESSES and OWN_DOMAINS (comma separated),
 * e.g. Josh's personal Gmail. Sending-inbox exclusion is separate (it is per thread): pass those
 * addresses as `extra` to isOwnAddress / filterOwnAddresses.
 */

const DEFAULT_OWN_ADDRESSES = [
  'joshua@salesglidergrowth.com',
  'cayden@salesglidergrowth.com',
];
const DEFAULT_OWN_DOMAINS = ['salesglidergrowth.com', 'gosalesglider.com', 'salesglider.com'];

function bare(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const angle = s.match(/<([^>]+@[^>]+)>/);
  const candidate = (angle ? angle[1] : s).trim().toLowerCase().replace(/[<>\s"']/g, '');
  return candidate.includes('@') ? candidate : '';
}

function splitList(raw) {
  return String(Array.isArray(raw) ? raw.join(',') : raw || '')
    .split(/[\s,;]+/)
    .map(bare)
    .filter(Boolean);
}

/** Gmail ignores dots and +tags in the local part; compare on that canonical form. */
function canonicalKey(raw) {
  const e = bare(raw);
  if (!e) return '';
  const at = e.lastIndexOf('@');
  let local = e.slice(0, at).split('+')[0];
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

function domainOf(raw) {
  const e = bare(raw);
  const at = e.lastIndexOf('@');
  return at >= 0 ? e.slice(at + 1) : '';
}

function ownConfig(env = process.env) {
  const emails = new Set();
  const add = (v) => { for (const e of splitList(v)) emails.add(canonicalKey(e)); };
  add(DEFAULT_OWN_ADDRESSES);
  add(env.PRIMARY_GMAIL_FROM);
  add(env.FYI_REPLY_TO);
  add(env.BOOKED_MEETING_EMAIL_TO);
  add(env.BOOKED_MEETING_EMAIL_CC);
  add(env.FYI_CC_EMAILS);
  add(env.OWN_ADDRESSES);
  const domains = new Set(DEFAULT_OWN_DOMAINS);
  for (const d of String(env.OWN_DOMAINS || '').split(/[\s,;]+/)) {
    const s = d.trim().toLowerCase().replace(/^@/, '');
    if (s) domains.add(s);
  }
  return { emails, domains };
}

/**
 * True when `email` is ours: a known Josh/Cayden/primary-Gmail address, on one of our domains, or one
 * of the `extra` addresses (the sending inbox, the lead). `extraDomains` adds sending domains.
 */
function isOwnAddress(email, { extra = [], extraDomains = [], env = process.env } = {}) {
  const key = canonicalKey(email);
  if (!key) return false;
  const cfg = ownConfig(env);
  if (cfg.emails.has(key)) return true;
  const domain = domainOf(email);
  if (domain && cfg.domains.has(domain)) return true;
  for (const d of extraDomains || []) {
    if (String(d || '').trim().toLowerCase().replace(/^@/, '') === domain) return true;
  }
  const extras = splitList(extra).map(canonicalKey);
  return extras.includes(key);
}

/** Lowercased, deduped (case-insensitive) list with our own addresses removed. */
function filterOwnAddresses(list, opts = {}) {
  const seen = new Set();
  const out = [];
  for (const e of splitList(list)) {
    if (seen.has(e)) continue;
    seen.add(e);
    if (isOwnAddress(e, opts)) continue;
    out.push(e);
  }
  return out;
}

module.exports = { isOwnAddress, filterOwnAddresses, canonicalKey, ownConfig, DEFAULT_OWN_DOMAINS };
