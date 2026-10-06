/**
 * Booking-bridge wrap → the real calendar behind it.
 *
 * book.gosalesglider.com/{slug} only captures email and redirects. It does
 * not expose open slots. Josh puts the public Calendly / HubSpot / Teams /
 * SavvyCal / PowerPSA URL in booking-bridge `site/clients.js`; we unwrap
 * the wrap and read that destination page.
 *
 * Always prefer a live fetch of https://book.gosalesglider.com/clients.js
 * so a newly added slug works without a code change. The static map is
 * only a cache for when that file is unreachable.
 */

const { BOOKING_BRIDGE_ORIGIN } = require('./public-booking-link');
const { slugFromClientName } = require('../services/booking-bridge');

const BOOKING_BRIDGE_HOSTS = new Set([
  'book.gosalesglider.com',
  'book.salesglidergrowth.com',
]);

/** Last known destinations from booking-bridge site/clients.js */
const FALLBACK_DESTINATIONS = Object.freeze({
  goliath: 'https://meetings.hubspot.com/dave-ackley',
  parlay: 'https://calendly.com/randyhaba/30min',
  techevo: 'https://calendly.com/ctapper/meeting',
  culturefits:
    'https://bookings.cloud.microsoft/bookwithme/user/7faa90d1324a4bc6a511427c5b9a1488%40culture-fits.com/meetingtype/vkqrp6uGEUq_wrB0u0dyhA2?anonymous&ismsaljsauthenabled',
  bolder: 'https://calendly.com/mike-boldercyberpartners/30min',
  salesglider: 'https://calendly.com/joshua-salesglidergrowth/30min',
  powergryd: 'https://meet.powerpsa.com/jesse/powergryd-strategy-call-2026',
});

const LIVE_TTL_MS = 60 * 1000;
let liveDestinations = null;
let liveFetchedAt = 0;

function parseClientsJs(text) {
  const out = {};
  const re = /"([a-z0-9_-]+)"\s*:\s*\{[\s\S]*?bookingUrl\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (m[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

function destinationMap() {
  return { ...FALLBACK_DESTINATIONS, ...(liveDestinations || {}) };
}

function slugFromWrapUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (!BOOKING_BRIDGE_HOSTS.has(host)) return '';
    return (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
  } catch {
    return '';
  }
}

function isBookingBridgeWrap(url) {
  return Boolean(slugFromWrapUrl(url));
}

/**
 * Calendar URL to query for open times. Never paste this into a draft when
 * the prospect-facing link is the public wrap.
 */
function rememberLiveDestination(slug, url) {
  const key = String(slug || '').trim().toLowerCase();
  const dest = String(url || '').trim();
  if (!key || !dest) return;
  liveDestinations = { ...(liveDestinations || {}), [key]: dest };
}

/**
 * Josh pastes the regular calendar URL. We keep that for open times and
 * store the BookingBridge wrap as the prospect-facing booking_link.
 */
function normalizeClientBooking(client = {}) {
  const name = client && client.name ? String(client.name) : '';
  const stored = client && client.booking_link ? String(client.booking_link).trim() : '';
  const destCol = client && client.booking_destination_url
    ? String(client.booking_destination_url).trim()
    : '';
  const nameSlug = slugFromClientName(name);

  if (isBookingBridgeWrap(stored)) {
    const slug = slugFromWrapUrl(stored);
    const dest = destCol && !isBookingBridgeWrap(destCol)
      ? destCol
      : (destinationMap()[slug] || '');
    if (slug && dest) rememberLiveDestination(slug, dest);
    return {
      slug,
      booking_link: stored,
      booking_destination_url: dest || destCol || '',
    };
  }

  if (/^https?:\/\//i.test(stored)) {
    const slug = nameSlug;
    if (slug) {
      rememberLiveDestination(slug, stored);
      return {
        slug,
        booking_link: `${BOOKING_BRIDGE_ORIGIN}/${slug}`,
        booking_destination_url: stored,
      };
    }
    return { slug: '', booking_link: stored, booking_destination_url: stored };
  }

  return {
    slug: nameSlug,
    booking_link: stored,
    booking_destination_url: destCol,
  };
}

function resolveAvailabilityBookingUrl(client, destMap = destinationMap()) {
  const destCol = client && client.booking_destination_url
    ? String(client.booking_destination_url).trim()
    : '';
  if (destCol && !isBookingBridgeWrap(destCol) && /^https?:\/\//i.test(destCol)) {
    return destCol;
  }
  const stored = client && client.booking_link ? String(client.booking_link).trim() : '';
  const wrapSlug = slugFromWrapUrl(stored);
  if (wrapSlug) {
    return destMap[wrapSlug] ? String(destMap[wrapSlug]).trim() : '';
  }
  if (stored) return stored;
  const nameSlug = slugFromClientName(client && client.name);
  return nameSlug && destMap[nameSlug] ? String(destMap[nameSlug]).trim() : '';
}

async function refreshDestinations({
  fetchImpl = fetch,
  now = Date.now(),
  timeoutMs = 1500,
  force = false,
} = {}) {
  if (!force && liveDestinations && now - liveFetchedAt < LIVE_TTL_MS) {
    return destinationMap();
  }
  try {
    const res = await fetchImpl(`${BOOKING_BRIDGE_ORIGIN}/clients.js`, {
      signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs) || 1500)),
    });
    if (res && res.ok) {
      const text = typeof res.text === 'function' ? await res.text() : '';
      const parsed = parseClientsJs(text);
      if (Object.keys(parsed).length) {
        liveDestinations = parsed;
        liveFetchedAt = now;
      }
    }
  } catch {
    // Keep the baked-in / last-good map — a stale destination is better than none.
  }
  return destinationMap();
}

/**
 * Unwrap the client's wrap (or name) to the live public calendar URL.
 * Forces a clients.js refresh when the slug is not in the cached map so a
 * client Josh just added is found without waiting out the TTL.
 */
async function resolveLiveAvailabilityBookingUrl(client, opts = {}) {
  let map = await refreshDestinations(opts);
  let url = resolveAvailabilityBookingUrl(client, map);
  if (!url) {
    map = await refreshDestinations({ ...opts, force: true });
    url = resolveAvailabilityBookingUrl(client, map);
  }
  return url;
}

function _resetLiveDestinationsForTests() {
  liveDestinations = null;
  liveFetchedAt = 0;
}

module.exports = {
  FALLBACK_DESTINATIONS,
  BOOKING_BRIDGE_HOSTS,
  parseClientsJs,
  destinationMap,
  slugFromWrapUrl,
  isBookingBridgeWrap,
  rememberLiveDestination,
  normalizeClientBooking,
  resolveAvailabilityBookingUrl,
  resolveLiveAvailabilityBookingUrl,
  refreshDestinations,
  _resetLiveDestinationsForTests,
};
