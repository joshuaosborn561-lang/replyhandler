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

module.exports = { getConnection, checkAvailability, bookMeeting };
