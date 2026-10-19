const calendar = require('./calendar');
const { prospectBookingLink } = require('../utils/public-booking-link');
const {
  resolveLiveAvailabilityBookingUrl,
} = require('../utils/booking-bridge-destinations');

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
  const noInvent =
    'Do NOT invent clock times, dayparts, or fake availability. Never state a meeting time that did not come from the calendar.';

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
      `ONE verified open time: ${lines[0]}. Suggest that time. Do not invent a second clock time. ${linkRule}`
    );
  }
  if (inPerson) {
    return `NO verified free slots were retrieved from the calendar. ${noInvent} Ask what time works to stop by in person. ${linkRule}`;
  }
  return link
    ? `NO verified free slots were retrieved from the public booking page. ${noInvent} Ask what time works for a call. ${linkRule}`
    : `NO verified free slots were retrieved from the public booking page. ${noInvent} Ask what time works for a call. Do not invent a fake booking URL.`;
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

const SLOT_CACHE_TTL_MS = (() => {
  const n = parseInt(process.env.SLOT_CACHE_TTL_MS || '', 10);
  return Number.isFinite(n) && n >= 60_000 ? n : 8 * 60 * 1000;
})();
const SLOT_FETCH_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.SLOT_FETCH_TIMEOUT_MS || '', 10);
  return Number.isFinite(n) && n >= 1000 ? n : 8000;
})();

/** clientId → { at, starts, timeZone } */
const clientSlotCache = new Map();

function readClientSlotCache(clientId) {
  if (!clientId) return null;
  const hit = clientSlotCache.get(String(clientId));
  if (hit && Date.now() - hit.at < SLOT_CACHE_TTL_MS) return hit;
  return null;
}

function writeClientSlotCache(clientId, { starts, timeZone }) {
  if (!clientId) return;
  clientSlotCache.set(String(clientId), {
    at: Date.now(),
    starts: Array.isArray(starts) ? starts : [],
    timeZone: timeZone || null,
  });
}

function cachedCalendarStarts(clientId) {
  const hit = readClientSlotCache(clientId);
  return hit ? hit.starts : null;
}

function rememberCalendarStarts(clientId, starts, timeZone) {
  writeClientSlotCache(clientId, { starts, timeZone });
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
  const { prefersInPersonMeeting, prefersCallbackCall, meetingCta } = require('../utils/meeting-modality');
  const inPerson = prefersInPersonMeeting(client && client.voice_prompt);
  const callback = prefersCallbackCall(client && client.voice_prompt, client && client.name);
  const link = prospectBookingLink({
    clientName: client && client.name,
    bookingLink: client && client.booking_link,
  });
  if (callback) {
    return {
      slots: [],
      promptBlock: meetingCta({
        voicePrompt: client && client.voice_prompt,
        clientName: client && client.name,
      }).timeRule,
    };
  }
  if (inPerson) {
    return {
      slots: [],
      promptBlock:
        'IN-PERSON (no live availability in cache): Do NOT invent clock times. Ask what time works to stop by in person. Do NOT paste a booking URL, Zoom, or phone CTA.',
    };
  }
  return {
    slots: [],
    promptBlock: link
      ? `NO verified calendar times (cache miss / empty). Do NOT invent clock times. Ask what time works for a call, then include this exact booking URL once: ${link}`
      : 'No booking link on this client and no verified calendar times. Do NOT invent clock times or a fake booking URL. Ask what time works for a call.',
  };
}

/**
 * Returns verified open times + human labels for Gemini.
 * @param {object} client - DB client row (booking_link, id, voice_prompt)
 * @param {{ skipExternalFetch?: boolean, offset?: number, count?: number, excludeStarts?: Array<string|Date> }} [options]
 */
