const calendar = require('./calendar');
const { prospectBookingLink } = require('../utils/public-booking-link');
const {
  resolveLiveAvailabilityBookingUrl,
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

function hostnameOf(url) {
  try {
    return new URL(String(url || '').trim()).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isCalendlyUrl(url) {
  return hostnameOf(url) === 'calendly.com';
}

function isHubSpotMeetingsUrl(url) {
  const h = hostnameOf(url);
  return h === 'meetings.hubspot.com' || /^meetings-[a-z0-9]+\.hubspot\.com$/.test(h);
}

function isMsBookingsUrl(url) {
  const h = hostnameOf(url);
  if (h === 'bookings.cloud.microsoft' || h === 'outlook.office.com' || h === 'outlook.office365.com') {
    return true;
  }
  return /\/bookwithme\//i.test(String(url || ''));
}

function isSavvyCalHost(url) {
  const h = hostnameOf(url);
  return h === 'savvycal.com' || h.endsWith('.savvycal.com');
}

/** Public Calendly path: /{profile}/{event} or /d/{shareUid}/... */
function parseCalendlyPublicUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.hostname.replace(/^www\./, '').toLowerCase() !== 'calendly.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'd' && parts[1]) {
      return { shareUuid: parts[1] };
    }
    if (parts.length >= 2 && parts[0] !== 'd') {
      return { profileSlug: parts[0], eventTypeSlug: parts[1] };
    }
    return null;
  } catch {
    return null;
  }
}

function ymdInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function weekdayInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'America/Chicago',
    weekday: 'short',
  }).format(date);
}

function isWeekendInZone(date, timeZone) {
  const w = weekdayInZone(date, timeZone);
  return w === 'Sat' || w === 'Sun';
}

/**
 * One slot on the next business day, one on the business day after.
 * Skips today, weekends, and Friday→Sat/Sun (lands on Mon/Tue).
 */
function pickTwoBusinessDayStarts(starts, {
  timeZone = 'America/Chicago',
  offset = 0,
  count = 2,
  excludeStarts = [],
  now = new Date(),
} = {}) {
  const excluded = (excludeStarts || [])
    .map((s) => new Date(s))
    .filter((d) => !Number.isNaN(d.getTime()));
  const todayYmd = ymdInZone(now, timeZone);
  const byDay = new Map();
  for (const raw of starts || []) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    if (excluded.some((ex) => sameStart(d, ex))) continue;
    if (isWeekendInZone(d, timeZone)) continue;
    const ymd = ymdInZone(d, timeZone);
    if (ymd <= todayYmd) continue;
    if (!byDay.has(ymd)) byDay.set(ymd, []);
    byDay.get(ymd).push(d);
  }
  for (const list of byDay.values()) list.sort((a, b) => a - b);
  const days = [...byDay.keys()].sort();
  const off = Math.max(0, Number(offset) || 0);
  const n = Math.max(1, Number(count) || 2);
  return days.slice(off, off + n).map((ymd) => byDay.get(ymd)[0]);
}

async function calendlyPublicFetch(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 ReplyHandlerAvailability/1.0',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Calendly public ${res.status}: ${t.slice(0, 160)}`);
  }
  return res.json();
}

/**
 * Same JSON the public Calendly page loads. No PAT, no client OAuth.
 */
async function fetchPublicCalendlyStarts(bookingUrl, { fromDate, toDate } = {}) {
  const parsed = parseCalendlyPublicUrl(bookingUrl);
  if (!parsed) return { starts: [], timeZone: null };

  const lookupQs = new URLSearchParams();
  if (parsed.profileSlug) lookupQs.set('profile_slug', parsed.profileSlug);
  if (parsed.eventTypeSlug) lookupQs.set('event_type_slug', parsed.eventTypeSlug);
  if (parsed.shareUuid) lookupQs.set('share_uuid', parsed.shareUuid);

  const eventType = await calendlyPublicFetch(
    `https://calendly.com/api/booking/event_types/lookup?${lookupQs}`
  );
  const uuid = eventType && eventType.uuid;
  if (!uuid) return { starts: [], timeZone: eventType?.availability_timezone || null };
  const timeZone = eventType.availability_timezone || eventType.profile?.timezone || 'America/Chicago';

  const from = fromDate || new Date();
  const to = toDate || new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const rangeQs = new URLSearchParams({
    timezone: timeZone,
    range_start: ymdInZone(from, timeZone),
    range_end: ymdInZone(to, timeZone),
  });
  const range = await calendlyPublicFetch(
    `https://calendly.com/api/booking/event_types/${encodeURIComponent(uuid)}/calendar/range?${rangeQs}`
  );
  const starts = [];
  for (const day of range.days || []) {
    for (const spot of day.spots || []) {
      if (spot.status && spot.status !== 'available') continue;
      if (spot.start_time) starts.push(new Date(spot.start_time));
    }
  }
  starts.sort((a, b) => a - b);
  return { starts, timeZone };
}

function parseHubSpotPublicUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'meetings.hubspot.com' && !/^meetings-[a-z0-9]+\.hubspot\.com$/.test(host)) {
      return null;
    }
    let path = u.pathname.replace(/\/$/, '');
    if (path.startsWith('/meetings/')) path = path.slice('/meetings'.length);
    if (path.startsWith('/temp-v2/')) path = path.slice('/temp-v2'.length);
    const slug = path.replace(/^\//, '');
    if (!slug) return null;
    return { host, slug };
  } catch {
    return null;
  }
}

function parseMsBookingsPublicUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    const parts = u.pathname.split('/').filter(Boolean);
    const userIdx = parts.findIndex((p) => p.toLowerCase() === 'user');
    const typeIdx = parts.findIndex((p) => p.toLowerCase() === 'meetingtype');
    if (userIdx < 0 || typeIdx < 0 || !parts[userIdx + 1] || !parts[typeIdx + 1]) return null;
    return {
      user: decodeURIComponent(parts[userIdx + 1]),
      meetingType: decodeURIComponent(parts[typeIdx + 1]),
    };
  } catch {
    return null;
  }
}

function parseSavvyCalInertiaPage(html) {
  const text = String(html || '');
  const script = text.match(/<script[^>]*data-page="app"[^>]*>([\s\S]*?)<\/script>/i);
  if (script) {
    try {
      const page = JSON.parse(script[1].trim());
      const props = page && page.props ? page.props : {};
      if (props.linkId) {
        return {
          linkId: String(props.linkId),
          organizerId: props.organizer && props.organizer.user && props.organizer.user.id
            ? String(props.organizer.user.id)
            : '',
        };
      }
    } catch {
      // Fall through to regex.
    }
  }
  const linkId = text.match(/"linkId"\s*:\s*"(link_[A-Za-z0-9]+)"/);
  const organizerId = text.match(/"organizer"\s*:\s*\{[^}]*"id"\s*:\s*"(user_[A-Za-z0-9]+)"/);
  if (!linkId) return null;
  return { linkId: linkId[1], organizerId: organizerId ? organizerId[1] : '' };
}

async function publicJsonFetch(url, { method = 'GET', body, origin, referer } = {}) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 ReplyHandlerAvailability/1.0',
  };
  if (origin) headers.Origin = origin;
  if (referer) headers.Referer = referer;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Public booking ${res.status}: ${t.slice(0, 160)}`);
  }
  const ct = String(res.headers.get('content-type') || '');
  if (!ct.includes('json')) {
    throw new Error(`Public booking expected JSON, got ${ct || 'no content-type'}`);
  }
  return res.json();
}

function preferredHubSpotDurationBucket(byDuration) {
  const by = byDuration && typeof byDuration === 'object' ? byDuration : {};
  return by['1800000'] || by['3600000'] || by[Object.keys(by)[0]] || null;
}

/**
 * Same JSON the public HubSpot Meetings page loads. No portal token.
 */
async function fetchPublicHubSpotStarts(bookingUrl, { fromDate, toDate } = {}) {
  const parsed = parseHubSpotPublicUrl(bookingUrl);
  if (!parsed) return { starts: [], timeZone: null };
  const timeZone = 'America/Chicago';
  const origin = `https://${parsed.host}`;
  const qs = (monthOffset) => new URLSearchParams({
    slug: parsed.slug,
    monthOffset: String(monthOffset),
    timezone: timeZone,
  });
  const first = await publicJsonFetch(
    `https://api.hubspot.com/meetings-public/v3/book/availability-page?${qs(0)}`,
    { origin, referer: String(bookingUrl) }
  );
  const pages = [first];
  if (first && first.linkAvailability && first.linkAvailability.hasMore) {
    pages.push(await publicJsonFetch(
      `https://api.hubspot.com/meetings-public/v3/book/availability-page?${qs(1)}`,
      { origin, referer: String(bookingUrl) }
    ));
  }
  const starts = [];
  for (const page of pages) {
    const bucket = preferredHubSpotDurationBucket(
      page && page.linkAvailability && page.linkAvailability.linkAvailabilityByDuration
    );
    for (const spot of (bucket && bucket.availabilities) || []) {
      const ms = Number(spot && spot.startMillisUtc);
      if (Number.isFinite(ms)) starts.push(new Date(ms));
    }
  }
  const fromMs = fromDate ? new Date(fromDate).getTime() : 0;
  const toMs = toDate ? new Date(toDate).getTime() : Infinity;
  const filtered = starts.filter((d) => {
    const t = d.getTime();
    return t >= fromMs && t <= toMs;
  });
  filtered.sort((a, b) => a - b);
  return { starts: filtered, timeZone };
}

