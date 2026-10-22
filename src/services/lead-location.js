/**
 * The PERSON's location and time zone for reply cards (not company HQ).
 *
 * Sources, in order: fields already on the lead (Smartlead custom fields,
 * HeyReach profile location), then the person-profile lookup (AI Ark
 * reverse lookup / LinkedIn search snippet). Time zone is derived locally
 * from the location text: US state / Canadian province / country / big city.
 * No network here.
 */

const LOCATION_KEYS = [
  'lead_location', 'leadLocation', 'location', 'person_location', 'personLocation',
  'geo', 'geo_location', 'locality',
];
const CITY_KEYS = ['city', 'lead_city', 'person_city'];
const STATE_KEYS = ['state', 'region', 'province', 'lead_state', 'person_state', 'state_code'];
const COUNTRY_KEYS = ['country', 'country_name', 'lead_country', 'person_country', 'country_code'];

const US_STATES = {
  AL: ['alabama', 'America/Chicago'], AK: ['alaska', 'America/Anchorage'],
  AZ: ['arizona', 'America/Phoenix'], AR: ['arkansas', 'America/Chicago'],
  CA: ['california', 'America/Los_Angeles'], CO: ['colorado', 'America/Denver'],
  CT: ['connecticut', 'America/New_York'], DE: ['delaware', 'America/New_York'],
  DC: ['district of columbia', 'America/New_York'], FL: ['florida', 'America/New_York'],
  GA: ['georgia', 'America/New_York'], HI: ['hawaii', 'Pacific/Honolulu'],
  ID: ['idaho', 'America/Boise'], IL: ['illinois', 'America/Chicago'],
  IN: ['indiana', 'America/Indiana/Indianapolis'], IA: ['iowa', 'America/Chicago'],
  KS: ['kansas', 'America/Chicago'], KY: ['kentucky', 'America/New_York'],
  LA: ['louisiana', 'America/Chicago'], ME: ['maine', 'America/New_York'],
  MD: ['maryland', 'America/New_York'], MA: ['massachusetts', 'America/New_York'],
  MI: ['michigan', 'America/Detroit'], MN: ['minnesota', 'America/Chicago'],
  MS: ['mississippi', 'America/Chicago'], MO: ['missouri', 'America/Chicago'],
  MT: ['montana', 'America/Denver'], NE: ['nebraska', 'America/Chicago'],
  NV: ['nevada', 'America/Los_Angeles'], NH: ['new hampshire', 'America/New_York'],
  NJ: ['new jersey', 'America/New_York'], NM: ['new mexico', 'America/Denver'],
  NY: ['new york', 'America/New_York'], NC: ['north carolina', 'America/New_York'],
  ND: ['north dakota', 'America/Chicago'], OH: ['ohio', 'America/New_York'],
  OK: ['oklahoma', 'America/Chicago'], OR: ['oregon', 'America/Los_Angeles'],
  PA: ['pennsylvania', 'America/New_York'], RI: ['rhode island', 'America/New_York'],
  SC: ['south carolina', 'America/New_York'], SD: ['south dakota', 'America/Chicago'],
  TN: ['tennessee', 'America/Chicago'], TX: ['texas', 'America/Chicago'],
  UT: ['utah', 'America/Denver'], VT: ['vermont', 'America/New_York'],
  VA: ['virginia', 'America/New_York'], WA: ['washington', 'America/Los_Angeles'],
  WV: ['west virginia', 'America/New_York'], WI: ['wisconsin', 'America/Chicago'],
  WY: ['wyoming', 'America/Denver'], PR: ['puerto rico', 'America/Puerto_Rico'],
};

const CA_PROVINCES = {
  BC: ['british columbia', 'America/Vancouver'], AB: ['alberta', 'America/Edmonton'],
  SK: ['saskatchewan', 'America/Regina'], MB: ['manitoba', 'America/Winnipeg'],
  ON: ['ontario', 'America/Toronto'], QC: ['quebec', 'America/Toronto'],
  NB: ['new brunswick', 'America/Halifax'], NS: ['nova scotia', 'America/Halifax'],
  PE: ['prince edward island', 'America/Halifax'], NL: ['newfoundland', 'America/St_Johns'],
};

/** Metro names LinkedIn uses without a state ("Greater Boston", "San Francisco Bay Area"). */
const CITY_TZ = [
  [/new york city|nyc|manhattan|brooklyn/, 'America/New_York'],
  [/boston|philadelphia|atlanta|miami|washington dc|d\.c\.|baltimore|pittsburgh|charlotte|orlando|tampa|detroit|cleveland|columbus|cincinnati|raleigh/, 'America/New_York'],
  [/chicago|dallas|houston|austin|san antonio|minneapolis|st\.? louis|kansas city|nashville|new orleans|milwaukee|oklahoma city|memphis/, 'America/Chicago'],
  [/denver|salt lake|albuquerque|boise/, 'America/Denver'],
  [/phoenix|scottsdale|tucson/, 'America/Phoenix'],
  [/los angeles|san francisco|bay area|san diego|seattle|portland|las vegas|sacramento|san jose|silicon valley/, 'America/Los_Angeles'],
  [/toronto|ottawa|montreal/, 'America/Toronto'], [/vancouver/, 'America/Vancouver'],
  [/calgary|edmonton/, 'America/Edmonton'],
  [/london|manchester|birmingham|edinburgh|glasgow/, 'Europe/London'],
  [/dublin/, 'Europe/Dublin'], [/sydney|melbourne/, 'Australia/Sydney'],
];

