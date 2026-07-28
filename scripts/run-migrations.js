#!/usr/bin/env node
/**
 * Apply SQL migrations in order, once each, tracked in schema_migrations.
 * Safe to run on every boot — already-applied files are skipped.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function resolveDatabaseUrl() {
  const u = process.env.DATABASE_URL;
  if (u && !/railway\.internal/.test(u)) return u;
  const host = process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const port = process.env.RAILWAY_TCP_PROXY_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  const pass = process.env.POSTGRES_PASSWORD;
  const db = process.env.POSTGRES_DB || 'railway';
  if (host && pass) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }
  return u || null;
}

function pgSslOption(url) {
  if (url && (url.includes('amazonaws.com') || /sslmode=require/.test(url))) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function alreadyApplied(client, id) {
  const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [id]);
  return rows.length > 0;
}

async function recordApplied(client, id) {
  await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
}

async function main() {
  if (/^(1|true|yes|on)$/i.test(String(process.env.SKIP_DB_MIGRATIONS || '').trim())) {
    console.log('[Migrations] SKIP_DB_MIGRATIONS set — skipping');
    return;
  }

  const conn = resolveDatabaseUrl();
  if (!conn) {
    console.log('[Migrations] No DATABASE_URL — skipping');
    return;
  }

  const client = new Client({ connectionString: conn, ssl: pgSslOption(conn) });
  await client.connect();
  await client.query('SELECT 1 AS db_ping');

  const { rows: tableCheck } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'clients'`
  );
  if (!tableCheck.length) {
    const schemaPath = path.join(__dirname, '..', 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      console.log('[Migrations] Empty database: applying schema.sql ...');
      await client.query(fs.readFileSync(schemaPath, 'utf8'));
    }
  }

  await ensureMigrationsTable(client);

  for (const file of migrationFiles()) {
    const id = path.basename(file);
    if (await alreadyApplied(client, id)) continue;
    console.log(`[Migrations] Applying ${id} ...`);
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(file, 'utf8'));
      await recordApplied(client, id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${id} failed: ${err.message}`);
    }
  }

  await client.end();
  console.log('[Migrations] Up to date.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[Migrations] Failed:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
