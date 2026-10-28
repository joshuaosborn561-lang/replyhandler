#!/usr/bin/env node
/**
 * Hand-enrol leads into Day-30 nurture from a JSON file (an array of lead objects, see
 * src/services/nurture-manual-enrol.js). Dry run by default: it validates every lead against the
 * database (read-only session) and writes nothing.
 *
 *   node scripts/nurture-manual-enrol.js --file drafts.json --client <client uuid>             # dry run
 *   node scripts/nurture-manual-enrol.js --file drafts.json --client <client uuid> --apply     # writes nurture_leads rows
 *   --allow-partial   with --apply, enrol the clean leads even if others have problems
 *   --json            print the full result as JSON
 *
 * Needs DATABASE_URL. --apply also needs the client in NURTURE_CLIENT_IDS. It never posts to Slack,
 * never sends email and never touches HubSpot; the nurture flags and the Approve click decide that.
 */
const fs = require('fs');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(name);

async function main() {
  const file = arg('--file');
  const clientId = arg('--client');
  const apply = has('--apply');
  if (!file || !clientId) {
    console.error('usage: nurture-manual-enrol.js --file <json> --client <uuid> [--apply] [--allow-partial] [--json]');
    process.exit(2);
  }
  // A dry run must not be able to write, whatever the code does: ask Postgres for read-only sessions.
  if (!apply) process.env.PGOPTIONS = `${process.env.PGOPTIONS || ''} -c default_transaction_read_only=on`.trim();

  const leads = JSON.parse(fs.readFileSync(file, 'utf8'));
  const db = require('../src/db');
  const { enrolManual } = require('../src/services/nurture-manual-enrol');
  const out = await enrolManual({ clientId, leads, apply, allowPartial: has('--allow-partial') });
  if (has('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(apply ? 'APPLY' : 'DRY RUN: nothing was written');
    if (out.error) console.log(`error: ${out.error}`);
    if (out.batchWarnings && out.batchWarnings.length) console.log(`batch warnings: ${out.batchWarnings.join(', ')}`);
    if (out.summary) console.log('summary:', JSON.stringify(out.summary));
    if (out.flags) console.log('flags:', JSON.stringify(out.flags));
    for (const r of out.results || []) {
      const issues = [...r.errors.map((e) => `ERROR ${e}`), ...r.warnings.map((w) => `warn ${w}`)];
      console.log(`${String(r.index).padStart(3)} ${r.status.padEnd(18)} ${r.ref || r.email}${issues.length ? '  ' + issues.join('; ') : ''}`);
    }
  }
  await db.end();
  if (!out.ok) process.exit(1);
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
