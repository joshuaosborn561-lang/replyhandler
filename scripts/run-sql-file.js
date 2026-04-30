#!/usr/bin/env node
/**
 * Run a SQL file against DATABASE_URL (no psql required).
 * Usage: node scripts/run-sql-file.js migrations/005_booking_link_safe.sql
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-sql-file.js <path-to.sql>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
    console.log('OK:', file);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
