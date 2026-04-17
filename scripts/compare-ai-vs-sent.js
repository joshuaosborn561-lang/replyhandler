#!/usr/bin/env node
/**
 * Compare the AI draft (draft_reply, unchanged after ingest) to what was actually sent (sent_reply).
 * After Edit & send, draft_reply still holds the original Gemini output; sent_reply holds the final text.
 *
 * Run: node scripts/compare-ai-vs-sent.js
 */
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        platform,
        lead_name,
        classification,
        status,
        inbound_message,
        draft_reply,
        sent_reply,
        TRIM(COALESCE(sent_reply, '')) <> TRIM(COALESCE(draft_reply, '')) AS human_edited_or_divergent
      FROM pending_replies
      WHERE status = 'sent'
        AND sent_reply IS NOT NULL AND TRIM(sent_reply) <> ''
      ORDER BY created_at DESC
      LIMIT 500
    `);

    const edited = rows.filter((r) => r.human_edited_or_divergent);
    const unchanged = rows.filter((r) => !r.human_edited_or_divergent);

    console.log(JSON.stringify({
      summary: {
        sentTotal: rows.length,
        draftMatchesSent: unchanged.length,
        draftDiffersFromSent: edited.length,
      },
      whereDraftDiffersFromSent: edited.map((r) => ({
        id: r.id,
        platform: r.platform,
        lead_name: r.lead_name,
        classification: r.classification,
        inbound_message: r.inbound_message,
        draft_reply: r.draft_reply,
        sent_reply: r.sent_reply,
      })),
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
