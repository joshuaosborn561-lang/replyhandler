const db = require('../db');

/**
 * Campaignintelligence booking page → ReplyHandler bridge.
 *
 * POST /webhook/booking-bridge notifies us when a prospect confirmed a meeting
 * (or, for Culture Fits / MS Bookings, first booking-link click treated as booked).
 * Stop the follow-up cadence so we don't nudge someone who already booked.
 */

/** Slug → ReplyHandler `clients.name` aliases (from campaignintelligence log-booking). */
const CLIENT_SLUG_ALIASES = {
  goliath: ['Goliath', 'Goliath Cybersecurity', 'Goliath Solutions Group'],
  parlay: ['Parlay Tech'],
  techevo: ['TechEvolution', 'TechEvo'],
  culturefits: ['Culture Fits'],
  bolder: ['Bolder Cyber Partners'],
  salesglider: ['SalesGlider'],
  peterson: ['Roofs By Peterson', 'Roofs by Peterson'],
  vasco: ['Vasco Warranty', 'Vasco Warranty Management'],
};

function normalizeEmail(email) {
  const s = String(email || '').trim().toLowerCase();
  return s.includes('@') ? s : '';
}

function bearerToken(req) {
  const h = String(req.get('authorization') || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function timingSafeEqualString(a, b) {
  const crypto = require('crypto');
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function assertBookingBridgeSecret(req) {
  const secret = process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
  if (!secret || !String(secret).trim()) {
    return { ok: false, status: 503, error: 'booking_bridge_not_configured' };
  }
  const token = bearerToken(req);
  if (!timingSafeEqualString(token, String(secret).trim())) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

function parseBridgePayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const event = String(b.event || '').trim();
  const treatAsBooked = b.treat_as_booked === true
    || event === 'booking_confirmed'
    || (event === 'booking_link_clicked' && b.treat_as_booked !== false);
  return {
    event,
    treatAsBooked: Boolean(treatAsBooked),
    email: normalizeEmail(b.email || b.lead_email),
    name: b.name || b.lead_name ? String(b.name || b.lead_name).trim().slice(0, 200) : null,
    clientSlug: b.client_slug ? String(b.client_slug).trim().toLowerCase().slice(0, 100) : '',
    clientName: b.client_name ? String(b.client_name).trim().slice(0, 200) : null,
    campaign: b.campaign ? String(b.campaign).trim().slice(0, 200) : null,
  };
}

/**
 * Resolve which ReplyHandler clients this bridge event applies to.
 * Prefer slug aliases / explicit client_name; fall back to any client with
 * pending follow-ups for that email (so a mistyped slug still stops nudges).
 */
async function resolveClients({ clientSlug, clientName, email }) {
  const aliases = CLIENT_SLUG_ALIASES[clientSlug] || [];
  const names = [
    ...aliases,
    ...(clientName ? [clientName] : []),
  ].map((n) => String(n).trim()).filter(Boolean);

  if (names.length) {
    const { rows } = await db.query(
      `SELECT id, name FROM clients
        WHERE active IS DISTINCT FROM false
          AND lower(name) = ANY($1::text[])`,
      [names.map((n) => n.toLowerCase())]
    );
    if (rows.length) return rows;
  }

  if (!email) return [];

  const { rows } = await db.query(
    `SELECT DISTINCT c.id, c.name
       FROM clients c
       JOIN outbound_follow_ups f ON f.client_id = c.id
      WHERE c.active IS DISTINCT FROM false
        AND f.status = 'pending'
        AND lower(f.lead_email) = $1`,
    [email]
  );
  return rows;
}

/**
 * Stop follow-ups + close open Slack cards for this email on one client.
 * Mirrors Slack "Meeting booked" without requiring a pending_reply id.
 *
 * @returns {{ cancelledFollowUps: number, closedReplies: number, meetingsUpserted: number }}
 */
async function stopFollowUpsForEmail({
  clientId,
  email,
  name = null,
  skipReason = 'meeting_booked_bridge',
} = {}) {
  if (!clientId || !email) {
    return { cancelledFollowUps: 0, closedReplies: 0, meetingsUpserted: 0 };
  }

  const fu = await db.query(
    `UPDATE outbound_follow_ups
        SET status = 'skipped',
            skip_reason = $3,
            updated_at = now()
      WHERE client_id = $1
        AND status = 'pending'
        AND lower(lead_email) = $2`,
    [clientId, email, skipReason]
  );
  const cancelledFollowUps = fu.rowCount || 0;

  const closed = await db.query(
    `UPDATE pending_replies
        SET status = 'meeting_booked',
            draft_reply = NULL,
            updated_at = now()
      WHERE client_id = $1
        AND status IN ('pending', 'alert_only', 'flagged')
        AND lower(lead_email) = $2
      RETURNING id, lead_name, linkedin_url`,
    [clientId, email]
  );
  const closedReplies = closed.rowCount || 0;

  let meetingsUpserted = 0;
  // Prefer attaching a meeting to the newest closed reply; otherwise insert a
  // standalone booked row so booking-check still suppresses future nudges.
  const anchor = closed.rows[0] || null;
  if (anchor) {
    const { rows: [existing] } = await db.query(
      `SELECT id FROM meetings
        WHERE client_id = $1 AND pending_reply_id = $2
        LIMIT 1`,
      [clientId, anchor.id]
    );
    if (existing) {
      await db.query(
        `UPDATE meetings
            SET status = 'booked',
                confirmed_time = COALESCE(confirmed_time, now()),
                updated_at = now()
          WHERE id = $1`,
        [existing.id]
      );
    } else {
      await db.query(
        `INSERT INTO meetings
          (client_id, pending_reply_id, lead_name, lead_email, linkedin_url,
           status, confirmed_time)
         VALUES ($1, $2, $3, $4, $5, 'booked', now())`,
        [
          clientId,
          anchor.id,
          name || anchor.lead_name || null,
          email,
          anchor.linkedin_url || null,
        ]
      );
    }
    meetingsUpserted = 1;
  } else {
    const { rows: [byEmail] } = await db.query(
      `SELECT id FROM meetings
        WHERE client_id = $1
          AND lower(lead_email) = $2
          AND status = 'booked'
        LIMIT 1`,
      [clientId, email]
    );
    if (!byEmail) {
      await db.query(
        `INSERT INTO meetings
          (client_id, pending_reply_id, lead_name, lead_email, linkedin_url,
           status, confirmed_time)
         VALUES ($1, NULL, $2, $3, NULL, 'booked', now())`,
        [clientId, name, email]
      );
      meetingsUpserted = 1;
    }
  }

  return { cancelledFollowUps, closedReplies, meetingsUpserted };
}

/**
 * Handle one booking-bridge webhook payload.
 * @returns {{ ok: true, skipped?: string, results?: object[] } | { ok: false, status: number, error: string }}
 */
async function handleBookingBridgeEvent(payload) {
  const parsed = parseBridgePayload(payload);
  if (!parsed.email) {
    return { ok: false, status: 400, error: 'email_required' };
  }
  if (!['booking_confirmed', 'booking_link_clicked'].includes(parsed.event)) {
    return { ok: false, status: 400, error: 'invalid_event' };
  }
  if (!parsed.treatAsBooked) {
    return { ok: true, skipped: 'not_treat_as_booked' };
  }

  const clients = await resolveClients(parsed);
  if (!clients.length) {
    console.warn('[BookingBridge] No matching client for stop', {
      email: parsed.email,
      clientSlug: parsed.clientSlug,
      clientName: parsed.clientName,
      event: parsed.event,
    });
    return {
      ok: true,
      skipped: 'no_matching_client',
      email: parsed.email,
      clientSlug: parsed.clientSlug,
    };
  }

  const results = [];
  for (const client of clients) {
    const r = await stopFollowUpsForEmail({
      clientId: client.id,
      email: parsed.email,
      name: parsed.name,
    });
    results.push({
      clientId: client.id,
      clientName: client.name,
      ...r,
    });
    console.log('[BookingBridge] Stopped follow-ups', {
      event: parsed.event,
      email: parsed.email,
      client: client.name,
      campaign: parsed.campaign,
      ...r,
    });
  }

  return {
    ok: true,
    event: parsed.event,
    email: parsed.email,
    results,
  };
}

module.exports = {
  CLIENT_SLUG_ALIASES,
  assertBookingBridgeSecret,
  parseBridgePayload,
  resolveClients,
  stopFollowUpsForEmail,
  handleBookingBridgeEvent,
  normalizeEmail,
};
