const { Router } = require('express');
const db = require('../db');
const { normalizeClientBooking } = require('../utils/booking-bridge-destinations');

const router = Router();

const BOOKING_BRIDGE_ORIGINS = [
  'https://book.gosalesglider.com',
  'https://book.salesglidergrowth.com',
];

function catalogCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Max-Age', '600');
  res.set('Cache-Control', 'public, max-age=30');
}

/**
 * Live BookingBridge catalog. The wrap page fetches this so a client Josh
 * just added in ReplyHandler works without editing site/clients.js.
 */
router.options('/public/booking-clients', (_req, res) => {
  catalogCors(res);
  return res.status(204).end();
});

router.get('/public/booking-clients', async (_req, res) => {
  catalogCors(res);
  try {
    const { rows } = await db.query(
      `SELECT name, booking_link, booking_destination_url
         FROM clients
        WHERE active IS DISTINCT FROM false`
    );
    const out = {};
    for (const row of rows) {
      const n = normalizeClientBooking(row);
      if (!n.slug || !n.booking_destination_url) continue;
      out[n.slug] = {
        name: row.name,
        bookingUrl: n.booking_destination_url,
      };
    }
    res.json({
      origin: BOOKING_BRIDGE_ORIGINS[0],
      clients: out,
    });
  } catch (err) {
    console.error('[BookingCatalog] Failed', { err: err.message });
    res.status(500).json({ error: 'catalog_unavailable' });
  }
});

module.exports = router;
