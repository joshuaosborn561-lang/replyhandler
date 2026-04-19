#!/usr/bin/env node
/**
 * Bootstrap an empty Postgres: run schema.sql then migrations/*.sql in order.
 * If `clients` already exists, skips (safe for every deploy). To force-apply new
 * migration files on an existing DB, run with --migrate:
 *   node scripts/apply-schema-to-db.js --migrate
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');

function migrationFiles() {
  const dir = path.join(ROOT, 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f));
}

async function tableExists(client, name) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return rows.length > 0;
}

async function main() {
  const forceMigrations = process.argv.includes('--migrate');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[Migrate] DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: url.includes('amazonaws.com') || /sslmode=require/.test(url)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();

  const hasClients = await tableExists(client, 'clients');

  if (!hasClients) {
    const schemaPath = path.join(ROOT, 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      await client.end();
      console.error('[Migrate] schema.sql missing');
      process.exit(1);
    }
    console.log('[Migrate] Empty database: applying schema.sql ...');
    await client.query(fs.readFileSync(schemaPath, 'utf8'));
    for (const file of migrationFiles()) {
      console.log(`[Migrate] Applying ${path.relative(ROOT, file)} ...`);
      await client.query(fs.readFileSync(file, 'utf8'));
    }
  } else if (forceMigrations) {
    console.log('[Migrate] --migrate: applying migrations/*.sql only ...');
    for (const file of migrationFiles()) {
      console.log(`[Migrate] Applying ${path.relative(ROOT, file)} ...`);
      await client.query(fs.readFileSync(file, 'utf8'));
    }
  } else {
    console.log('[Migrate] Database already has schema; skip (use --migrate to run migrations/*.sql)');
  }

  await client.end();
  console.log('[Migrate] Finished OK.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[Migrate] Failed:', e.message);
    process.exit(1);
  });
}
