#!/usr/bin/env node
/**
 * Post follow-up nudge messages to Slack for positive replies from Culture Fits and MSRS.
 * Each nudge shows the lead name, email, and their original reply so the team can follow up.
 *
 * Usage: DATABASE_URL=... node scripts/post-followup-nudges.js [--days=N] [--dry-run]
 *
 * Hard cap: never look back more than 3 days (Josh: no backfill past 3 days ago).
 */
const { Client } = require('pg');
const { resolveDatabaseUrl, pgSslOption } = require('./railway-database-url');
const { stripHtmlToText } = require('../src/utils/smartlead-webhook-helpers');

const TARGET_CLIENTS = ['Culture Fits', 'MSRS'];
const MAX_DAYS_BACK = 3;
const daysCli = (process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1];
const DAYS_BACK = Math.min(
  Math.max(parseInt(daysCli || process.env.DAYS_BACK || String(MAX_DAYS_BACK), 10) || MAX_DAYS_BACK, 1),
  MAX_DAYS_BACK
);
const DRY_RUN = process.argv.includes('--dry-run');

function norm(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&rsquo;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanInbound(raw) {
  let s = norm(stripHtmlToText(raw) || raw);
  // Strip quoted history (everything after "On ... wrote:")
  s = s.split(/On .{5,80}wrote:/i)[0].trim();
  s = s.split(/From:\s/i)[0].trim();
  s = s.split(/-----Original Message-----/i)[0].trim();
  // Strip lines starting with >
  s = s.split('\n').filter(l => !/^\s*>/.test(l)).join('\n').trim();
  return s;
}

function isPositive(raw) {
  const s = cleanInbound(raw).toLowerCase();

  // Hard excludes
  if (/\b(remove me|remove us|off (your|the|our) list|unsubscribe|opt[ -]?out|stop emailing|do not contact)\b/.test(s)) return false;
  if (/\b(no thanks|no thank you)\b/.test(s) && s.length < 80) return false;
  if (/\bmust decline\b|\bwill decline\b|\bgoing to decline\b/.test(s)) return false;
  if (/\b(not a (good )?fit|not (currently )?looking|not interested)\b/.test(s)) return false;
  if (/\bnot (a )?prospect\b/.test(s)) return false;
  if (/\b(tiny company|no (roof|roofs|commercial))\b/.test(s)) return false;
  if (/\b(high.?rise|do not own(s)? the building)\b/.test(s)) return false;
  if (/\bown none of our real estate\b/.test(s)) return false;
  if (/\b(fully remote|small shared office)\b/.test(s) && /\bnot a (good )?fit\b/.test(s)) return false;
  if (/\bno longer (with|employed)\b/.test(s)) return false;
  if (/\bwrong person\b/.test(s)) return false;
  if (/\(no new reply/.test(s)) return false;
  // Clear exits with "thanks though" / "wish you well" / "best of luck"
  if (/\b(thanks though|thank you though|wish you well|best of luck)\b/.test(s)) return false;
  // Wrong-channel responses (asking us to advertise with them)
  if (/\binterested in advertising\b/.test(s)) return false;
  // "we lease" is only positive if they show engagement beyond just saying they lease
  if (/\bwe lease (our )?office space\b/.test(s) && !/\b(interested|open|call|chat|sure|yes|want)\b/.test(s)) return false;

  // Positive signals
  if (/\b(interested in (learning|understanding|hearing|your|more|discussing)|we have interest)\b/.test(s)) return true;
  if (/\b(open to (a |the )?(call|chat|meeting|conversation|discussion))\b/.test(s)) return true;
  if (/\b(would love|happy to|sounds good|let'?s (chat|talk|meet|connect|do it)|sure)\b/.test(s) && s.length < 200) return true;
  if (/\b(set up a call|schedule (a|some) time|book (a|some) time|grab a time)\b/.test(s)) return true;
  if (/\b(available (tuesday|wednesday|thursday|friday|monday|tomorrow|next week|this week|for a call))\b/.test(s)) return true;
  if (/\b(what type of tickets?|for how many|what dates?|when is the game|which game|what'?s the date)\b/.test(s)) return true;
  if (/\b(what states?|what areas?|where do you (service|cover|operate))\b/.test(s)) return true;
  if (/\b(tell me more|send me (more |)info|send (me )?(over|the) (info|details|case study|loom)|learn more)\b/.test(s)) return true;
  if (/\b(contractors? or (just )?employees?|provide contractors?)\b/.test(s)) return true;
  if (/\b(slammed|busy).{0,60}interested\b/.test(s)) return true;
  if (/\buse recruiters?\b/.test(s)) return true;
  if (/\bneed (some |any )?(roof|roofing|vendor|vendors?|work)\b/.test(s)) return true;
  if (/\b(roof (work|repair|job|project)|looking for a vendor|new vendor)\b/.test(s)) return true;
  if (/\bhow (much|many|do you|does it)\b/.test(s) && s.length < 300) return true;
  if (/\b(not sure what this is about|what is this about|can you (explain|tell me more))\b/.test(s)) return true;
  // Tickets engagement
  if (/\b(tickets?|tix)\b/.test(s) && /\b(sure|yes|love|take|want|sounds|great|game|date|when|how many|for how many)\b/.test(s)) return true;
  if (/\bfor how many and what dates?\b/.test(s)) return true;

  return false;
}

function escMrkdwn(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function postToSlack(token, channelId, blocks, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId, blocks, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data;
}

async function buildNudgeBlocks(clientName, positives) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📬 Follow-up nudges — ${clientName} (${positives.length})` },
    },
    { type: 'divider' },
  ];

  for (const p of positives) {
    const clean = cleanInbound(p.inbound_message);
    const preview = clean.slice(0, 400) + (clean.length > 400 ? '...' : '');
    const leadLine = p.lead_email
      ? `*${escMrkdwn(p.lead_name)}* · ${escMrkdwn(p.lead_email)}`
      : `*${escMrkdwn(p.lead_name)}*`;
    const statusEmoji = { pending: '🟡', sent: '✅', rejected: '🔴', approved: '🟢', flagged: '🚩', alert_only: '🔔' }[p.status] || '⚪';
    const platform = (p.platform || '').toLowerCase() === 'heyreach' ? 'LinkedIn' : 'Email';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} ${leadLine} _(${platform} · ${p.status})_\n> ${escMrkdwn(preview)}`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Follow up with each of the ${positives.length} lead${positives.length !== 1 ? 's' : ''} above. Reply to this message if any need a new draft.`,
    }],
  });

  return blocks;
}

async function main() {
  const daysArg = process.argv.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : DAYS_BACK;

  const conn = resolveDatabaseUrl();
  const db = new Client({ connectionString: conn, ssl: pgSslOption(conn) });
  await db.connect();

  const { rows: clients } = await db.query(
    `SELECT * FROM clients WHERE name = ANY($1) AND active = true ORDER BY name`,
    [TARGET_CLIENTS],
  );

  for (const client of clients) {
    const { rows } = await db.query(
      `SELECT id, lead_name, lead_email, classification, status, platform, inbound_message, created_at
         FROM pending_replies
        WHERE client_id = $1
          AND created_at >= now() - ($2 || ' days')::interval
          AND classification NOT IN ('OOO','OUT_OF_OFFICE')
        ORDER BY created_at DESC`,
      [client.id, String(days)],
    );

    // Dedupe by email/name, take most recent
    const seen = new Set();
    const positives = rows.filter(r => {
      const key = (r.lead_email || r.lead_name || '').toLowerCase();
      if (seen.has(key)) return false;
      if (!isPositive(r.inbound_message)) return false;
      seen.add(key);
      return true;
    });

    console.log(`\n${client.name}: ${positives.length} positive replies (of ${rows.length} total, last ${days} days)`);
    positives.forEach((p, i) => {
      const c = cleanInbound(p.inbound_message);
      console.log(`  ${i + 1}. [${p.status}] ${p.lead_name} — ${c.slice(0, 100)}`);
    });

    if (!positives.length) {
      console.log('  (none to post)');
      continue;
    }

    if (DRY_RUN) {
      console.log('  DRY RUN — skipping Slack post');
      continue;
    }

    const blocks = await buildNudgeBlocks(client.name, positives);
    const fallbackText = `Follow-up nudges for ${client.name}: ${positives.map(p => p.lead_name).join(', ')}`;

    try {
      const result = await postToSlack(client.slack_bot_token, client.slack_channel_id, blocks, fallbackText);
      console.log(`  ✓ Posted to Slack (ts: ${result.ts})`);
    } catch (err) {
      console.error(`  ✗ Slack post failed: ${err.message}`);
    }
  }

  await db.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
