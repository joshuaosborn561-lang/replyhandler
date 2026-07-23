/**
 * Full prospect enrichment for client notify emails.
 * Waterfall: GetLeads → AI Ark → LeadMagic
 * Fields: email, cellphone, LinkedIn, website
 */

const getleads = require('./getleads');
const aiark = require('./aiark');
const leadmagic = require('./leadmagic');

function domainFromEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return null;
  return e.slice(at + 1) || null;
}

function asWebsite(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.includes('.') && !s.includes(' ')) return `https://${s}`;
  return null;
}

/**
 * @param {{ email?: string|null, linkedinUrl?: string|null, leadName?: string|null, companyName?: string|null }} input
 */
async function enrichProspect({ email, linkedinUrl, leadName, companyName } = {}) {
  let workEmail = String(email || '').trim().toLowerCase() || null;
  let li = String(linkedinUrl || '').trim() || null;
  let phone = null;
  let website = null;
  const sources = {};

  const domainHint = domainFromEmail(workEmail);

  // ── 1) GetLeads ────────────────────────────────────────────────────
  if (getleads.isConfigured() && workEmail) {
    try {
      const gl = await getleads.findPhoneByEmail(workEmail);
      if (gl.phone && !phone) {
        phone = gl.phone;
        sources.phone = 'getleads';
      }
      if (gl.linkedinUrl && !li) {
        li = gl.linkedinUrl;
        sources.linkedin = 'getleads';
      }
      if (gl.website && !website) {
        website = asWebsite(gl.website);
        sources.website = 'getleads';
      }
      if (!li) {
        const fromEmail = await getleads.linkedinFromEmail(workEmail);
        if (fromEmail) {
          li = fromEmail;
          sources.linkedin = sources.linkedin || 'getleads';
        }
      }
    } catch (err) {
      console.warn('[ProspectEnrich] GetLeads failed', { err: err.message, email: workEmail });
    }
  }

  // ── 2) AI Ark ──────────────────────────────────────────────────────
  if (aiark.isConfigured()) {
    try {
      if (workEmail && (!li || !website)) {
        const rev = await aiark.reverseLookupByEmail(workEmail);
        if (rev.linkedinUrl && !li) {
          li = rev.linkedinUrl;
          sources.linkedin = 'aiark';
        }
        if (rev.website && !website) {
          website = asWebsite(rev.website);
          sources.website = 'aiark';
        }
      }
      if (!phone) {
        const mob = await aiark.findMobile({
          linkedinUrl: li,
          name: leadName,
          domain: domainHint || (companyName ? null : null),
        });
        if (mob.phone) {
          phone = mob.phone;
          sources.phone = 'aiark';
        }
        if (mob.linkedinUrl && !li) {
          li = mob.linkedinUrl;
          sources.linkedin = sources.linkedin || 'aiark';
        }
      }
    } catch (err) {
      console.warn('[ProspectEnrich] AI Ark failed', { err: err.message, email: workEmail });
    }
  }

  // ── 3) LeadMagic ───────────────────────────────────────────────────
  if (leadmagic.isMobileFinderConfigured() && !phone) {
    try {
      const lm = await leadmagic.findMobile({
        workEmail,
        profileUrl: li,
      });
      if (lm.phone) {
        phone = lm.phone;
        sources.phone = 'leadmagic';
      }
    } catch (err) {
      console.warn('[ProspectEnrich] LeadMagic failed', { err: err.message, email: workEmail });
    }
  }

  if (!website && domainHint && !/gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com/i.test(domainHint)) {
    website = `https://${domainHint}`;
    sources.website = sources.website || 'email_domain';
  }

  if (workEmail) sources.email = sources.email || 'reply';

  return {
    email: workEmail,
    phone,
    linkedinUrl: li,
    website,
    sources,
  };
}

/** @deprecated use enrichProspect — kept for older callers */
async function enrichCellPhone(input) {
  const r = await enrichProspect(input);
  return { phone: r.phone, provider: r.sources.phone || null, linkedinUrl: r.linkedinUrl };
}

module.exports = { enrichProspect, enrichCellPhone, domainFromEmail, asWebsite };
