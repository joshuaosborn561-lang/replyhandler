'use strict';

/**
 * Who actually booked, asked of the scheduler itself.
 *
 * The booking page reports a booking the moment the browser says it is done, and that browser event never
 * carries the booker's name (TidyCal sends only ids and times, Calendly only URIs). The name arrives later on
 * the scheduler's webhook, after the "Meeting booked" brief has already been built. So the brief asks the
 * scheduler's API for the booking:
 *
 *   TidyCal   GET /api/bookings/{id}                        needs TIDYCAL_API_TOKEN (already set for open times)
 *   Calendly  GET <invitee uri>                              needs CALENDLY_API_TOKEN (inert without it)
 *
 * Every step is best effort with its own timeout. A scheduler we have no API for (SavvyCal, Microsoft
 * Bookings, ...) returns null and the brief falls back to the email address, as before.
 *
 * Safety: when the booking payload already names an email, the scheduler's answer must be for that same
 * email. A mismatch returns null, so a brief never takes another person's name.
 */

const TIDYCAL_API = 'https://tidycal.com/api';
const CALENDLY_HOST = /^https:\/\/api\.calendly\.com\//i;
const COMPANY_QUESTION = /\b(company|organi[sz]ation|business|firm|employer)\b/i;
const TITLE_QUESTION = /\b(job\s*title|title|role|position)\b/i;
const PHONE_QUESTION = /\b(phone|mobile|cell|text)\b/i;

function str(v, max = 300) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function sameEmail(a, b) {
  const x = str(a, 320).toLowerCase();
  const y = str(b, 320).toLowerCase();
  return !x || !y || x === y;
}

/** Pull company / title / phone out of a booking form's free-text questions. First match wins. */
function answersFrom(list) {
  const out = { company: '', title: '', phone: '', answers: [] };
  for (const q of Array.isArray(list) ? list : []) {
    const question = str(q && (q.question || q.name), 300);
    const answer = str(q && (q.answer || q.value), 500);
    if (!question || !answer) continue;
    out.answers.push({ question, answer });
    if (!out.company && COMPANY_QUESTION.test(question)) out.company = answer;
    else if (!out.title && TITLE_QUESTION.test(question)) out.title = answer;
    else if (!out.phone && PHONE_QUESTION.test(question) && /\d{7,}/.test(answer.replace(/\D/g, ''))) out.phone = answer;
  }
  return out;
}

async function getJson(url, headers, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`scheduler API ${res.status}`);
  return res.json();
}

async function fromTidyCal({ bookingId, email }, { env, fetchImpl, timeoutMs }) {
  const token = String(env.TIDYCAL_API_TOKEN || '').trim(); // a personal access token is a long JWT: never truncate it
  const id = str(bookingId, 40);
  if (!token || !/^\d+$/.test(id)) return null;
  const raw = await getJson(`${TIDYCAL_API}/bookings/${id}`, { Authorization: `Bearer ${token}`, Accept: 'application/json' }, { fetchImpl, timeoutMs });
  const b = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const contact = (b && b.contact) || {};
  if (!sameEmail(email, contact.email)) return null;
  const a = answersFrom(b && b.questions);
  return {
    source: 'tidycal_api',
    name: str(contact.name, 200),
    email: str(contact.email, 320).toLowerCase(),
    company: a.company,
    title: a.title,
    phone: a.phone,
    startsAt: str(b && b.starts_at, 60),
    endsAt: str(b && b.ends_at, 60),
    answers: a.answers,
  };
}

async function fromCalendly({ inviteeUri, email }, { env, fetchImpl, timeoutMs }) {
  const token = String(env.CALENDLY_API_TOKEN || '').trim();
  const uri = str(inviteeUri, 500);
  if (!token || !CALENDLY_HOST.test(uri)) return null;
  const raw = await getJson(uri, { Authorization: `Bearer ${token}`, Accept: 'application/json' }, { fetchImpl, timeoutMs });
  const r = (raw && raw.resource) || {};
  if (!sameEmail(email, r.email)) return null;
  const a = answersFrom(r.questions_and_answers);
  const name = str(r.name, 200) || [r.first_name, r.last_name].map((x) => str(x, 100)).filter(Boolean).join(' ');
  return {
    source: 'calendly_api',
    name,
    email: str(r.email, 320).toLowerCase(),
    company: a.company,
    title: a.title,
    phone: a.phone,
    startsAt: '',
    endsAt: '',
    answers: a.answers,
  };
}

/**
 * @param {{platform:string, bookingId?:string, inviteeUri?:string, email?:string}} ref
 * @returns {Promise<null|{source,name,email,company,title,phone,startsAt,endsAt,answers}>} never throws
 */
async function resolveSchedulerContact(ref, deps = {}) {
  const ctx = { env: deps.env || process.env, fetchImpl: deps.fetchImpl || fetch, timeoutMs: deps.timeoutMs || 8000 };
  const platform = str(ref && ref.platform, 40).toLowerCase();
  try {
    let hit = null;
    if (platform === 'tidycal') hit = await fromTidyCal(ref, ctx);
    else if (platform === 'calendly') hit = await fromCalendly(ref, ctx);
    return hit && (hit.name || hit.company || hit.title || hit.phone) ? hit : null;
  } catch (err) {
    console.warn('[SchedulerContact] lookup skipped', { platform, err: String(err && err.message || err).slice(0, 200) });
    return null;
  }
}

module.exports = { resolveSchedulerContact, answersFrom, sameEmail };
