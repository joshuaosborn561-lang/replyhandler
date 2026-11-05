/**
 * Tech Evolution (Corey Tapper) outbound booking is retired in ReplyHandler.
 * Reply ingestion / campaign routing may still use sg-owner:techevo; drafts must
 * never offer a booking URL from any source (DB row, wrap, live clients.js, fallback).
 */

const TECHEVO_NAME_RE = /techevolution|\btechevo\b/i;
const TECHEVO_BOOKING_SLUG = 'techevo';

const CTAPPER_CALENDLY_RE = /https?:\/\/(?:www\.)?calendly\.com\/ctapper\/[^\s)<>\]]+/gi;
const TECHEVO_WRAP_RE = /https?:\/\/(?:www\.)?book\.(?:gosalesglider\.com|salesglidergrowth\.com)\/techevo\b[^\s)<>\]]*/gi;

function clientDisplayName(clientOrName) {
  if (typeof clientOrName === 'string') return clientOrName;
  return (clientOrName && clientOrName.name) || '';
}

function isTechEvolutionClient(clientOrName) {
  return TECHEVO_NAME_RE.test(String(clientDisplayName(clientOrName) || ''));
}

function isTechEvolutionBookingSlug(slug) {
  return String(slug || '').trim().toLowerCase() === TECHEVO_BOOKING_SLUG;
}

function looksLikeCtapperCalendly(url) {
  return /https?:\/\/(?:www\.)?calendly\.com\/ctapper\//i.test(String(url || ''));
}

function looksLikeTechEvolutionBookingWrap(url) {
  try {
    const u = new URL(String(url || '').trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'book.gosalesglider.com' && host !== 'book.salesglidergrowth.com') {
      return false;
    }
    const seg = (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    return seg === TECHEVO_BOOKING_SLUG;
  } catch {
    return false;
  }
}

/** True when this client row or URL must not resolve or emit booking destinations. */
function isTechEvolutionBookingRetired(clientOrName, bookingLink) {
  if (isTechEvolutionClient(clientOrName)) return true;
  const raw = String(bookingLink || '').trim();
  if (looksLikeTechEvolutionBookingWrap(raw)) return true;
  if (looksLikeCtapperCalendly(raw)) return true;
  return false;
}

function stripTechEvolutionBookingUrls(text) {
  let s = String(text || '');
  if (!s) return s;
  s = s.replace(CTAPPER_CALENDLY_RE, '');
  s = s.replace(TECHEVO_WRAP_RE, '');
  return s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  TECHEVO_BOOKING_SLUG,
  isTechEvolutionClient,
  isTechEvolutionBookingSlug,
  looksLikeCtapperCalendly,
  looksLikeTechEvolutionBookingWrap,
  isTechEvolutionBookingRetired,
  stripTechEvolutionBookingUrls,
};
