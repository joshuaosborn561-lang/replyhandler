/**
 * Waterfall cellphone enrichment for client forwards.
 * 1) GetLeads contact search by email
 * 2) LeadMagic mobile-finder (work_email + optional LinkedIn)
 */

const getleads = require('./getleads');
const leadmagic = require('./leadmagic');

/**
 * @param {{ email?: string|null, linkedinUrl?: string|null, leadName?: string|null }} input
 * @returns {Promise<{ phone: string|null, provider: string|null, linkedinUrl: string|null }>}
 */
async function enrichCellPhone({ email, linkedinUrl, leadName } = {}) {
  const workEmail = String(email || '').trim().toLowerCase();
  let li = String(linkedinUrl || '').trim() || null;
  void leadName;

  // 1) GetLeads
  if (getleads.isConfigured() && workEmail) {
    try {
      const gl = await getleads.findPhoneByEmail(workEmail);
      if (gl.linkedinUrl && !li) li = gl.linkedinUrl;
      if (gl.phone) {
        return { phone: gl.phone, provider: 'getleads', linkedinUrl: li };
      }
      if (!li) {
        li = await getleads.linkedinFromEmail(workEmail);
      }
    } catch (err) {
      console.warn('[PhoneEnrich] GetLeads failed — falling through to LeadMagic', {
        err: err.message,
        email: workEmail,
      });
    }
  }

  // 2) LeadMagic
  if (leadmagic.isMobileFinderConfigured()) {
    try {
      const lm = await leadmagic.findMobile({
        workEmail: workEmail || null,
        profileUrl: li,
      });
      if (lm.phone) {
        return { phone: lm.phone, provider: 'leadmagic', linkedinUrl: li };
      }
    } catch (err) {
      console.warn('[PhoneEnrich] LeadMagic failed', { err: err.message, email: workEmail });
    }
  }

  return { phone: null, provider: null, linkedinUrl: li };
}

module.exports = { enrichCellPhone };
