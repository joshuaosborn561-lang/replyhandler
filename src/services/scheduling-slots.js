const calendar = require('./calendar');
const { prospectBookingLink } = require('../utils/public-booking-link');
const {
  resolveAvailabilityBookingUrl,
  refreshDestinations,
} = require('../utils/booking-bridge-destinations');

const CALENDLY_API = 'https://api.calendly.com';

function normalizeBookingUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '');
    return `${u.protocol}//${host}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return url.trim().replace(/\/$/, '').toLowerCase();
  }
}

function isCalendlyUrl(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h === 'calendly.com';
  } catch {
    return false;
  }
}

async function calendlyFetch(pathWithQuery, token) {
  const res = await fetch(`${CALENDLY_API}${pathWithQuery}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Calendly API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function listAllCalendlyEventTypes(userUri, token) {
  const all = [];
  let nextUrl = `/event_types?user=${encodeURIComponent(userUri)}&active=true&count=100`;
  while (nextUrl) {
    const page = await calendlyFetch(nextUrl, token);
    all.push(...(page.collection || []));
    nextUrl = page.pagination?.next_page_token
      ? `/event_types?user=${encodeURIComponent(userUri)}&active=true&count=100&page_token=${encodeURIComponent(page.pagination.next_page_token)}`
      : null;
  }
  return all;
}

/**
 * Resolve event type URI from a public Calendly scheduling URL + PAT.
 */
async function resolveCalendlyEventTypeUri(bookingLink, token) {
  const normalizedTarget = normalizeBookingUrl(bookingLink);
  const me = await calendlyFetch('/users/me', token);
  const userUri = me?.resource?.uri;
  if (!userUri) throw new Error('Calendly /users/me missing resource.uri');

  const eventTypes = await listAllCalendlyEventTypes(userUri, token);
  const schedMatches = eventTypes.filter((et) => {
    if (!et.scheduling_url) return false;
    const s = normalizeBookingUrl(et.scheduling_url);
    return s === normalizedTarget || normalizedTarget.startsWith(`${s}/`);
  });

  if (schedMatches.length === 1) return schedMatches[0].uri;
  if (schedMatches.length > 1) {
    const exact = schedMatches.find((et) => normalizeBookingUrl(et.scheduling_url) === normalizedTarget);
    return (exact || schedMatches[0]).uri;
  }

  let slug;
  try {
    const parts = new URL(bookingLink).pathname.split('/').filter(Boolean);
    slug = parts[parts.length - 1]?.toLowerCase();
  } catch {
    slug = null;
  }
  if (slug) {
    const bySlug = eventTypes.filter((et) => (et.slug || '').toLowerCase() === slug);
    if (bySlug.length === 1) return bySlug[0].uri;
    if (bySlug.length > 1) {
      const exact = bySlug.find((et) => normalizeBookingUrl(et.scheduling_url) === normalizedTarget);
      return (exact || bySlug[0]).uri;
    }
  }

  throw new Error('No Calendly event type matched this booking link for this token.');
}

/**
 * Fetch available start times from Calendly (API max 7 days per request).
 */
async function fetchCalendlyAvailableStarts(eventTypeUri, token, fromDate, toDate) {
  const slots = [];
  let cursor = new Date(fromDate);

  while (cursor < toDate) {
    const windowEnd = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
    const end = windowEnd > toDate ? toDate : windowEnd;
    const qs = new URLSearchParams({
      event_type: eventTypeUri,
      start_time: cursor.toISOString(),
      end_time: end.toISOString(),
    });
    const data = await calendlyFetch(`/event_type_available_times?${qs}`, token);
    const collection = data.collection || [];
    for (const item of collection) {
      const st = item.start_time;
      if (st) slots.push(new Date(st));
    }
    cursor = end;
  }

  slots.sort((a, b) => a - b);
  return slots;
}

