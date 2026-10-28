#!/usr/bin/env node
/**
 * Create the four nurture contact properties in HubSpot.
 *
 *   node scripts/hubspot-nurture-properties.js           # prints the definitions, creates nothing
 *   node scripts/hubspot-nurture-properties.js --apply   # creates them (needs HUBSPOT_ACCESS_TOKEN
 *                                                        # with crm.schemas.contacts.write)
 *
 * Dry run is the default. Run --apply only at go-live, after Josh confirms.
 */
const hs = require('../src/services/hubspot-nurture');

async function main() {
  const apply = process.argv.includes('--apply');
  const defs = hs.propertyDefinitions();
  if (!apply) {
    console.log('DRY RUN: nothing was created. Definitions:');
    for (const d of defs) {
      const opts = d.options ? ` options=[${d.options.map((o) => o.value).join(', ')}]` : '';
      console.log(`- ${d.name} (${d.type}/${d.fieldType}, group ${d.groupName})${opts}`);
    }
    console.log('Re-run with --apply to create them.');
    return;
  }
  for (const d of defs) {
    const result = await hs.createPropertyDefinition(d);
    console.log(`${d.name}: ${result}`);
  }
}

main().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
