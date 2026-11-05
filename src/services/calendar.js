const db = require('../db');
const google = require('./google-calendar');
const microsoft = require('./microsoft-calendar');

async function getConnection(clientId) {
  const { rows: [conn] } = await db.query(
    'SELECT * FROM calendar_connections WHERE client_id = $1 ORDER BY updated_at DESC LIMIT 1',
    [clientId]
  );
  return conn || null;
}

async function getConnections(clientId) {
  const { rows } = await db.query(
    'SELECT * FROM calendar_connections WHERE client_id = $1 ORDER BY updated_at DESC',
    [clientId]
  );
  return rows || [];
}

/** Extra Google calendar ids (e.g. a teammate's calendar shared to the connected account). */
function extraBusyCalendarIds(env = process.env) {
  return String(env.SCHEDULING_BUSY_CALENDAR_IDS || '')
    .split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Busy intervals across EVERY calendar connected for this client (not just the
 * newest connection), plus SCHEDULING_BUSY_CALENDAR_IDS on Google connections.
 * Returns null when nothing is connected. Throws if any connection fails, so a
 * caller never treats an unreadable calendar as free.
 */
async function checkAllBusy(clientId, timeMin, timeMax, { connections } = {}) {
  const conns = connections || await getConnections(clientId);
  if (!conns.length) return null;
  const extra = extraBusyCalendarIds();
  const out = [];
  for (const conn of conns) {
    const busy = conn.provider === 'google'
      ? await google.getAvailability(conn, timeMin, timeMax, { calendarIds: extra })
      : await microsoft.getAvailability(conn, timeMin, timeMax);
    for (const b of busy || []) out.push({ ...b, provider: conn.provider });
  }
  return out;
}

async function checkAvailability(clientId, timeMin, timeMax) {
  const conn = await getConnection(clientId);
  if (!conn) return null; // No calendar connected — can't check

  const provider = conn.provider === 'google' ? google : microsoft;
  return provider.getAvailability(conn, timeMin, timeMax);
}

async function bookMeeting(clientId, { summary, description, startTime, durationMinutes, attendeeEmail, attendeeName }) {
  const conn = await getConnection(clientId);
  if (!conn) throw new Error('No calendar connected for this client');

  const start = new Date(startTime);
  const end = new Date(start.getTime() + (durationMinutes || 30) * 60000);

  const provider = conn.provider === 'google' ? google : microsoft;
  const event = await provider.createEvent(conn, {
    summary: summary || `Call with ${attendeeName}`,
    description,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    attendeeEmail,
    attendeeName,
  });

  // Extract meeting link
  let meetingLink = null;
  if (conn.provider === 'microsoft') {
    meetingLink = event.onlineMeeting?.joinUrl || null;
  } else if (conn.provider === 'google') {
    // Google Meet link if conference was created
    meetingLink = event.hangoutLink || null;
  }

  return {
    eventId: event.id,
    provider: conn.provider,
    meetingLink,
    event,
  };
}

module.exports = { getConnection, getConnections, checkAvailability, checkAllBusy, extraBusyCalendarIds, bookMeeting };
