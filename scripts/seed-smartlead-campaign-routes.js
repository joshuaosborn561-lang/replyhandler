#!/usr/bin/env node
/**
 * Seed explicit SmartLead campaign ownership from each client's dedicated key.
 * Run after migration 020. Conflicts are logged and never overwritten.
 */

const db = require('../src/db');
const { seedRoutesFromDedicatedKeys } = require('../src/services/smartlead-campaign-route');

async function main() {
  const totals = await seedRoutesFromDedicatedKeys();
  console.log('[RouteSeed] Complete', totals);
}

main()
  .finally(() => db.end())
  .catch((err) => {
    console.error('[RouteSeed] Fatal', err);
    process.exit(1);
  });
