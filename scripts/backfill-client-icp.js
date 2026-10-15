#!/usr/bin/env node
/**
 * Build ICP profiles for existing clients that have none.
 * Searches Josh's Fireflies transcripts by client name / domain and
 * extracts a fact-grounded ICP (PR #97 rules). Clients with no matching
 * calls are flagged needs_review.
 *
 *   node scripts/backfill-client-icp.js --dry-run
 *   node scripts/backfill-client-icp.js
 *
 * Needs FIREFLIES_API_KEY (and GEMINI_API_KEY to extract). Prints counts only.
 */
const db = require('../src/db');
const { backfillMissingClientIcp } = require('../src/services/client-icp-profile');
const fireflies = require('../src/services/fireflies');

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('--dry');
  if (!fireflies.isConfigured() && !dryRun) {
    console.error(`${fireflies.requiredEnvVar()} is not set — cannot search call transcripts.`);
    process.exit(1);
  }

  const counts = await backfillMissingClientIcp({ db, dryRun });
  console.log('[Backfill] client ICP', counts);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Backfill] client ICP failed', { err: err.message });
    process.exit(1);
  });
