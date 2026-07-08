#!/usr/bin/env node
/**
 * Re-post Slack approval cards (with Approve/Edit/Reject buttons) for reply rows.
 * Usage: DATABASE_URL=... node scripts/repost-approval-cards.js <reply-id> [reply-id...]
 *        DATABASE_URL=... node scripts/repost-approval-cards.js --culture-fits-positives
 */
const { Client } = require('pg');
const { resolveDatabaseUrl, pgSslOption } = require('./railway-database-url');
const { postProspectSlackCard } = require('../src/services/slack-reply-post');
const { DRAFT_CLASSIFICATIONS } = require('../src/services/classifier');

const CULTURE_FITS_POSITIVE_IDS = [
  '34f9925d-49e5-4f20-afc7-762700e05035', // Matt Wood
  'a5721d68-98e0-4ffe-856a-a3e8bf339e9f', // Ken Naumann
  '1a9b52cf-27eb-484d-a858-19337c3fe5b1', // Jamie Hogue
];

function firstName(leadName) {
  const s = String(leadName || '').trim();
  return s ? s.split(/\s+/)[0] : 'there';
}

function followUpDraft(row) {
  const name = firstName(row.lead_name);
  const link = String(row.booking_link || '').trim();
  const tickets = /culture fits/i.test(row.client_name);
  const tail = tickets
    ? 'Would love to get you those tickets and have a chat.'
    : 'Would love to find time for a quick chat.';
  return (
    `Hey ${name}, just wanted to make sure my booking link came through. ` +
    `Let me know if these times don't work — ${tail}` +
    (link ? ` ${link}` : '')
  );
}

async function repostOne(db, replyId) {
  const { rows: [row] } = await db.query(
    `SELECT pr.*, c.name AS client_name, c.slack_bot_token, c.slack_channel_id, c.booking_link
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.id = $1`,
    [replyId]
  );
  if (!row) {
    console.warn('Not found:', replyId);
    return null;
  }

  const draft = followUpDraft(row);
  const classification = row.classification === 'QUESTION' ? 'QUESTION' : 'INTERESTED';

  await db.query(
    `UPDATE pending_replies
        SET status = 'pending', draft_reply = $1, classification = $2, updated_at = now()
      WHERE id = $3`,
    [draft, classification, replyId]
  );

  const isDraft = DRAFT_CLASSIFICATIONS.includes(classification) || classification === 'FOLLOW_UP';

  await postProspectSlackCard({
    token: row.slack_bot_token,
    channelId: row.slack_channel_id,
    clientId: row.client_id,
    platform: row.platform,
    campaignId: row.campaign_id,
    leadId: row.lead_id,
    threadContext: row.thread_context,
    isDraft: true,
    replyId: row.id,
    card: {
      replyId: row.id,
      leadName: row.lead_name,
      leadEmail: row.lead_email,
      platform: row.platform,
      classification,
      draft,
      reasoning: 'Follow-up — booking link nudge (re-posted with Approve/Edit/Reject buttons).',
      inboundMessage: row.inbound_message,
      campaignDisplay: row.campaign_id ? `Campaign ${row.campaign_id}` : undefined,
    },
  });

  console.log(`Reposted: ${row.client_name} | ${row.lead_name} (${replyId})`);
  return { client: row.client_name, lead: row.lead_name, replyId };
}

async function main() {
  const args = process.argv.slice(2);
  let ids = args;
  if (args.includes('--culture-fits-positives')) {
    ids = CULTURE_FITS_POSITIVE_IDS;
  }
  if (!ids.length) {
    console.error('Usage: node scripts/repost-approval-cards.js <id>... | --culture-fits-positives');
    process.exit(1);
  }

  const conn = resolveDatabaseUrl();
  const db = new Client({ connectionString: conn, ssl: pgSslOption(conn) });
  await db.connect();

  const results = [];
  for (const id of ids) {
    try {
      const r = await repostOne(db, id);
      if (r) results.push(r);
    } catch (err) {
      console.error('Failed', id, err.message);
    }
  }

  await db.end();
  console.log('\nDone:', JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
