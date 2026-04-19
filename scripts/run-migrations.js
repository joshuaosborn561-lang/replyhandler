#!/usr/bin/env node
/**
 * Apply SQL migrations in order, once each, tracked in schema_migrations.
 * Run automatically before the server starts (see scripts/run-migrations-on-start.sh, railway.json).
 *
 * Ensures Railway Postgres gets columns like clients.booking_link even if 002 was never run manually.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { resolveDatabaseUrl, pgSslOption } = require('./railway-database-url');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/** Filenames in lexical order (002 … 010). */
const MIGRATION_FILES = [
  '002_booking_link.sql',
  '003_calendar_connections.sql',
  '004_calendly_pat.sql',
  '005_booking_link_safe.sql',
  '007_outbound_follow_ups.sql',
  '008_smartlead_stats_id.sql',
  '009_pending_nudge_and_tz.sql',
  '010_pending_nudge_snooze.sql',
];

async function clientsTableExists(client) {
  const { rows } = await client.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'clients'
  `);
  return rows.length > 0;
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

  try {
    if (!(await clientsTableExists(client))) {
      console.warn(
        '[Migrations] Table public.clients not found — apply schema.sql to this database first (see README), then redeploy.'
      );
      return;
    }

    await ensureMigrationsTable(client);

    for (const file of MIGRATION_FILES) {
      const full = path.join(MIGRATIONS_DIR, file);
      if (!fs.existsSync(full)) {
        console.error('[Migrations] Missing file:', full);
        process.exit(1);
      }

      if (await alreadyApplied(client, file)) {
        continue;
      }

      const sql = fs.readFileSync(full, 'utf8');
      console.log('[Migrations] Applying', file);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await recordApplied(client, file);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }

    console.log('[Migrations] Up to date');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[Migrations] Failed:', err.message);
  process.exit(1);
});
