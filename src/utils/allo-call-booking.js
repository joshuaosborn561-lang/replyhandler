/**
 * Did this Allo call book a meeting, and what should we capture from it?
 *
 * Confirmed: the call carries a "Meeting Booked" tag (tag.added or tags on
 * call.completed). Likely: summary/transcript reads like a booking, but no
 * tag — labeled on the Slack card and kept out of confirmed recap counts.
 */

const { looksLikeAlreadyBooked, looksLikeProposedTime } = require('./booking-signals');
const { phoneKey } = require('../services/allo');

const MEETING_BOOKED_TAG = /^meeting[\s_-]*booked$/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TIME_RE = /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nes(?:day)?)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:ur(?:day)?)?|sun(?:day)?)\b(?:[^\n,.]{0,24})?(?:(?:1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(?:am|pm)|noon|morning|afternoon|evening)/gi;
const SALESGLIDER_CALENDLY =
  'https://calendly.com/joshua-salesglidergrowth/30min';

function tagStrings(call = {}, extraTag = null) {
  const out = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) out.push(s);
      return;
    }
    if (typeof v === 'object') {
      for (const k of ['tag_name', 'name', 'tag_key', 'key', 'label']) {
        if (v[k]) push(v[k]);
      }
    }
  };
  push(call.tag);
  push(extraTag);
  if (Array.isArray(call.tags)) call.tags.forEach(push);
  return [...new Set(out)];
}

function hasMeetingBookedTag(call = {}, extraTag = null) {
  return tagStrings(call, extraTag).some((t) => MEETING_BOOKED_TAG.test(t));
}

function transcriptBlob(call = {}) {
  const turns = Array.isArray(call.transcript)
    ? call.transcript
    : Array.isArray(call.transcriptions)
      ? call.transcriptions
      : [];
  const lines = turns
    .map((t) => String(t?.text || '').trim())
    .filter(Boolean);
  return [
    String(call.summary || '').trim(),
    String(call.concatenated_transcript || '').trim(),
    ...lines,
  ].filter(Boolean).join('\n');
}

function extractEmails(text, call = {}) {
  const found = [];
  const push = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (s.includes('@') && !found.includes(s)) found.push(s);
  };
  push(call.person?.email);
  for (const e of call.person?.emails || []) push(e);
  const extracted = call.extracted_data?.contact?.emails
    || call.extracted_data?.emails
    || [];
  for (const e of extracted) push(e);
  const data = call.data_collected && typeof call.data_collected === 'object'
    ? call.data_collected
    : {};
  push(data.email || data.lead_email);
  const matches = String(text || '').match(EMAIL_RE) || [];
  for (const m of matches) push(m);
  return found;
}

function extractProposedTimes(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const found = [];
  const re = new RegExp(TIME_RE);
  let m;
  while ((m = re.exec(s))) {
    const t = m[0].replace(/\s+/g, ' ').trim();
    if (t && !found.some((x) => x.toLowerCase() === t.toLowerCase())) found.push(t);
    if (found.length >= 6) break;
  }
  return found;
}

function prospectNameFromCall(call = {}, text = '') {
  const person = call.person && typeof call.person === 'object' ? call.person : {};
  const extracted = call.extracted_data?.contact || {};
  const first = [person.name, person.first_name, extracted.name]
    .map((v) => String(v || '').trim())
    .find(Boolean);
  const last = String(person.last_name || '').trim();
  if (first && last && !/\s/.test(first)) return `${first} ${last}`.trim();
  if (first) return first;

  const type = String(call.type || call.direction || '').toUpperCase();
  const otherName = type === 'OUTBOUND'
    ? (call.to_name || call.contact_name)
    : (call.from_name || call.contact_name);
  const named = String(otherName || '').trim();
  if (named && !phoneKey(named)) return named;

  const m = String(text || '').match(/\b(?:this is|my name is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  return m ? m[1] : '';
}

function isPlaceholderProspect({ name, email, text } = {}) {
  const n = String(name || '').trim();
  const e = String(email || '').trim();
  const s = String(text || '').toLowerCase();
  if (/placeholder|not a real (person|prospect)|fake lead|test(?:ing)? (?:call|lead)/i.test(s)) {
    return true;
  }
  if (!n && !e) return true;
  if (n && phoneKey(n) && phoneKey(n) === n.replace(/\D/g, '').slice(-10) && !e) return true;
  return false;
}

function likelyBookedFromText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return looksLikeAlreadyBooked(s) || looksLikeProposedTime(s);
}

/**
 * @returns {{
 *   booked: boolean,
 *   confidence: 'confirmed'|'likely'|null,
 *   tags: string[],
 *   name: string,
 *   email: string,
 *   emails: string[],
 *   proposedTimes: string[],
 *   prospectKind: 'interested'|'placeholder',
 *   summary: string,
 * }}
 */
function inspectCallBooking(call = {}, { extraTag } = {}) {
  const tags = tagStrings(call, extraTag);
  const text = transcriptBlob(call);
  const emails = extractEmails(text, call);
  const email = emails[0] || '';
  const name = prospectNameFromCall(call, text);
  const proposedTimes = extractProposedTimes(text);
  const confirmed = hasMeetingBookedTag(call, extraTag);
  const likely = !confirmed && likelyBookedFromText(text);
  const prospectKind = isPlaceholderProspect({ name, email, text })
    ? 'placeholder'
    : 'interested';

  return {
    booked: confirmed || likely,
    confidence: confirmed ? 'confirmed' : (likely ? 'likely' : null),
    tags,
    name: name || '',
    email,
    emails,
    proposedTimes,
    prospectKind,
    summary: String(call.summary || '').trim(),
    text,
  };
}

function salesgliderCalendlyUrl(env = process.env) {
  const fromEnv = String(env.SALESGLIDER_CALENDLY_URL || '').trim();
  return fromEnv || SALESGLIDER_CALENDLY;
}

function isManualBookClient(clientName, env = process.env) {
  const n = String(clientName || '').toLowerCase();
  if (/mesa\s*energy/.test(n)) return true;
  if (/deep\s*roots/.test(n)) return true;
  const extra = String(env.ALLO_MANUAL_BOOK_CLIENTS || '')
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return extra.some((x) => x && n.includes(x));
}

function isSalesGliderClient(clientName) {
  return /sales\s*glider/i.test(String(clientName || ''));
}

module.exports = {
  MEETING_BOOKED_TAG,
  SALESGLIDER_CALENDLY,
  tagStrings,
  hasMeetingBookedTag,
  transcriptBlob,
  extractEmails,
  extractProposedTimes,
  prospectNameFromCall,
  isPlaceholderProspect,
  likelyBookedFromText,
  inspectCallBooking,
  salesgliderCalendlyUrl,
  isManualBookClient,
  isSalesGliderClient,
};
