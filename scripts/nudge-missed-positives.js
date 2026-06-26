#!/usr/bin/env node
/**
 * Find misclassified positive replies (OTHER) in last N hours and post Slack thread nudges.
 * Usage: DATABASE_URL=... node scripts/nudge-missed-positives.js [--hours=48] [--dry-run]
 */
const { Client } = require('pg');
const { WebClient } = require('@slack/web-api');
const { resolveDatabaseUrl, pgSslOption } = require('./railway-database-url');
const {
  stripHtmlToText,
  looksLikePositiveInterest,
  looksLikeNotInterested,
  looksLikeOutOfOffice,
} = require('../src/utils/smartlead-webhook-helpers');

function firstName(leadName) {
  const s = String(leadName || '').trim();
  return s ? s.split(/\s+/)[0] : 'there';
}

function nudgeText({ lead_name: leadName, client_name: clientName, booking_link: bookingLink }) {
  const name = firstName(leadName);
  const link = String(bookingLink || '').trim();
  const tickets = /culture fits/i.test(clientName);
  const tail = tickets
    ? 'Would love to get you those tickets and have a chat.'
    : 'Would love to find time for a quick chat.';
  return (
    `Hey ${name}, just wanted to make sure my booking link came through. ` +
    `Let me know if these times don't work — ${tail}` +
    (link ? ` ${link}` : '')
  );
}

function classifyPositive(inbound) {
  const plain = stripHtmlToText(inbound);
  if (/\b(where are (they|you) located|how much|what does .* cost|pricing)\b/i.test(plain)) return 'QUESTION';
  return 'INTERESTED';
}

function isMissedPositive(row) {
  if (!row.inbound_message) return false;
  const plain = stripHtmlToText(row.inbound_message);
  if (looksLikeOutOfOffice(plain) || looksLikeNotInterested(plain)) return false;
  if (row.classification === 'INTERESTED' || row.classification === 'QUESTION' || row.classification === 'MEETING_PROPOSED') {
    return false;
  }
  return looksLikePositiveInterest(plain);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const hoursArg = process.argv.find((a) => a.startsWith('--hours='));
  const hours = hoursArg ? parseInt(hoursArg.split('=')[1], 10) : 48;

  const conn = resolveDatabaseUrl();
  if (!conn) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }

  const db = new Client({ connectionString: conn, ssl: pgSslOption(conn) });
  await db.connect();

  const { rows } = await db.query(
    `SELECT pr.*, c.name AS client_name, c.slack_bot_token, c.slack_channel_id, c.booking_link
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.created_at > now() - ($1::text || ' hours')::interval
        AND c.name IN ('Culture Fits', 'Parlay Tech')
        AND pr.slack_message_ts IS NOT NULL
      ORDER BY pr.created_at DESC`,
    [String(hours)]
  );

  const targets = rows.filter(isMissedPositive);
  console.log(`Scanned ${rows.length} replies (${hours}h); ${targets.length} missed positives`);

  const nudged = [];
  for (const row of targets) {
    const text = nudgeText(row);
    const newClass = classifyPositive(row.inbound_message);
    console.log('\n---');
    console.log(`${row.client_name} | ${row.lead_name} | was ${row.classification} → ${newClass}`);
    console.log(`Inbound: ${stripHtmlToText(row.inbound_message).slice(0, 120)}...`);
    console.log(`Nudge: ${text}`);

    if (dryRun) continue;

    await db.query(
      'UPDATE pending_replies SET classification = $1, updated_at = now() WHERE id = $2',
      [newClass, row.id]
    );

    const slack = new WebClient(row.slack_bot_token);
    await slack.chat.postMessage({
      channel: row.slack_channel_id,
      thread_ts: row.slack_message_ts,
      text: `📌 *Suggested follow-up for ${row.lead_name}:*\n${text}`,
    });

    nudged.push({
      client: row.client_name,
      lead: row.lead_name,
      email: row.lead_email,
      oldClassification: row.classification,
      newClassification: newClass,
      replyId: row.id,
    });
  }

  await db.end();
  console.log('\n=== NUDGED ===');
  console.log(JSON.stringify(nudged, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
