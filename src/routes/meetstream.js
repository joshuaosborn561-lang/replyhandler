const { Router } = require('express');
const { assertBookingBridgeSecret } = require('../services/booking-bridge');
const attendance = require('../services/meetstream-attendance');

const router = Router();

/** Register or cancel a meeting to track. Bearer BOOKING_BRIDGE_WEBHOOK_SECRET. */
router.post('/webhook/meetstream/register', async (req, res) => {
  const auth = assertBookingBridgeSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const r = await attendance.registerBooking(req.body || {});
    return res.status(r.ok ? 200 : r.status || 400).json(r);
  } catch (err) {
    console.error('[Meetstream] register error', { err: err.message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/** Run the TidyCal client sync now (same job the cron runs every 5 minutes). Bearer BOOKING_BRIDGE_WEBHOOK_SECRET. */
router.post('/webhook/meetstream/tidycal-sync', async (req, res) => {
  const auth = assertBookingBridgeSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const tidycal = require('../services/tidycal-attendance');
    const bookingId = String((req.body && req.body.booking_id) || '').trim();
    if (bookingId) {
      // One booking on demand (checks the link and registers it), instead of the whole sync.
      if (!/^\d+$/.test(bookingId)) return res.status(400).json({ ok: false, error: 'bad_booking_id' });
      const one = await tidycal.registerById(bookingId, { clientSlug: req.body.client_slug });
      return res.status(200).json({ ok: true, booking: one });
    }
    const r = await tidycal.runSync();
    return res.status(200).json({ ok: true, ...r });
  } catch (err) {
    console.error('[Meetstream] tidycal sync error', { err: err.message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/** Read the attendance rows. Bearer BOOKING_BRIDGE_WEBHOOK_SECRET. */
router.get('/webhook/meetstream/attendance', async (req, res) => {
  const auth = assertBookingBridgeSecret(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const rows = await attendance.listAttendance(req.query.limit);
    return res.status(200).json({
      ok: true,
      enabled: attendance.enabled(),
      scope: attendance.scopeSetting(),
      rows,
    });
  } catch (err) {
    console.error('[Meetstream] list error', { err: err.message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/** MeetStream lifecycle + participant webhooks. The secret is the last path segment. */
router.post('/webhook/meetstream/:token', async (req, res) => {
  if (!attendance.tokenOk(req.params.token)) return res.status(401).json({ ok: false });
  try {
    const r = await attendance.handleWebhook(req.body || {});
    return res.status(200).json(r);
  } catch (err) {
    console.error('[Meetstream] webhook error', { err: err.message });
    // 200 so MeetStream does not treat a transient DB error as a failed delivery to resend blindly.
    return res.status(200).json({ ok: false });
  }
});

module.exports = router;
