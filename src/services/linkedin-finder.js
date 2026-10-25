/**
 * Find the replying person's LinkedIn URL with several fallbacks, then score
 * it so a wrong profile never gets fed into the phone vendors.
 *
 * Order (cheap first): reply / cache URL -> GetLeads by work email ->
 * AI Ark reverse lookup by email + Serper Google search by name + company
 * (person-profile-lookup). Each candidate is scored on name, company/domain,
 * title and location. Below LINKEDIN_THRESHOLD -> confidence 'review' and
 * the URL is NOT used for phone lookups.
 *
 * Never logs lead rows or key values.
 */

const getleads = require('./getleads');
const { lookupPersonProfile, cleanLinkedin } = require('./person-profile-lookup');
const { domainFromEmail, CONSUMER_DOMAINS } = require('./prospect-enrich');

const LINKEDIN_THRESHOLD = 0.7;

function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

function slugOf(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

/**
 * 0..1. Name 50% (hard gate), company/domain 30%, title 10%, location 10%.
 * Missing candidate fields are left out of the weight.
 */
function scoreCandidate(lead, cand) {
  const parts = [];
  const want = tokens(lead.leadName);
  const candName = tokens(cand.fullName || '').concat(tokens(slugOf(cand.linkedinUrl)));
  const got = new Set(candName);
  let nameScore = 0;
  if (want.length) {
    const first = want[0];
    const last = want.length > 1 ? want[want.length - 1] : null;
    const slug = slugOf(cand.linkedinUrl).replace(/[^a-z]/g, '');
    const has = (t) => got.has(t) || slug.includes(t);
    if (has(first) && (!last || has(last))) nameScore = 1;
    else if (last && has(last)) nameScore = 0.5;
    else if (has(first)) nameScore = 0.4;
  }
  parts.push([nameScore, 0.5]);
  const domainRoot = String(lead.domain || '').split('.')[0].toLowerCase();
  const companyToks = tokens(lead.companyName);
  const blob = `${cand.title || ''} ${cand.company || ''} ${cand.headline || ''}`.toLowerCase();
  if (blob.trim() && (domainRoot || companyToks.length)) {
    const squashed = blob.replace(/[^a-z0-9]/g, '');
    let c = 0;
    if (domainRoot && domainRoot.length > 2 && squashed.includes(domainRoot)) c = 1;
    else if (companyToks.length) {
      const hit = companyToks.filter((t) => blob.includes(t)).length;
      c = hit / companyToks.length;
    }
    parts.push([c, 0.3]);
  } else if (cand.verifiedByEmail) {
    // Vendor matched the work email to this profile.
    parts.push([1, 0.3]);
  }
  if (lead.title && cand.title) {
    const lt = tokens(lead.title);
    const ct = new Set(tokens(cand.title));
    parts.push([lt.length ? lt.filter((t) => ct.has(t)).length / lt.length : 0, 0.1]);
  }
  if (lead.location && cand.location) {
    const a = String(lead.location).toLowerCase();
    const b = String(cand.location).toLowerCase();
    parts.push([a.includes(b) || b.includes(a) ? 1 : 0, 0.1]);
  }
  const w = parts.reduce((s, [, x]) => s + x, 0);
  let score = w ? parts.reduce((s, [v, x]) => s + v * x, 0) / w : 0;
  if (nameScore < 0.6) score = Math.min(score, 0.5);
  if (parts.length === 1) score = Math.min(score, 0.6); // name-only never enough
  return Number(score.toFixed(3));
}

function confidenceFor(score) {
  if (score >= 0.85) return 'high';
  if (score >= LINKEDIN_THRESHOLD) return 'medium';
  return 'review';
}

/**
 * @returns {Promise<{linkedinUrl:string|null, confidence:string, score:number,
 *   source:string|null, title:string|null, location:string|null, tried:string[]}>}
 */
async function findLinkedin({
  leadName, email, companyName, domain, title, location, linkedinUrl,
} = {}, { getleadsApi = getleads, profileLookup = lookupPersonProfile } = {}) {
  const workEmail = String(email || '').trim().toLowerCase();
  const dom = String(domain || '').trim().toLowerCase() || domainFromEmail(workEmail) || '';
  const lead = {
    leadName, companyName, domain: CONSUMER_DOMAINS.test(dom) ? '' : dom, title, location,
  };
  const tried = [];
  const cands = [];
  const push = (c) => {
    const url = cleanLinkedin(c.linkedinUrl);
    if (!url) return;
    if (cands.some((x) => slugOf(x.linkedinUrl) === slugOf(url))) return;
    cands.push({ ...c, linkedinUrl: url });
  };

  if (linkedinUrl) {
    tried.push('input');
    push({ linkedinUrl, source: 'input', fullName: leadName, title, verifiedByEmail: true });
  }
  if (workEmail && getleadsApi?.isConfigured?.()) {
    tried.push('getleads');
    try {
      const url = await getleadsApi.linkedinFromEmail(workEmail);
      if (url) push({ linkedinUrl: url, source: 'getleads', verifiedByEmail: true });
    } catch (err) { void err; }
  }
  const good = () => cands.some((c) => scoreCandidate(lead, c) >= LINKEDIN_THRESHOLD);
  if (!good()) {
    tried.push('aiark+serper');
    try {
      const prof = await profileLookup({
        email: workEmail, leadName, companyName: companyName || lead.domain, title, location,
      });
      if (prof?.linkedinUrl) {
        push({
          linkedinUrl: prof.linkedinUrl,
          source: prof.sources?.linkedin || 'profile',
          fullName: prof.fullName || leadName,
          title: prof.title,
          location: prof.location,
          verifiedByEmail: prof.sources?.linkedin === 'aiark',
        });
      }
    } catch (err) { void err; }
  }

  let best = null;
  for (const c of cands) {
    const s = scoreCandidate(lead, c);
    if (!best || s > best.score) best = { ...c, score: s };
  }
  if (!best) {
    return { linkedinUrl: null, confidence: 'review', score: 0, source: null, title: null, location: null, tried };
  }
  return {
    linkedinUrl: best.linkedinUrl,
    confidence: confidenceFor(best.score),
    score: best.score,
    source: best.source,
    title: best.title || null,
    location: best.location || null,
    tried,
  };
}

module.exports = { findLinkedin, scoreCandidate, confidenceFor, LINKEDIN_THRESHOLD };