async function resolveVerifiedSchedulingSlots(client, options = {}) {
  const { prefersInPersonMeeting, prefersCallbackCall, meetingCta } = require('../utils/meeting-modality');
  const inPerson = prefersInPersonMeeting(client && client.voice_prompt);
  const callback = prefersCallbackCall(client && client.voice_prompt, client && client.name);
  if (callback) {
    return {
      slots: [],
      promptBlock: meetingCta({
        voicePrompt: client && client.voice_prompt,
        clientName: client && client.name,
      }).timeRule,
    };
  }
  const link = prospectBookingLink({
    clientName: client && client.name,
    bookingLink: client && client.booking_link,
  });
  const offset = Math.max(0, Number(options.offset) || 0);
  const count = Math.max(1, Number(options.count) || 2);
  const needed = offset + count;
  let timeZone = process.env.DEFAULT_BOOKING_TIMEZONE || 'America/Chicago';
  const fromDate = new Date();
  const toDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const limit = Math.max(8, needed);
  void limit;

  const cached = readClientSlotCache(client && client.id);
  let starts = cached && Array.isArray(cached.starts) ? cached.starts : [];
  if (cached && cached.timeZone) timeZone = cached.timeZone;

  // skipExternalFetch skips connected-calendar OAuth only. The public
  // booking page still runs (or we use the 5–10 min cache of it).
  if (!cached && !options.cacheOnly) {
    try {
      const availabilityUrl = await resolveLiveAvailabilityBookingUrl(client).catch(() => '');
      const pub = await withTimeout(
        fetchPublicBookingStarts(availabilityUrl, { fromDate, toDate }),
        SLOT_FETCH_TIMEOUT_MS || 8000,
        { starts: [], timeZone: null },
      );
      starts = Array.isArray(pub?.starts) ? pub.starts : [];
      if (pub?.timeZone) timeZone = pub.timeZone;
      writeClientSlotCache(client && client.id, { starts, timeZone });
      if (!starts.length) {
        console.warn('[SchedulingSlots] Empty open times', {
          clientId: client && client.id,
        });
      }
    } catch (err) {
      console.warn('[SchedulingSlots] Public booking slots failed', { err: err.message });
      starts = [];
    }
  }

  if (!starts.length) {
    console.warn('[SchedulingSlots] Empty open times', {
      clientId: client && client.id,
      fromCache: !!cached,
    });
    if (options.skipExternalFetch) {
      return schedulingPromptBookingLinkOnly(client);
    }
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

async function refreshClientSlotCache(client, { fromDate, toDate } = {}) {
  const start = fromDate || new Date();
  const end = toDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  if (!client) {
    return { starts: [], timeZone: null };
  }
  try {
    const lookup = async () => {
      const availabilityUrl = await resolveLiveAvailabilityBookingUrl(client).catch(() => '');
      return fetchPublicBookingStarts(availabilityUrl, { fromDate: start, toDate: end });
    };
    const pub = await withTimeout(lookup(), SLOT_FETCH_TIMEOUT_MS, { starts: [], timeZone: null });
    const starts = Array.isArray(pub?.starts) ? pub.starts : [];
    const timeZone = pub?.timeZone || null;
    if (!starts.length) {
      console.warn('[SchedulingSlots] Empty open times', { clientId: client.id });
    }
    writeClientSlotCache(client.id, { starts, timeZone });
    return { starts, timeZone };
  } catch (err) {
    console.warn('[SchedulingSlots] Cache refresh failed', {
      clientId: client.id, err: err.message,
    });
    writeClientSlotCache(client.id, { starts: [], timeZone: null });
    return { starts: [], timeZone: null };
  }
}

async function refreshAllClientSlotCaches() {
  const db = require('../db');
  let rows = [];
  try {
    const result = await db.query(
      `SELECT id, name, booking_link, booking_destination_url, voice_prompt
         FROM clients
        WHERE active IS DISTINCT FROM false`
    );
    rows = result.rows || [];
  } catch (err) {
    console.error('[SchedulingSlots] Failed to load clients for cache refresh', { err: err.message });
    return { refreshed: 0, errors: 1 };
  }
  const results = await Promise.all(rows.map(async (client) => {
    try {
      const r = await refreshClientSlotCache(client);
      return { clientId: client.id, slots: (r.starts || []).length };
    } catch (err) {
      console.warn('[SchedulingSlots] Per-client cache refresh failed', {
        clientId: client.id, err: err.message,
      });
      return { clientId: client.id, error: err.message };
    }
  }));
  console.log('[SchedulingSlots] Background cache refresh', {
    clients: results.length,
    withSlots: results.filter((r) => r.slots > 0).length,
    empty: results.filter((r) => !r.error && !r.slots).length,
  });
  return { refreshed: results.length, results };
}

module.exports = {
  resolveVerifiedSchedulingSlots,
  schedulingPromptBookingLinkOnly,
  refreshClientSlotCache,
  refreshAllClientSlotCaches,
  readClientSlotCache,
  SLOT_CACHE_TTL_MS,
  SLOT_FETCH_TIMEOUT_MS,
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
