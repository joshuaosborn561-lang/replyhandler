/**
 * Prospect enrichment — same vendor order as joshuaosborn561-lang/email-waterfall:
 *   GetLeads → Smartlead (email only, skipped here) → AI Ark → LeadMagic → Prospeo → FullEnrich
 *
 * Slack cards need a cellphone. Default max_tier is fullenrich so Prospeo
 * mobile runs after LeadMagic, matching "use my waterfall … max tier fullenrich".
 * FullEnrich is email-only (HeyReach / missing work email).
 */

const getleads = require('./getleads');
const aiark = require('./aiark');
const leadmagic = require('./leadmagic');
const prospeo = require('./prospeo');
const fullenrich = require('./fullenrich');

const TIER_ORDER = ['getleads', 'smartlead', 'aiark', 'leadmagic', 'prospeo', 'fullenrich'];

function normalizeMaxTier(raw) {
  const s = String(raw || process.env.EMAIL_WATERFALL_MAX_TIER || 'fullenrich')
    .trim()
    .toLowerCase();
  if (s === 'lm') return 'leadmagic';
  if (s === 'fe') return 'fullenrich';
  return TIER_ORDER.includes(s) ? s : 'fullenrich';
}

function allowsTier(maxTier, tier) {
  return TIER_ORDER.indexOf(tier) <= TIER_ORDER.indexOf(normalizeMaxTier(maxTier));
}

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

function splitLeadName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * @param {{ email?: string|null, linkedinUrl?: string|null, leadName?: string|null, companyName?: string|null, maxTier?: string }} input
 */
async function enrichProspect({
  email, linkedinUrl, leadName, companyName, maxTier,
} = {}) {
  let workEmail = String(email || '').trim().toLowerCase() || null;
  let li = String(linkedinUrl || '').trim() || null;
  let phone = null;
  let website = null;
  const sources = {};
  const cap = normalizeMaxTier(maxTier);

  const domainHint = domainFromEmail(workEmail);
  const { firstName, lastName } = splitLeadName(leadName);

  // ── 1) GetLeads ────────────────────────────────────────────────────
  if (allowsTier(cap, 'getleads') && getleads.isConfigured() && workEmail) {
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
  if (allowsTier(cap, 'aiark') && aiark.isConfigured()) {
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
          domain: domainHint,
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
  if (allowsTier(cap, 'leadmagic') && leadmagic.isMobileFinderConfigured() && !phone) {
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

  // ── 4) Prospeo (unlocked when max_tier is prospeo / fullenrich) ─────
  if (allowsTier(cap, 'prospeo') && prospeo.isConfigured() && !phone) {
    try {
      const pr = await prospeo.findMobile({
        firstName,
        lastName,
        fullName: leadName,
        domain: domainHint,
        companyName,
        linkedinUrl: li,
      });
      if (pr.phone) {
        phone = pr.phone;
        sources.phone = 'prospeo';
      }
      if (pr.linkedinUrl && !li) {
        li = pr.linkedinUrl;
        sources.linkedin = sources.linkedin || 'prospeo';
      }
      if (pr.email && !workEmail) {
        workEmail = pr.email;
        sources.email = 'prospeo';
      }
    } catch (err) {
      console.warn('[ProspectEnrich] Prospeo failed', { err: err.message, email: workEmail });
    }
  }

  // ── 5) FullEnrich — work email only (HeyReach / missing inbox email) ─
  if (allowsTier(cap, 'fullenrich') && fullenrich.isConfigured() && !workEmail) {
    try {
      const fe = await fullenrich.findEmail({
        firstName,
        lastName,
        domain: domainHint,
        companyName,
      });
      if (fe.email) {
        workEmail = fe.email;
        sources.email = 'fullenrich';
      }
    } catch (err) {
      console.warn('[ProspectEnrich] FullEnrich failed', { err: err.message });
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
    maxTier: cap,
  };
}

/** @deprecated use enrichProspect — kept for older callers */
async function enrichCellPhone(input) {
  const r = await enrichProspect(input);
  return { phone: r.phone, provider: r.sources.phone || null, linkedinUrl: r.linkedinUrl };
}

module.exports = {
  enrichProspect,
  enrichCellPhone,
  domainFromEmail,
  asWebsite,
  normalizeMaxTier,
  allowsTier,
  TIER_ORDER,
  splitLeadName,
};
