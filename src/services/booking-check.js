const db = require('../db');
const google = require('./google-calendar');
const microsoft = require('./microsoft-calendar');
const { replySuppressesFollowUp } = require('../utils/booking-signals');
const { callSaysBooked } = require('./call-booking-check');
const {
  campaignIntelligenceBookingState,
  stopFollowUpsForEmail,
  normalizeEmail,
  BRIDGE_MEETING_MARKER,
} = require('./booking-bridge');

// A meeting row written by the booking bridge within this window of a booking
// that has since been cancelled is that booking's mirror (rows written before
// the bridge stamped them have no marker).
const BRIDGE_MIRROR_WINDOW_MIN = 15;

/**
 * "Does it look like this prospect already booked?"
 *
 * Independent signals, cheapest first. Any one is enough — a follow-up
 * nudging someone who already has time on the calendar is worse than a missed
 * nudge, so this errs toward saying yes.
 *
 * Returns a reason string when booked, or null.
 */

/**
 * 1. We booked it ourselves through the approve/send path.
 *
 * `cancelledBookingAnchors`: created_at times of booking_events bookings that
 * were all cancelled (no live booking left). Meeting rows that only mirror
 * those cancelled bookings are ignored, so the lead's follow-ups are allowed
 * again. Meetings a person marked booked, proposed or confirmed are untouched.
 */
async function meetingRowExists(clientId, { leadEmail, leadName, cancelledBookingAnchors = null }) {
  const email = String(leadEmail || '').trim().toLowerCase();
  const name = String(leadName || '').trim();
  if (!email && !name) return false;

  const ignoreMirrors = Array.isArray(cancelledBookingAnchors);
  const anchors = ignoreMirrors
    ? cancelledBookingAnchors.map((d) => new Date(d).toISOString())
    : [];

  const { rows } = await db.query(
    `SELECT 1 FROM meetings
      WHERE client_id = $1
        AND status IN ('proposed', 'confirmed', 'booked')
        AND (
          ($2::text <> '' AND lower(COALESCE(lead_email, '')) = $2)
          OR ($3::text <> '' AND lower(COALESCE(lead_name, '')) = lower($3))
        )
        AND NOT (
          $4::boolean
          AND status = 'booked'
          AND (
            COALESCE(calendar_provider, '') = $5
            OR (
              calendar_provider IS NULL
              AND EXISTS (
                SELECT 1 FROM unnest($6::timestamptz[]) AS a
                 WHERE meetings.confirmed_time BETWEEN a - make_interval(mins => $7::int)
                                                   AND a + make_interval(mins => $7::int)
              )
            )
          )
        )
      LIMIT 1`,
    [
      clientId, email, name,
      ignoreMirrors, BRIDGE_MEETING_MARKER, anchors, BRIDGE_MIRROR_WINDOW_MIN,
    ]
  );
  return rows.length > 0;
}

/** 2. The prospect said so in a later reply. */
async function laterReplySaysBooked(clientId, { leadEmail, leadId, platform, since }) {
  const email = String(leadEmail || '').trim().toLowerCase();
  const lead = leadId != null ? String(leadId) : '';
  if (!email && !lead) return null;

  const { rows } = await db.query(
    `SELECT inbound_message
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND created_at > $3
        AND COALESCE(classification, '') <> 'FOLLOW_UP'
        AND (
          ($4::text <> '' AND lower(COALESCE(lead_email, '')) = $4)
          OR ($5::text <> '' AND COALESCE(lead_id, '') = $5)
        )
      ORDER BY created_at DESC
      LIMIT 5`,
    [clientId, platform, since, email, lead]
  );

  for (const r of rows) {
    const reason = replySuppressesFollowUp(r.inbound_message);
    if (reason) return reason;
  }
  return null;
}

/**
 * 3. Something is on the calendar with them — covers Calendly, a manual invite,
 * or a booking that happened entirely outside this app.
 */
async function calendarHasEventWith(clientId, { leadEmail, leadName }) {
  const email = String(leadEmail || '').trim().toLowerCase();
  const query = email || String(leadName || '').trim();
  if (!query) return false;

  const { rows: [conn] } = await db.query(
    'SELECT * FROM calendar_connections WHERE client_id = $1 ORDER BY updated_at DESC LIMIT 1',
    [clientId]
  );
  if (!conn) return false;

  const provider = conn.provider === 'google' ? google : microsoft;
  let events = [];
  try {
    events = await provider.findUpcomingEvents(conn, query);
  } catch (err) {
    // A calendar we cannot read must not silently suppress follow-ups.
    console.warn('[BookingCheck] Calendar lookup failed — treating as not booked', {
      clientId, provider: conn.provider, err: err.message,
    });
    return false;
  }

  if (!email) return events.length > 0;

  return events.some((ev) => {
    const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
    return attendees.some((a) => {
      const addr = String(a?.email || a?.emailAddress?.address || '').trim().toLowerCase();
      return addr === email;
    });
  });
}

/**
 * @returns {Promise<string|null>} reason the follow-up should be skipped, or null
 */
async function looksAlreadyBooked(clientId, { platform, leadEmail, leadName, leadId, since }) {
  // Campaignintelligence booking page (push webhook + live pull of booking_events).
  // Pull covers webhook races / misses so FOLLOW_UP cards still suppress.
  // Cancelled bookings never count; when every booking for this lead was
  // cancelled, the local meeting rows that merely mirrored them stop blocking.
  const bridge = await campaignIntelligenceBookingState(leadEmail);
  const fromBridge = bridge.reason;

  if (await meetingRowExists(clientId, {
    leadEmail,
    leadName,
    cancelledBookingAnchors: bridge.cancelledOnly ? bridge.cancelledAnchors : null,
  })) return 'meeting_row_exists';

  if (fromBridge) {
    const email = normalizeEmail(leadEmail);
    if (clientId && email) {
      try {
        await stopFollowUpsForEmail({
          clientId,
          email,
          name: leadName || null,
          skipReason: fromBridge,
        });
      } catch (err) {
        console.warn('[BookingCheck] Failed to sync local skip after bridge hit', {
          clientId,
          email,
          err: err.message,
        });
      }
    }
    return fromBridge;
  }

  const fromReply = await laterReplySaysBooked(clientId, {
    leadEmail, leadId, platform, since: since || new Date(0),
  });
  if (fromReply) return fromReply;

  if (await calendarHasEventWith(clientId, { leadEmail, leadName })) return 'calendar_event_found';

  // We called them back and the transcript shows a meeting was set.
  const fromCall = await callSaysBooked(clientId, { platform, leadEmail, leadId, since });
  if (fromCall) return fromCall;

  return null;
}

module.exports = {
  looksAlreadyBooked,
  calendarHasEventWith,
  meetingRowExists,
  laterReplySaysBooked,
  calendarHasEventWith,
};