function formatSlotLabel(isoDate, timeZone) {
  const tz = timeZone || 'America/New_York';
  const d = new Date(isoDate);
  return d.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function normalizeBusyIntervals(rawBusy, provider) {
  const out = [];
  if (!rawBusy || !Array.isArray(rawBusy)) return out;

  for (const b of rawBusy) {
    if (!b) continue;
    if (typeof b.start === 'string' && typeof b.end === 'string') {
      out.push({ start: new Date(b.start), end: new Date(b.end) });
    } else if (b.start?.dateTime && b.end?.dateTime) {
      out.push({ start: new Date(b.start.dateTime), end: new Date(b.end.dateTime) });
    } else if (provider === 'microsoft' && b.start && b.end) {
      const s = typeof b.start === 'string' ? b.start : (b.start.dateTime || b.start);
      const e = typeof b.end === 'string' ? b.end : (b.end.dateTime || b.end);
      if (s && e) out.push({ start: new Date(s), end: new Date(e) });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function sameStart(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60 * 1000;
}

/** Skip already-offered starts, then take `count` after `offset`. */
function pickOpenStarts(starts, { offset = 0, count = 2, excludeStarts = [] } = {}) {
  const excluded = (excludeStarts || [])
    .map((s) => new Date(s))
    .filter((d) => !Number.isNaN(d.getTime()));
  const filtered = (starts || []).filter((s) => !excluded.some((ex) => sameStart(s, ex)));
  const off = Math.max(0, Number(offset) || 0);
  const n = Math.max(1, Number(count) || 2);
  return filtered.slice(off, off + n);
}

function slotOffsetForFollowUpStep(step) {
  const n = Number(step) || 1;
  return Math.max(0, (n - 1) * 2);
}

function timesPlusLinkPromptBlock({ slots, link, inPerson }) {
  const list = slots || [];
  const lines = list.map((s) => `- ${s.label} (${s.start})`);
  const linkRule = inPerson
    ? 'IN-PERSON: Do NOT paste any booking/Calendly URL, Zoom, or phone CTA.'
    : link
      ? `Then include this exact booking URL once: ${link}`
      : 'Do not invent a fake booking URL.';

  if (list.length >= 2) {
    return (
      `VERIFIED OPEN START TIMES (use exactly these two in the draft wording; do not invent other times):\n` +
      `${lines.join('\n')}\n\n` +
      (inPerson
        ? `IN-PERSON: Suggest those two times to stop by. ${linkRule}`
        : `TIMES + BOOKING LINK: Suggest those two times in plain language. ${linkRule}`)
    );
  }
  if (list.length === 1) {
    return (
      `ONE verified open time: ${lines[0]}. Suggest that time plus one nearby alternative daypart. ${linkRule}`
    );
  }
  if (inPerson) {
    return `NO verified free slots were retrieved. Suggest two rough times in the next few business days to stop by in person. ${linkRule}`;
  }
  return link
    ? `NO verified free slots were retrieved (add a Calendly PAT for the calendar behind this booking-bridge wrap, or connect Google/Outlook). Suggest two rough times in the next few business days. ${linkRule}`
    : 'NO verified free slots were retrieved. Suggest two rough times in the next few business days. Do not invent a fake booking URL.';
}

/**
 * Open 30-minute UTC slots with no overlap on the connected calendar.
 */
async function fetchCalendarFreeStarts(clientId, fromDate, toDate, { limit = 8 } = {}) {
  const conn = await calendar.getConnection(clientId);
  if (!conn) return [];

  const busyIntervals = [];
  let cursor = new Date(fromDate);
  while (cursor < toDate) {
    const chunkEnd = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
    const end = chunkEnd > toDate ? toDate : chunkEnd;
    const busy = await calendar.checkAvailability(clientId, cursor, end);
    busyIntervals.push(...normalizeBusyIntervals(busy, conn.provider));
    cursor = end;
  }
  busyIntervals.sort((a, b) => a.start - b.start);
  const SLOT_MS = 30 * 60 * 1000;
  const minStart = new Date(Math.max(fromDate.getTime(), Date.now() + 2 * 60 * 60 * 1000));
  const gridStart = new Date(Math.ceil(minStart.getTime() / SLOT_MS) * SLOT_MS);
  const max = Math.max(2, Number(limit) || 8);

  const found = [];
  for (let t = gridStart.getTime(); t < toDate.getTime() && found.length < max; t += SLOT_MS) {
    const slotStart = new Date(t);
    const slotEnd = new Date(t + SLOT_MS);
    const dow = slotStart.getUTCDay();
    if (dow === 0 || dow === 6) continue;

    const clash = busyIntervals.some((iv) => overlaps(slotStart, slotEnd, iv.start, iv.end));
    if (!clash) found.push(slotStart);
  }
  return found;
}

/**
 * Booking-link prompt (no Calendly/calendar HTTP). Keeps webhooks fast — HeyReach docs
 * note webhook delivery can lag; blocking on multi-hop Calendly + calendar scans adds seconds–minutes.
 */
function schedulingPromptBookingLinkOnly(client) {
  const { prefersInPersonMeeting } = require('../utils/meeting-modality');
  const inPerson = prefersInPersonMeeting(client && client.voice_prompt);
  const link = prospectBookingLink({
    clientName: client && client.name,
    bookingLink: client && client.booking_link,
  });
  if (inPerson) {
    return {
      slots: [],
      promptBlock:
        'IN-PERSON (no live availability API call — faster webhook path): Suggest two concrete times in the next few business days to stop by in person. Do NOT paste a booking URL, Zoom, or phone CTA.',
    };
  }
  return {
    slots: [],
    promptBlock: link
      ? `TIMES + BOOKING LINK (no live availability API call — faster webhook path): Suggest two concrete times in the next few business days, then include this exact booking URL once: ${link}`
      : 'No booking link on this client and no live availability lookup was run. Suggest two rough times in the next few business days; do not invent a fake booking URL.',
  };
}

/**
 * Returns verified open times + human labels for Gemini.
 * @param {object} client - DB client row (booking_link, calendly_personal_access_token, id, voice_prompt)
 * @param {{ skipExternalFetch?: boolean, offset?: number, count?: number, excludeStarts?: Array<string|Date> }} [options]
 */
async function resolveVerifiedSchedulingSlots(client, options = {}) {
  if (options.skipExternalFetch) {
    return schedulingPromptBookingLinkOnly(client);
  }
  const { prefersInPersonMeeting } = require('../utils/meeting-modality');
  const inPerson = prefersInPersonMeeting(client && client.voice_prompt);
  const link = prospectBookingLink({
    clientName: client && client.name,
    bookingLink: client && client.booking_link,
  });
  const offset = Math.max(0, Number(options.offset) || 0);
  const count = Math.max(1, Number(options.count) || 2);
  const needed = offset + count;
  const timeZone = process.env.DEFAULT_BOOKING_TIMEZONE || 'America/New_York';
  const fromDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const toDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  let starts = [];
  const destMap = await refreshDestinations();
  const availabilityUrl = resolveAvailabilityBookingUrl(client, destMap);

  try {
    // Query the calendar behind the booking-bridge wrap (or a raw Calendly
    // booking_link). The prospect-facing URL stays the public wrap.
    if (client.calendly_personal_access_token && availabilityUrl && isCalendlyUrl(availabilityUrl)) {
      const etUri = await resolveCalendlyEventTypeUri(availabilityUrl, client.calendly_personal_access_token);
      starts = await fetchCalendlyAvailableStarts(
        etUri,
        client.calendly_personal_access_token,
        fromDate,
        toDate
      );
    }
  } catch (err) {
    console.warn('[SchedulingSlots] Calendly resolution failed, trying calendar', {
      err: err.message,
      availabilityUrl,
    });
    starts = [];
  }

  if (starts.length < needed) {
    try {
      const calStarts = await fetchCalendarFreeStarts(client.id, fromDate, toDate, { limit: Math.max(8, needed) });
      const merged = [...starts];
      for (const s of calStarts) {
        if (!merged.some((x) => sameStart(x, s))) merged.push(s);
      }
      merged.sort((a, b) => a - b);
      starts = merged;
    } catch (err) {
      console.warn('[SchedulingSlots] Calendar free slots failed', { err: err.message });
    }
  }

  const picked = pickOpenStarts(starts, {
    offset,
    count,
    excludeStarts: options.excludeStarts,
  });
  const slots = picked.map((start) => ({
    start: start.toISOString(),
    label: formatSlotLabel(start, timeZone),
  }));

  return {
    slots,
    promptBlock: timesPlusLinkPromptBlock({ slots, link, inPerson }),
  };
}

module.exports = {
  resolveVerifiedSchedulingSlots,
  schedulingPromptBookingLinkOnly,
  pickOpenStarts,
  slotOffsetForFollowUpStep,
  formatSlotLabel,
  timesPlusLinkPromptBlock,
  normalizeBookingUrl,
  isCalendlyUrl,
};
