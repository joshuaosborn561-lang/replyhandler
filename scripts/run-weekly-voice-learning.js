#!/usr/bin/env node
/**
 * Run the Friday voice-learning job by hand.
 *
 * Same code path as the cron: learns from the window's Slack-approved / edited
 * sends and manual SmartLead / HeyReach replies, upserts them into the RAG
 * corpus, and re-synthesizes the global + per-client voice profiles.
 *
 * Usage:
 *   railway run node scripts/run-weekly-voice-learning.js            # last 8 days
 *   railway run node scripts/run-weekly-voice-learning.js --hours 336
 *   railway run node scripts/run-weekly-voice-learning.js --dry      # no writes, prints profile previews
 *
 * Needs: DATABASE_URL, GEMINI_API_KEY, and (for RAG) SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY. Never calls Anthropic.
 */
const { resolveDatabaseUrl } = require('./railway-database-url');

const url = resolveDatabaseUrl();
if (url) process.env.DATABASE_URL = url;

const args = process.argv.slice(2);
const hoursIdx = args.indexOf('--hours');
const hours = hoursIdx !== -1 ? parseInt(args[hoursIdx + 1], 10) : undefined;
const dryRun = args.includes('--dry') || args.includes('--dry-run');

const { runWeeklyVoiceLearning } = require('../src/services/weekly-voice-learning');
const db = require('../src/db');

runWeeklyVoiceLearning({
  lookbackHours: Number.isFinite(hours) && hours > 0 ? hours : undefined,
  dryRun,
  trigger: dryRun ? 'script_dry_run' : 'script',
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    return db.end();
  })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[VoiceLearning] Fatal:', err.message);
    process.exit(1);
  });
