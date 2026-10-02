#!/usr/bin/env node
/**
 * Rewrite already-posted FOLLOW_UP Slack cards to the compact layout.
 * Usage: node scripts/refresh-followup-slack-cards.js [--days=21] [--limit=80]
 */
const { refreshFollowUpSlackCards } = require('../src/services/refresh-followup-cards');

const days = parseInt((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1], 10) || 21;
const limit = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1], 10) || 80;

refreshFollowUpSlackCards({ days, limit })
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failed) process.exitCode = 1;
  })
  .then(() => process.exit())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
