const db = require('../db');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function getRedirectUri() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${process.env.PORT || 3000}`;
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return `${protocol}://${domain}/auth/google/callback`;
}

function getAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: clientId,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function exchangeCode(code) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${await res.text()}`);
  return res.json();
}

async function getValidToken(connection) {
  if (connection.token_expires_at && new Date(connection.token_expires_at) > new Date()) {
    return connection.access_token;
  }
  const tokens = await refreshAccessToken(connection.refresh_token);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await db.query(
    'UPDATE calendar_connections SET access_token = $1, token_expires_at = $2, updated_at = now() WHERE id = $3',
    [tokens.access_token, expiresAt, connection.id]
  );
  return tokens.access_token;
}

async function getUserEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to get Google user info: ${await res.text()}`);
  const data = await res.json();
  return data.email;
}

async function getAvailability(connection, timeMin, timeMax) {
  const token = await getValidToken(connection);
  const res = await fetch(`${CALENDAR_API}/freeBusy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: 'primary' }],
    }),
  });
  if (!res.ok) throw new Error(`Google freeBusy failed: ${await res.text()}`);
  const data = await res.json();
  const busy = data.calendars?.primary?.busy || [];
  return busy;
}

async function createEvent(connection, { summary, description, startTime, endTime, attendeeEmail, attendeeName }) {
  const token = await getValidToken(connection);
  const res = await fetch(`${CALENDAR_API}/calendars/primary/events?sendUpdates=all&conferenceDataVersion=0`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary,
      description: description || '',
      start: { dateTime: startTime, timeZone: 'America/New_York' },
      end: { dateTime: endTime, timeZone: 'America/New_York' },
      attendees: [{ email: attendeeEmail, displayName: attendeeName }],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
    }),
  });
  if (!res.ok) throw new Error(`Google createEvent failed: ${await res.text()}`);
  return res.json();
}

module.exports = { getAuthUrl, exchangeCode, getUserEmail, getAvailability, createEvent, getValidToken };
