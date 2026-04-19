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
}

module.exports = { assertDatabaseReady };
