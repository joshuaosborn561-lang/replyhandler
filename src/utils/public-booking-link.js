/**
 * Prospect-facing booking URLs for clients that book through the SalesGlider
 * booking-bridge wrap (book.gosalesglider.com/{slug}).
 *
 * Tech Evolution / Corey Tapper: always emit the public wrap. The underlying
 * Calendly destination (currently calendly.com/ctapper/meeting) is owned by
 * booking-bridge — do not paste the raw Calendly into outbound copy.
 */

const BOOKING_BRIDGE_ORIGIN = 'https://book.gosalesglider.com';

/** Stable public page. Slug matches booking-bridge CLIENT_SLUG_ALIASES.techevo */
const TECHEVO_PUBLIC_BOOKING_URL = `${BOOKING_BRIDGE_ORIGIN}/techevo`;

const TECHEVO_NAME_RE = /techevolution|\btechevo\b/i;
const CTAPPER_CALENDLY_RE = /https?:\/\/(?:www\.)?calendly\.com\/ctapper\/[^\s)<>\]]+/gi;

function isTechEvolutionClient(clientOrName) {
  const name = typeof clientOrName === 'string'
    ? clientOrName
    : (clientOrName && clientOrName.name) || '';
  return TECHEVO_NAME_RE.test(String(name || ''));
}

function looksLikeCtapperCalendly(url) {
  return /https?:\/\/(?:www\.)?calendly\.com\/ctapper\//i.test(String(url || ''));
}

/**
 * Booking URL to put in prospect-facing drafts / prompts.
 * Tech Evolution is pinned to the public wrap. Everyone else keeps
 * `booking_link` as stored (including Bolder → /bolder, untouched).
 */
function prospectBookingLink({ clientName, bookingLink } = {}) {
  const raw = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  if (isTechEvolutionClient(clientName) || looksLikeCtapperCalendly(raw)) {
    return TECHEVO_PUBLIC_BOOKING_URL;
  }
  return raw;
}

/**
 * If a model leaked Corey's raw Calendly, swap it for the public wrap
 * (or strip it on times-first replies).
 */
function rewriteRawCtapperCalendly(text, { includeBookingLink = false } = {}) {
  const s = String(text || '');
  if (!/calendly\.com\/ctapper/i.test(s)) return s;
  const replacement = includeBookingLink ? TECHEVO_PUBLIC_BOOKING_URL : '';
  return s.replace(CTAPPER_CALENDLY_RE, replacement)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  BOOKING_BRIDGE_ORIGIN,
  TECHEVO_PUBLIC_BOOKING_URL,
  isTechEvolutionClient,
  looksLikeCtapperCalendly,
  prospectBookingLink,
  rewriteRawCtapperCalendly,
};
