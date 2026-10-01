const { Router } = require('express');
const {
  assertBookingBridgeSecret,
  parseRecapWindow,
  buildRecap,
} = require('../services/booking-bridge');

const router = Router();

/**
 * booking-bridge daily/weekly Slack recap.
 *
 * GET /webhook/booking-bridge/recap?start=<iso>&end=<iso>
 * Authorization: Bearer <BOOKING_BRIDGE_WEBHOOK_SECRET>
 * Returns every active client plus INTERESTED / MEETING_PROPOSED / QUESTION
 * rows in the window. New clients appear as soon as they exist in `clients`.
 */
router.get('/webhook/booking-bridge/recap', async (req, res) => {
  const auth = assertBookingBridgeSecret(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.error });
  }

  const window = parseRecapWindow(req.query || {});
  if (!window.ok) {
    return res.status(window.status).json({ ok: false, error: window.error });
  }

  try {
    const recap = await buildRecap({ startIso: window.startIso, endIso: window.endIso });
    return res.status(200).json(recap);
  } catch (err) {
    console.error('[BookingBridge] recap error', { err: err.message, stack: err.stack });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
