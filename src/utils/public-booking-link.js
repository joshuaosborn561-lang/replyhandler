/**
 * Prospect-facing booking URLs for clients that book through the SalesGlider
 * booking-bridge wrap (book.gosalesglider.com/{slug}).
 *
 * Tech Evolution outbound booking is retired — see tevolution-booking.js.
 */

const BOOKING_BRIDGE_ORIGIN = 'https://book.gosalesglider.com';
const {
  isTechEvolutionClient,
  isTechEvolutionBookingRetired,
  looksLikeCtapperCalendly,
  stripTechEvolutionBookingUrls,
} = require('./techevolution-booking');

function looksLikeBookingBridgeWrap(url) {
  try {
    const host = new URL(String(url || '').trim()).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'book.gosalesglider.com' || host === 'book.salesglidergrowth.com';
  } catch {
    return false;
  }
}

/**
 * Booking URL to put in prospect-facing drafts / prompts.
 */
function prospectBookingLink({ clientName, bookingLink } = {}) {
  const { isDeepRootsClient } = require('./meeting-modality');
  if (isDeepRootsClient(clientName)) return '';
  const raw = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  if (isTechEvolutionBookingRetired(clientName, raw)) return '';
  if (looksLikeCtapperCalendly(raw)) return '';
  if (raw && !looksLikeBookingBridgeWrap(raw)) {
    const { slugFromClientName } = require('../services/booking-bridge');
    const slug = slugFromClientName(clientName);
    if (slug) return `${BOOKING_BRIDGE_ORIGIN}/${slug}`;
  }
  return raw;
}

/** Strip retired Tech Evolution / Corey Calendly URLs from model output. */
function rewriteRawCtapperCalendly(text, _opts = {}) {
  void _opts;
  return stripTechEvolutionBookingUrls(text);
}

module.exports = {
  BOOKING_BRIDGE_ORIGIN,
  isTechEvolutionClient,
  looksLikeCtapperCalendly,
  prospectBookingLink,
  rewriteRawCtapperCalendly,
  looksLikeBookingBridgeWrap,
};