/**
 * SavvyCal (including custom domains like meet.powerpsa.com).
 * Read linkId from the public page, then POST /api/links/{id}/intervals.
 */
async function fetchPublicSavvyCalStarts(bookingUrl, { fromDate, toDate } = {}) {
  const pageUrl = String(bookingUrl || '').trim();
  if (!pageUrl) return { starts: [], timeZone: null };
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return { starts: [], timeZone: null };
  }
  const htmlRes = await fetch(pageUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 ReplyHandlerAvailability/1.0',
    },
  });
  if (!htmlRes.ok) {
    throw new Error(`SavvyCal page ${htmlRes.status}`);
  }
  const parsed = parseSavvyCalInertiaPage(await htmlRes.text());
  if (!parsed || !parsed.linkId) return { starts: [], timeZone: null };

  const from = fromDate || new Date();
  const to = toDate || new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const body = {
    from: new Date(from).toISOString(),
    until: new Date(to).toISOString(),
  };
  if (parsed.organizerId) body.organizer = parsed.organizerId;
  const data = await publicJsonFetch(`${origin}/api/links/${encodeURIComponent(parsed.linkId)}/intervals`, {
    method: 'POST',
    body,
    origin,
    referer: pageUrl,
  });
  const starts = [];
  for (const slot of data.slots || []) {
    if (slot.allowance && slot.allowance !== 'open') continue;
    if (slot.startAt) starts.push(new Date(slot.startAt));
  }
  starts.sort((a, b) => a - b);
  return { starts, timeZone: 'America/Chicago' };
}

/**
 * Microsoft Bookings / bookwithme. The public SPA is often blocked from
 * datacenter IPs (417); when the JSON feed answers, use it.
 */
async function fetchPublicMsBookingsStarts(bookingUrl, { fromDate, toDate } = {}) {
  const parsed = parseMsBookingsPublicUrl(bookingUrl);
  if (!parsed) return { starts: [], timeZone: null };
  const from = fromDate || new Date();
  const to = toDate || new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const qs = new URLSearchParams({
    startdt: new Date(from).toISOString(),
    enddt: new Date(to).toISOString(),
  });
  const candidates = [
    `https://outlook.office.com/bookwithme/api/v1.0/users/${encodeURIComponent(parsed.user)}/meetingtypes/${encodeURIComponent(parsed.meetingType)}/availability?${qs}`,
    `https://bookings.cloud.microsoft/bookwithme/api/v1.0/users/${encodeURIComponent(parsed.user)}/meetingtypes/${encodeURIComponent(parsed.meetingType)}/availability?${qs}`,
  ];
  for (const url of candidates) {
    try {
      const data = await publicJsonFetch(url, {
        origin: 'https://bookings.cloud.microsoft',
        referer: String(bookingUrl),
      });
      const starts = [];
      const rows = data.availability || data.value || data.slots || [];
      for (const row of rows) {
        const raw = row.start || row.startDateTime || row.start_time;
        if (raw) starts.push(new Date(raw));
      }
      if (starts.length) {
        starts.sort((a, b) => a - b);
        return { starts, timeZone: 'America/Chicago' };
      }
    } catch {
      // Try the next known public host.
    }
  }
  return { starts: [], timeZone: null };
}

/**
 * Dispatch by the public destination URL Josh stored in BookingBridge.
 * Unknown hosts are treated as SavvyCal custom domains (PowerPSA, etc.).
 */
async function fetchPublicBookingStarts(bookingUrl, range) {
  if (!bookingUrl) return { starts: [], timeZone: null };
  if (isCalendlyUrl(bookingUrl)) return fetchPublicCalendlyStarts(bookingUrl, range);
  if (isHubSpotMeetingsUrl(bookingUrl)) return fetchPublicHubSpotStarts(bookingUrl, range);
  if (isMsBookingsUrl(bookingUrl)) return fetchPublicMsBookingsStarts(bookingUrl, range);
  if (isSavvyCalHost(bookingUrl)) return fetchPublicSavvyCalStarts(bookingUrl, range);
  return fetchPublicSavvyCalStarts(bookingUrl, range);
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
    ? `NO verified free slots were retrieved from the public booking page. Suggest two rough times on the next two business days (skip weekends). ${linkRule}`
    : 'NO verified free slots were retrieved from the public booking page. Suggest two rough times on the next two business days (skip weekends). Do not invent a fake booking URL.';
}