const COUNTRY_TZ = [
  [/united kingdom|\buk\b|england|scotland|wales|great britain/, 'Europe/London'],
  [/ireland/, 'Europe/Dublin'], [/germany|deutschland/, 'Europe/Berlin'],
  [/france/, 'Europe/Paris'], [/spain/, 'Europe/Madrid'], [/italy/, 'Europe/Rome'],
  [/netherlands/, 'Europe/Amsterdam'], [/belgium/, 'Europe/Brussels'],
  [/switzerland/, 'Europe/Zurich'], [/sweden/, 'Europe/Stockholm'],
  [/denmark/, 'Europe/Copenhagen'], [/norway/, 'Europe/Oslo'], [/poland/, 'Europe/Warsaw'],
  [/portugal/, 'Europe/Lisbon'], [/israel/, 'Asia/Jerusalem'],
  [/united arab emirates|\buae\b|dubai/, 'Asia/Dubai'], [/india/, 'Asia/Kolkata'],
  [/singapore/, 'Asia/Singapore'], [/philippines/, 'Asia/Manila'],
  [/japan/, 'Asia/Tokyo'], [/new zealand/, 'Pacific/Auckland'],
  [/australia/, 'Australia/Sydney'], [/mexico/, 'America/Mexico_City'],
  [/brazil/, 'America/Sao_Paulo'], [/argentina/, 'America/Argentina/Buenos_Aires'],
  [/colombia/, 'America/Bogota'], [/south africa/, 'Africa/Johannesburg'],
];

function str(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    return str(v.default || v.name || v.full || v.formatted || [v.city, v.state, v.country].filter(Boolean).join(', '));
  }
  return String(v).trim();
}

function firstKey(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const s = str(obj[k]);
    if (s && !/^(n\/?a|none|null|unknown|-)$/i.test(s)) return s;
  }
  return '';
}

function customBag(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj.custom_fields || obj.customFields || obj.custom || obj.fields || null;
}

/** Person location text from lead/reply/payload objects. Company HQ keys are ignored. */
function pickLocation(...sources) {
  for (const src of sources) {
    for (const obj of [src, customBag(src)]) {
      const loc = firstKey(obj, LOCATION_KEYS);
      if (loc) return loc.slice(0, 120);
      const parts = [firstKey(obj, CITY_KEYS), firstKey(obj, STATE_KEYS), firstKey(obj, COUNTRY_KEYS)]
        .filter(Boolean);
      if (parts.length && (parts.length > 1 || firstKey(obj, STATE_KEYS) || firstKey(obj, COUNTRY_KEYS))) {
        return parts.join(', ').slice(0, 120);
      }
    }
  }
  return null;
}

function tzFromRegionTable(text, table) {
  const lower = ` ${text.toLowerCase()} `;
  for (const [, [name, tz]] of Object.entries(table)) {
    if (new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`).test(lower)) {
      // "New York" also matches nothing else; "Virginia" must not hit "West Virginia".
      if (name === 'virginia' && /west\s+virginia/.test(lower)) continue;
      if (name === 'washington' && /washington,?\s*d\.?c|\bdc\b/.test(lower)) continue;
      return tz;
    }
  }
  // Two-letter codes only after a comma ("Austin, TX") so words like "in"/"or" never match.
  const codes = text.match(/,\s*([A-Z]{2})\b/g) || [];
  for (const c of codes) {
    const code = c.replace(/[^A-Z]/g, '');
    if (table[code]) return table[code][1];
  }
  return null;
}

/** IANA time zone for a free-text person location, or null. */
function timezoneForLocation(location) {
  const text = str(location);
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [re, tz] of CITY_TZ) if (re.test(lower)) return tz;
  const us = tzFromRegionTable(text, US_STATES);
  if (us) return us;
  const ca = tzFromRegionTable(text, CA_PROVINCES);
  if (ca) return ca;
  for (const [re, tz] of COUNTRY_TZ) if (re.test(lower)) return tz;
  return null;
}

/** "CT (America/Chicago)" style short label for the card. */
function timezoneLabel(tz, now = new Date()) {
  if (!tz) return '';
  try {
    const short = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value;
    return short ? `${short} (${tz})` : tz;
  } catch {
    return '';
  }
}

function resolvePersonLocation(...sources) {
  const location = pickLocation(...sources);
  return { location, timezone: timezoneForLocation(location) };
}

module.exports = {
  pickLocation,
  timezoneForLocation,
  timezoneLabel,
  resolvePersonLocation,
  US_STATES,
};
