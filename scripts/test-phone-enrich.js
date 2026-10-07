#!/usr/bin/env node
/**
 * Smoke-test phone enrichment via the email-waterfall MCP/HTTP service.
 * Requires EMAIL_WATERFALL_URL (the Railway host that serves /enrich-one).
 *
 * Usage:
 *   EMAIL_WATERFALL_URL=https://<waterfall-host> node scripts/test-phone-enrich.js patrick@vuerobotics.io
 */
const { enrichCellPhone, waterfallBaseUrl } = require('../src/services/phone-enrich');

async function main() {
  const email = process.argv[2] || 'patrick@vuerobotics.io';
  console.log('email-waterfall:', waterfallBaseUrl() || '(EMAIL_WATERFALL_URL unset)');
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
