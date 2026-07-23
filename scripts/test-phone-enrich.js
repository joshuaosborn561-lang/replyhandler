#!/usr/bin/env node
/**
 * Smoke-test phone enrichment waterfall (GetLeads → LeadMagic).
 * Requires GETLEADS_API_KEY and/or LEADMAGIC_API_KEY in env.
 *
 * Usage:
 *   GETLEADS_API_KEY=... LEADMAGIC_API_KEY=... node scripts/test-phone-enrich.js patrick@vuerobotics.io
 */
const { enrichCellPhone } = require('../src/services/phone-enrich');
const getleads = require('../src/services/getleads');
const leadmagic = require('../src/services/leadmagic');

async function main() {
  const email = process.argv[2] || 'patrick@vuerobotics.io';
  console.log('getleads configured:', getleads.isConfigured());
  console.log('leadmagic configured:', leadmagic.isMobileFinderConfigured());
  const result = await enrichCellPhone({ email });
  console.log(JSON.stringify(result, null, 2));
  if (!result.phone) {
    console.warn('No phone found (may be expected for some emails)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
