#!/usr/bin/env node
/**
 * Unwrap live BookingBridge destinations and print two public open times.
 *
 * Usage:
 *   node scripts/probe-public-booking-slots.js
 *   node scripts/probe-public-booking-slots.js goliath salesglider powergryd
 *
 * When Josh adds a client, the public calendar URL lands in
 * https://book.gosalesglider.com/clients.js — this script is how to find
 * it and confirm we can read times. No OAuth, no PAT.
 */
const {
  refreshDestinations,
  FALLBACK_DESTINATIONS,
} = require('../src/utils/booking-bridge-destinations');
const {
  fetchPublicBookingStarts,
  pickTwoBusinessDayStarts,
  formatSlotLabel,
} = require('../src/services/scheduling-slots');

const DEFAULT_SLUGS = ['salesglider', 'goliath', 'powergryd'];

async function probeOne(slug, destMap) {
  const url = destMap[slug] || FALLBACK_DESTINATIONS[slug];
  if (!url) {
    return { slug, ok: false, error: 'slug not in live clients.js or fallback map' };
  }
  const fromDate = new Date();
  const toDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const pub = await fetchPublicBookingStarts(url, { fromDate, toDate });
  const tz = pub.timeZone || 'America/Chicago';
  const picked = pickTwoBusinessDayStarts(pub.starts, { timeZone: tz });
  return {
    slug,
    ok: picked.length >= 2,
    destination: url,
    timeZone: tz,
    openStarts: pub.starts.length,
    times: picked.map((start) => ({
      start: start.toISOString(),
      label: formatSlotLabel(start, tz),
    })),
  };
}

async function main() {
  const slugs = process.argv.slice(2).map((s) => s.toLowerCase());
  const destMap = await refreshDestinations({ force: true, timeoutMs: 4000 });
  const wanted = slugs.length ? slugs : DEFAULT_SLUGS;
  const results = [];
  for (const slug of wanted) {
    try {
      results.push(await probeOne(slug, destMap));
    } catch (err) {
      results.push({ slug, ok: false, error: err.message });
    }
  }
  console.log(JSON.stringify({ catalog: destMap, results }, null, 2));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
