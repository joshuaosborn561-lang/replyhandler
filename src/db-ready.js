const db = require('./db');

/**
 * Verify core tables exist so webhooks do not silently "succeed" with 200 while DB is empty.
 */
async function assertDatabaseReady() {
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS n
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('clients', 'pending_replies')
  `);
  if (!rows.length || rows[0].n < 2) {
    throw new Error(
      'Database schema missing (clients/pending_replies). Run: node scripts/apply-schema-to-db.js against DATABASE_URL'
    );
  }

  const raw = process.env.MIN_ACTIVE_CLIENTS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const minClients = parseInt(raw, 10);
    if (Number.isFinite(minClients) && minClients > 0) {
      const { rows: c } = await db.query(
        `SELECT COUNT(*)::int AS n FROM clients WHERE active IS DISTINCT FROM false`
      );
      const n = c[0]?.n ?? 0;
      if (n < minClients) {
        throw new Error(
          `Need at least ${minClients} active client row(s) in DB (found ${n}). Add via dashboard or POST /admin/clients.`
        );
      }
    }
  }
}

/**
 * Same checks as startup; use for GET /health so Railway marks the service unhealthy if DB is wiped.
 */
async function getHealthStatus() {
  await assertDatabaseReady();
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    gitSha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || null,
  };
}

module.exports = { assertDatabaseReady, getHealthStatus };
