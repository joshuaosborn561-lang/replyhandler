#!/usr/bin/env node
/**
 * Re-classify suppressed replies from the last N days and Slack-card
 * mixed-intent / QUESTION rows. dry-run is the default. Prints counts only.
 *
 *   node scripts/resurface-suppressed.js
 *   node scripts/resurface-suppressed.js --days 3
 *   node scripts/resurface-suppressed.js --apply
 */
const { resurfaceSuppressedReplies, parseDays } = require('../src/services/resurface-suppressed');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] || null;
}

async function main() {
  const apply = process.argv.includes('--apply') || process.argv.includes('--live');
  const dryRun = !apply;
  const days = parseDays(argValue('--days'));
  const counts = await resurfaceSuppressedReplies({ days, dryRun });
  console.log('[Resurface] suppressed replies', counts);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Resurface] failed', { err: err.message });
    process.exit(1);
  });
