#!/usr/bin/env node
/**
 * Apply schema.sql + follow-up migrations to DATABASE_URL (e.g. Railway Postgres).
 * Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS where applicable.
 *
 *   railway run -s app node scripts/apply-schema-to-db.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');

const FILES = [
  path.join(ROOT, 'schema.sql'),
  path.join(ROOT, 'migrations', '009_pending_nudge_and_tz.sql'),
  path.join(ROOT, 'migrations', '010_pending_nudge_snooze.sql'),
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: url.includes('amazonaws.com') || /sslmode=require/.test(url)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();

  for (const file of FILES) {
    const sql = fs.readFileSync(file, 'utf8');
    console.log(`Applying ${path.relative(ROOT, file)} ...`);
    await client.query(sql);
  }

  await client.end();
  console.log('Schema apply finished OK.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
