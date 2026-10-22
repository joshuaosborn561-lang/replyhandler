/**
 * Person profile lookup for reply cards: full name, LinkedIn, and the
 * PERSON's location (not company HQ). Runs after the email-waterfall
 * enrich (which returns no location).
 *
 * Order: AI Ark reverse lookup by work email (paid, approved by Josh
 * Oct 21) → Serper Google search of LinkedIn profiles by name + company
 * (snippet carries "Location: …"). Never logs lead rows or key values.
 */

const aiark = require('./aiark');
const { pickLocation, timezoneForLocation } = require('./lead-location');
const { domainFromEmail, CONSUMER_DOMAINS } = require('./prospect-enrich');

const SERPER_TIMEOUT_MS = 8000;

function serperKey(env = process.env) {
  return String(env.SERPER_API_KEY || env.SERPER_KEY || '').trim();
}

function cleanLinkedin(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/https?:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^/?#\s]+/i);
  if (m) return m[0].replace(/^http:/i, 'https:');
  if (/linkedin\.com\/in\//i.test(s)) return `https://${s.replace(/^\/+/, '')}`;
  return null;
}

function nameFromProfile(p = {}) {
  const full = String(p.full_name || p.fullName || p.name || '').trim();
  if (full) return full;
  return [p.first_name || p.firstName, p.last_name || p.lastName].filter(Boolean).join(' ').trim();
}

/** Pull name / LinkedIn / location from an AI Ark reverse-lookup body (shape varies). */
function parseAiArkPerson(data) {
  if (!data || typeof data !== 'object') return {};
  const person = data.profile || data.data || data;
  const link = data.link || person.link || {};
  const linkedinUrl = cleanLinkedin(link.linkedin || data.linkedin || person.linkedin || person.linkedin_url);
  const location = pickLocation(person, data, person.location && typeof person.location === 'object' ? person.location : null);
  const rawTitle = person.title || person.job_title || person.jobTitle || person.headline
    || data.title || data.job_title || data.headline || '';
  return {
    fullName: nameFromProfile(person) || nameFromProfile(data) || null,
    linkedinUrl,
    location: location || null,
    title: typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 120) : null,
  };
}

/** Parse a Google result for a LinkedIn profile: URL, name from title, location from snippet. */
function parseLinkedinSearchResult(item = {}) {
  const linkedinUrl = cleanLinkedin(item.link);
  if (!linkedinUrl) return null;
  const title = String(item.title || '');
  const fullName = title.split(/\s[-–|]\s/)[0].trim() || null;
  const snippet = String(item.snippet || '');
  const attrs = item.attributes || {};
  let location = String(attrs.Location || attrs.location || '').trim();
  if (!location) {
    const m = snippet.match(/Location:\s*([^·\n]+?)(?:\s*·|\.\s|$)/i);
    if (m) location = m[1].trim();
  }
  const { titleFromLinkedinHeadline } = require('./decision-maker');
  return { linkedinUrl, fullName, location: location || null, title: titleFromLinkedinHeadline(title) };
}

function nameTokens(name) {
  return String(name || '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 1);
}

/** Accept a search hit only when the title carries the lead's first name (and last, when known). */
function matchesLead(hit, leadName) {
  const want = nameTokens(leadName);
  if (!want.length) return false;
  const got = new Set(nameTokens(hit.fullName));
  return want.slice(0, 2).every((t) => got.has(t));
}

async function serperLinkedinSearch({ leadName, companyName, domain }, { fetchImpl = fetch, env = process.env } = {}) {
  const key = serperKey(env);
  if (!key || !nameTokens(leadName).length) return null;
  const company = String(companyName || '').trim() || String(domain || '').split('.')[0];
  const q = `site:linkedin.com/in "${String(leadName).trim()}"${company ? ` "${company}"` : ''}`;
  const res = await fetchImpl('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num: 5 }),
    signal: AbortSignal.timeout(SERPER_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  for (const item of body?.organic || []) {
    const hit = parseLinkedinSearchResult(item);
    if (hit && matchesLead(hit, leadName)) return { ...hit, source: 'serper' };
  }
  return null;
}

/**
 * @returns {Promise<{fullName:string|null, linkedinUrl:string|null, location:string|null,
 *   timezone:string|null, sources:object}>}
 */
async function lookupPersonProfile({
  email, leadName, companyName, linkedinUrl, location, title,
} = {}, {
  aiarkApi = aiark, fetchImpl = fetch, env = process.env,
} = {}) {
  const out = {
    fullName: null,
    linkedinUrl: cleanLinkedin(linkedinUrl),
    location: location || null,
    title: title || null,
    sources: {},
  };
  const workEmail = String(email || '').trim().toLowerCase();
  const domain = domainFromEmail(workEmail);
  const needMore = () => !out.linkedinUrl || !out.location || !out.title
    || nameTokens(out.fullName || leadName).length < 2;

  if (workEmail && needMore() && aiarkApi?.isConfigured?.()) {
    try {
      const raw = await aiarkApi.reverseLookupByEmail(workEmail);
      const p = raw && raw.rawBody ? parseAiArkPerson(raw.rawBody) : parseAiArkPerson(raw);
      const li = p.linkedinUrl || cleanLinkedin(raw?.linkedinUrl);
      if (!out.linkedinUrl && li) { out.linkedinUrl = li; out.sources.linkedin = 'aiark'; }
      if (!out.location && p.location) { out.location = p.location; out.sources.location = 'aiark'; }
      const fn = p.fullName || raw?.rawName || null;
      if (fn) { out.fullName = fn; out.sources.name = 'aiark'; }
      if (!out.title && p.title) { out.title = p.title; out.sources.title = 'aiark'; }
    } catch (err) {
      console.warn('[PersonProfile] AI Ark lookup failed', { err: err.message });
    }
  }

  if (needMore() && (!domain || !CONSUMER_DOMAINS.test(domain) || companyName)) {
    try {
      const hit = await serperLinkedinSearch({
        leadName: out.fullName || leadName, companyName, domain,
      }, { fetchImpl, env });
      if (hit) {
        const sameProfile = !out.linkedinUrl
          || out.linkedinUrl.replace(/\/$/, '').toLowerCase().endsWith(hit.linkedinUrl.split('/in/')[1]?.replace(/\/$/, '').toLowerCase() || '\u0000');
        if (!out.linkedinUrl) { out.linkedinUrl = hit.linkedinUrl; out.sources.linkedin = 'serper'; }
        if (sameProfile && !out.location && hit.location) { out.location = hit.location; out.sources.location = 'serper'; }
        if (sameProfile && !out.fullName && hit.fullName) { out.fullName = hit.fullName; out.sources.name = 'serper'; }
        if (sameProfile && !out.title && hit.title) { out.title = hit.title; out.sources.title = 'serper'; }
      }
    } catch (err) {
      console.warn('[PersonProfile] Serper lookup failed', { err: err.message });
    }
  }

  return { ...out, timezone: timezoneForLocation(out.location) };
}

module.exports = {
  lookupPersonProfile,
  parseAiArkPerson,
  parseLinkedinSearchResult,
  matchesLead,
  cleanLinkedin,
  serperLinkedinSearch,
};
