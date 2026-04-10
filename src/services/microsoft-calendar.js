const db = require('../db');

const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';

const SCOPES = [
  'openid',
  'email',
  'offline_access',
  'Calendars.ReadWrite',
  'OnlineMeetings.ReadWrite',
].join(' ');

function getRedirectUri() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${process.env.PORT || 3000}`;
  const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  return `${protocol}://${domain}/auth/microsoft/callback`;
}

function getAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPES,
    response_mode: 'query',
    state: clientId,
  });
  return `${MS_AUTH_URL}?${params}`;
}

async function exchangeCode(code) {
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token exchange failed: ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token refresh failed: ${await res.text()}`);
  return res.json();
}

async function getValidToken(connection) {
  if (connection.token_expires_at && new Date(connection.token_expires_at) > new Date()) {
    return connection.access_token;
  }
  const tokens = await refreshAccessToken(connection.refresh_token);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await db.query(
    'UPDATE calendar_connections SET access_token = $1, refresh_token = $2, token_expires_at = $3, updated_at = now() WHERE id = $4',
    [tokens.access_token, tokens.refresh_token || connection.refresh_token, expiresAt, connection.id]
  );
  return tokens.access_token;
}

async function getUserEmail(accessToken) {
  const res = await fetch(`${GRAPH_API}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to get Microsoft user info: ${await res.text()}`);
  const data = await res.json();
  return data.mail || data.userPrincipalName;
}

async function getAvailability(connection, timeMin, timeMax) {
  const token = await getValidToken(connection);
  const res = await fetch(`${GRAPH_API}/me/calendar/getSchedule`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schedules: [connection.email],
      startTime: { dateTime: timeMin.toISOString(), timeZone: 'Eastern Standard Time' },
      endTime: { dateTime: timeMax.toISOString(), timeZone: 'Eastern Standard Time' },
    }),
  });
  if (!res.ok) throw new Error(`Microsoft getSchedule failed: ${await res.text()}`);
  const data = await res.json();
  return data.value?.[0]?.scheduleItems || [];
}

async function createEvent(connection, { summary, description, startTime, endTime, attendeeEmail, attendeeName }) {
  const token = await getValidToken(connection);

  const event = {
    subject: summary,
    body: { contentType: 'text', content: description || '' },
    start: { dateTime: startTime, timeZone: 'Eastern Standard Time' },
    end: { dateTime: endTime, timeZone: 'Eastern Standard Time' },
    attendees: [{
      emailAddress: { address: attendeeEmail, name: attendeeName },
      type: 'required',
    }],
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
  };

  const res = await fetch(`${GRAPH_API}/me/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`Microsoft createEvent failed: ${await res.text()}`);
  return res.json();
}

module.exports = { getAuthUrl, exchangeCode, getUserEmail, getAvailability, createEvent, getValidToken };