function isLocalBusinessSlot(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return hour >= 9 && hour < 16;
}

async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`calendar check timed out after ${ms}ms`)), ms);
      }),
    ]);
  } catch (err) {
    if (fallback !== undefined) {
      console.warn('[SchedulingSlots] Using empty slots', { err: err.message });
      return fallback;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const calendarStartsCache = new Map();

function cachedCalendarStarts(clientId, fromDate, toDate, limit) {
  const key = `${clientId}|${fromDate.toISOString()}|${toDate.toISOString()}|${limit}`;
  const hit = calendarStartsCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.starts;
  return null;
}

function rememberCalendarStarts(clientId, fromDate, toDate, limit, starts) {
  const key = `${clientId}|${fromDate.toISOString()}|${toDate.toISOString()}|${limit}`;
  calendarStartsCache.set(key, { at: Date.now(), starts });
}

/**
 * Open 30-minute slots with no overlap on the connected Google/Outlook calendar.
 * One free/busy window — no Calendly PAT.
 */
async function fetchCalendarFreeStarts(clientId, fromDate, toDate, { limit = 8, timeZone } = {}) {
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
  const tz = timeZone || process.env.DEFAULT_BOOKING_TIMEZONE || 'America/New_York';

  const found = [];
  for (let t = gridStart.getTime(); t < toDate.getTime() && found.length < max; t += SLOT_MS) {
    const slotStart = new Date(t);
    const slotEnd = new Date(t + SLOT_MS);
    if (!isLocalBusinessSlot(slotStart, tz)) continue;

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
  const { prefersInPersonMeeting } = require('../utils/meeting-modality');
  const inPerson = prefersInPersonMeeting(client && client.voice_prompt);
  const link = prospectBookingLink({
    clientName: client && client.name,
    bookingLink: client && client.booking_link,
  });
  const offset = Math.max(0, Number(options.offset) || 0);
  const count = Math.max(1, Number(options.count) || 2);
  const needed = offset + count;
  let timeZone = process.env.DEFAULT_BOOKING_TIMEZONE || 'America/Chicago';
  // skipExternalFetch = poller / LinkedIn: still look at the public
  // booking page, just with a short timeout. No PAT, no client OAuth.
  const quick = Boolean(options.skipExternalFetch);
  const fromDate = new Date();
  const toDate = new Date(Date.now() + (quick ? 10 : 14) * 24 * 60 * 60 * 1000);
  const limit = Math.max(8, needed);

  const availabilityUrl = await resolveLiveAvailabilityBookingUrl(client).catch(() => '');

  let starts = cachedCalendarStarts(client.id, fromDate, toDate, limit) || [];
  if (!starts.length) {
    try {
      const lookup = async () => {
        const pub = await fetchPublicBookingStarts(availabilityUrl, { fromDate, toDate });
        if (pub.timeZone) timeZone = pub.timeZone;
        return pub.starts || [];
      };
      starts = await withTimeout(lookup(), quick ? 4000 : 8000, []);
      if (starts.length) rememberCalendarStarts(client.id, fromDate, toDate, limit, starts);
    } catch (err) {
      console.warn('[SchedulingSlots] Public booking slots failed', { err: err.message });
      starts = [];
    }
  }

  if (!starts.length && quick) {
    return schedulingPromptBookingLinkOnly(client);
  }

  const picked = pickTwoBusinessDayStarts(starts, {
    timeZone,
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
  pickTwoBusinessDayStarts,
  parseCalendlyPublicUrl,
  parseHubSpotPublicUrl,
  parseMsBookingsPublicUrl,
  parseSavvyCalInertiaPage,
  fetchPublicCalendlyStarts,
  fetchPublicHubSpotStarts,
  fetchPublicSavvyCalStarts,
  fetchPublicBookingStarts,
  isHubSpotMeetingsUrl,
  isMsBookingsUrl,
  slotOffsetForFollowUpStep,
  formatSlotLabel,
  timesPlusLinkPromptBlock,
  isLocalBusinessSlot,
  normalizeBookingUrl,
  isCalendlyUrl,
};
