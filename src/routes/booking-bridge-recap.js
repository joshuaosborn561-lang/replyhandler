const { Router } = require('express');
const {
  assertBookingBridgeSecret,
  parseRecapWindow,
  buildRecap,
} = require('../services/booking-bridge');
const { handleBookedMeetingEmail } = require('../services/booked-meeting-email');

const router = Router();

/**
 * booking-bridge daily/weekly Slack recap.
 *
 * GET /webhook/booking-bridge/recap?start=<iso>&end=<iso>
 * Authorization: Bearer <BOOKING_BRIDGE_WEBHOOK_SECRET>
 * Returns every active client plus INTERESTED / MEETING_PROPOSED / QUESTION
 * people in the window, one row per lead email per canonical client. Name
 * variants that share a slug are one client. Client-owned addresses are
 * omitted. New clients appear as soon as they exist in `clients`.
 * Meetings are not counted here.
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

/**
 * Meeting booked by a caller (Allo) → email Josh the call summary and prospect contact info.
 *
 * POST /webhook/booking-bridge/booked-email
 * Authorization: Bearer <BOOKING_BRIDGE_WEBHOOK_SECRET>
 * Body: { event:'booked_meeting_email', booking_id, allo_call_id, caller, client, list, call_at,
 *         prospect:{name,company,email,phone,title}, summary, recording_url }
 * Sent from the connected primary Gmail to BOOKED_MEETING_EMAIL_TO (default joshua@salesglidergrowth.com).
 */
router.post('/webhook/booking-bridge/booked-email', async (req, res) => {
  const auth = assertBookingBridgeSecret(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.error });
  }
  try {
    const result = await handleBookedMeetingEmail(req.body || {});
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[BookedMeetingEmail] handler error', { err: err.message, stack: err.stack });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
