const db = require('../db');
const google = require('./google-calendar');
const microsoft = require('./microsoft-calendar');
const smartlead = require('./smartlead');
const { replySuppressesFollowUp } = require('../utils/booking-signals');
const { cleanInboundReply } = require('../utils/smartlead-webhook-helpers');
const { callSaysBooked } = require('./call-booking-check');

/**
 * "Does it look like this prospect already booked?"
 *
 * Four independent signals, cheapest first. Any one is enough — a follow-up
 * nudging someone who already has time on the calendar is worse than a missed
 * nudge, so this errs toward saying yes.
 *
 * Returns a reason string when booked, or null.
 */

/** 1. We booked it ourselves through the approve/send path. */
async function meetingRowExists(clientId, { leadEmail, leadName }) {
  const email = String(leadEmail || '').trim().toLowerCase();
  const name = String(leadName || '').trim();
  if (!email && !name) return false;

  const { rows } = await db.query(
    `SELECT 1 FROM meetings
      WHERE client_id = $1
        AND status IN ('proposed', 'confirmed', 'booked')
        AND (
          ($2::text <> '' AND lower(COALESCE(lead_email, '')) = $2)
          OR ($3::text <> '' AND lower(COALESCE(lead_name, '')) = lower($3))
        )
      LIMIT 1`,
    [clientId, email, name]
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

/** 3.1 Check SmartLead's live thread in case webhook/poller ingestion lagged. */
async function smartleadThreadSaysBooked(clientId, { campaignId, leadId, since }) {
  const cid = campaignId != null ? String(campaignId).trim() : '';
  const lid = leadId != null ? String(leadId).trim() : '';
  if (!cid || !lid) return null;

  const { rows: [client] } = await db.query(
    `SELECT smartlead_api_key
       FROM clients
      WHERE id = $1
      LIMIT 1`,
    [clientId]
  );
  const apiKey = String(client?.smartlead_api_key || '').trim();
  if (!apiKey) return null;

  let history;
  try {
    history = await smartlead.getThreadHistory(apiKey, cid, lid);
  } catch (err) {
    console.warn('[BookingCheck] SmartLead thread lookup failed — treating as not booked', {
      clientId, campaignId: cid, leadId: lid, err: err.message,
    });
    return null;
  }

  const list = Array.isArray(history?.history)
    ? history.history
    : Array.isArray(history?.messages)
      ? history.messages
      : Array.isArray(history)
        ? history
        : [];

  const cutoff = since ? new Date(since).getTime() : 0;
  let latestReason = null;
  let latestTs = Number.NEGATIVE_INFINITY;

  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type !== 'REPLY' && type !== 'INBOUND') continue;

    const ts = new Date(m.time || m.sent_at || m.received_at || m.created_at || 0).getTime();
    if (Number.isFinite(cutoff) && cutoff > 0 && Number.isFinite(ts) && ts < cutoff) continue;

    const text = cleanInboundReply(m.email_body || m.body || m.text || '');
    if (!text) continue;
    const reason = replySuppressesFollowUp(text);
    if (!reason) continue;

    const score = Number.isFinite(ts) ? ts : Date.now();
    if (score >= latestTs) {
      latestTs = score;
      latestReason = reason;
    }
  }
  return latestReason;
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
async function looksAlreadyBooked(clientId, {
  platform, leadEmail, leadName, leadId, campaignId, since,
}) {
  if (await meetingRowExists(clientId, { leadEmail, leadName })) return 'meeting_row_exists';

  const fromReply = await laterReplySaysBooked(clientId, {
    leadEmail, leadId, platform, since: since || new Date(0),
  });
  if (fromReply) return fromReply;

  if (platform === 'smartlead') {
    const fromSmartleadThread = await smartleadThreadSaysBooked(clientId, { campaignId, leadId, since });
    if (fromSmartleadThread) return fromSmartleadThread;
  }

  if (await calendarHasEventWith(clientId, { leadEmail, leadName })) return 'calendar_event_found';

  // 4. We called them back and the transcript shows a meeting was set.
  const fromCall = await callSaysBooked(clientId, { platform, leadEmail, leadId, since });
  if (fromCall) return fromCall;

  return null;
}

module.exports = {
  looksAlreadyBooked,
  meetingRowExists,
  laterReplySaysBooked,
  smartleadThreadSaysBooked,
  calendarHasEventWith,
};
