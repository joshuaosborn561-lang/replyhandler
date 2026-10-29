'use strict';

/**
 * A LinkedIn profile found by a search (waterfall decision-maker lookup, reverse
 * lookup) is only trusted when it is the LEAD's own profile. Josh, Oct 29 2026:
 * cards showed another person's LinkedIn (a decision maker at the same company).
 * Require the profile slug to carry the lead's first AND last name, or the work
 * email local part. Otherwise show no LinkedIn.
 */

function letters(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '');
}

function nameParts(leadName) {
  const toks = String(leadName || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 0);
  if (!toks.length) return { first: '', last: '' };
  return { first: toks[0], last: toks.length > 1 ? toks[toks.length - 1] : '' };
}

/** Slug of /in/<slug>, lowercased, with LinkedIn's trailing hash (e.g. -1a2b3c4) dropped. */
function slugOf(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return '';
  let slug;
  try { slug = decodeURIComponent(m[1]); } catch { slug = m[1]; }
  slug = slug.toLowerCase().replace(/-[0-9][0-9a-z]{4,}$/i, '');
  return letters(slug);
}

function emailLocal(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return letters(at > 0 ? e.slice(0, at) : '');
}

/**
 * @param {{ url: string, leadName?: string, email?: string }} i
 * @returns {boolean}
 */
function linkedinMatchesLead({ url, leadName, email } = {}) {
  const slug = slugOf(url);
  if (!slug) return false;
  const { first, last } = nameParts(leadName);
  if (first.length > 1 && last.length > 1) {
    if (slug.includes(first) && slug.includes(last)) return true;
    // jsmith / jsmith-style: first initial + last name
    if (slug === `${first[0]}${last}` || slug === `${last}${first[0]}`) return true;
  }
  const local = emailLocal(email);
  if (local.length >= 5 && (slug.includes(local) || (local.length >= 7 && local.includes(slug) && slug.length >= 7))) {
    return true;
  }
  return false;
}

module.exports = { linkedinMatchesLead, slugOf, nameParts };
