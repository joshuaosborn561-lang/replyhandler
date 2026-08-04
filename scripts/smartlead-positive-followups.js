#!/usr/bin/env node
/**
 * For each positive SmartLead reply (last N days) from Culture Fits and MSRS:
 *   1. Upsert a pending_reply row in the DB
 *   2. Generate a short draft follow-up
 *   3. Post an interactive Slack card with Approve / Edit & send / Reject buttons
 *
 * The existing /slack/actions handler takes care of sending when Approved.
 *
 * Usage:
 *   DATABASE_URL=... GEMINI_API_KEY=... node scripts/smartlead-positive-followups.js
 *   DATABASE_URL=... GEMINI_API_KEY=... node scripts/smartlead-positive-followups.js --days=14 --dry-run
 */

const { Client } = require('pg');
const { resolveDatabaseUrl, pgSslOption } = require('./railway-database-url');
const { stripHtmlToText } = require('../src/utils/smartlead-webhook-helpers');
const slackService = require('../src/services/slack');
const { draftOnly } = require('../src/services/classifier');

const TARGET_CLIENT_NAMES = ['Culture Fits', 'MSRS'];
const BASE = 'https://server.smartlead.ai/api/v1';
const DRY_RUN = process.argv.includes('--dry-run');
const ALL_CLIENTS = process.argv.includes('--all-clients');
const daysArg = (process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1];
const maxArg = (process.argv.find(a => a.startsWith('--max-per-client=')) || '').split('=')[1];
const DAYS_BACK = parseInt(daysArg || '14', 10);
const MAX_PER_CLIENT = Math.max(0, parseInt(maxArg || '5', 10) || 5);
const CUTOFF = new Date(Date.now() - DAYS_BACK * 24 * 3600 * 1000);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Text helpers ────────────────────────────────────────────────────────────

function stripHtml(s) {
  return String(s || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&rsquo;|&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripQuotes(s) {
  s = String(s || '');
  s = s.split(/On .{5,100}wrote:/i)[0];
  s = s.split(/From:\s{0,5}\S/i)[0];
  s = s.split(/-----\s*Original Message/i)[0];
  s = s.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');
  return s.trim();
}

function clean(raw) {
  return stripQuotes(stripHtml(raw)).replace(/\s+/g, ' ').trim();
}

function firstName(fullName) {
  const s = String(fullName || '').trim();
  return s ? s.split(/\s+/)[0] : 'there';
}

// ─── Positive filter ─────────────────────────────────────────────────────────

function isPositive(raw) {
  const s = clean(raw).toLowerCase();
  if (!s || s.length < 4) return false;

  // Hard excludes
  if (/\b(remove (me|us)|off (your|the|our) list|unsubscribe|opt[ -]?out|stop emailing)\b/.test(s)) return false;
  if (/\bno (thanks|thank you)\b/.test(s) && s.length < 120) return false;
  if (/\b(must|will|going to) decline\b/.test(s)) return false;
  if (/\bnot (a |currently )?(good )?fit\b|\bnot (currently )?looking\b|\bnot interested\b/.test(s)) return false;
  if (/\bnot a prospect\b/.test(s)) return false;
  if (/\b(tiny company|no (roof|roofs))\b/.test(s)) return false;
  if (/\b(fully remote|small shared office)\b/.test(s) && /\bnot a (good )?fit\b/.test(s)) return false;
  if (/\b(no longer (with|employed)|wrong person)\b/.test(s)) return false;
  if (/\b(thanks though|thank you though|wish you well|best of luck to you)\b/.test(s)) return false;
  if (/\binterested in advertising\b/.test(s)) return false;
  if (/\bdo not own(s)? (the )?building\b/.test(s) && !/\b(interested|open to|call|sure)\b/.test(s)) return false;
  if (/\bown none of our real estate\b/.test(s)) return false;
  if (/\bwe lease (our )?office space\b/.test(s) && !/\b(interested|open|call|sure|yes)\b/.test(s)) return false;
  if (/\b(high.?rise tower|not relevant to our company)\b/.test(s)) return false;
  if (/\b(no|don'?t own any) commercial buildings or have a need\b/.test(s)) return false;
  if (/\b(out of (the )?office|on vacation|ooo)\b/.test(s) && !/\b(interested|open to|call|sure|tickets?|available)\b/.test(s)) return false;

  // Positive signals
  if (/\b(interested in (learning|understanding|hearing|your|more|discussing))\b/.test(s)) return true;
  if (/\bwe have interest\b/.test(s)) return true;
  if (/\b(open to (a |the )?(call|chat|meeting|conversation|discussion))\b/.test(s)) return true;
  if (/\b(would love to|happy to (chat|meet|talk|learn|connect))\b/.test(s)) return true;
  if (/\b(let'?s (chat|talk|meet|connect|do it|set something up))\b/.test(s)) return true;
  if (/\b(set up a call|schedule (a |some )?time|book (a |some )?time|grab a time)\b/.test(s)) return true;
  if (/\b(sounds good|sure[,!]?\s*\w|yes[,!]?\s*\w)\b/.test(s) && s.length < 200) return true;
  if (/\b(available (tuesday|wednesday|thursday|friday|monday|tomorrow|next week|this week|for a call|in the afternoon))\b/.test(s)) return true;
  if (/\b(what type of tickets?|for how many|what dates?|when is the game|which game|what'?s the date of)\b/.test(s)) return true;
  if (/\b(what states?|what areas?|where do you (service|cover|operate|work))\b/.test(s)) return true;
  if (/\b(tell me more|send me (over |more |)(info|details|case study|loom)|learn more about)\b/.test(s)) return true;
  if (/\b(contractors? or (just )?employees?|provide contractors?)\b/.test(s)) return true;
  if (/\b(slammed|busy).{0,60}interested\b|\binterested.{0,60}(slammed|busy)\b/.test(s)) return true;
  if (/\buse recruiters?\b/.test(s)) return true;
  if (/\bneed (some |any )?(roof|roofing|vendor|vendors?)/.test(s)) return true;
  if (/\b(roof (work|repair|job|project))\b/.test(s)) return true;
  if (/\bhow (much|does it cost|do you charge)\b/.test(s)) return true;
  if (/\b(what is this (about)?|not sure what this is)\b/.test(s)) return true;
  if (/\b(tickets?|tix)\b/.test(s) && /\b(sure|yes|love|take|want|great|game|date|when|how many|for how many|sounds)\b/.test(s)) return true;

  return false;
}

// ─── SmartLead helpers ───────────────────────────────────────────────────────

async function fetchInboxPage(apiKey, offset) {
  await sleep(1100);
  const res = await fetch(
    `${BASE}/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=true`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset,
        limit: 20,
        filters: { emailStatus: 'Replied' },
        sortBy: 'REPLY_TIME_DESC',
      }),
    },
  );
  const data = await res.json();
  if (!Array.isArray(data.data)) throw new Error(`SmartLead inbox error: ${JSON.stringify(data).slice(0, 200)}`);
  return data.data;
}

function extractLatestReply(row) {
  const hist = Array.isArray(row.email_history) ? row.email_history : [];
  const replies = hist
    .filter(m => String(m.type || '').toUpperCase() === 'REPLY')
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  if (!replies.length) return null;
  const last = replies[replies.length - 1];
  const sent = hist
    .filter(m => String(m.type || '').toUpperCase() === 'SENT')
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  const lastSent = sent[sent.length - 1];
  return {
    inbound: clean(last.email_body || last.body || ''),
    lastOutbound: lastSent ? clean(lastSent.email_body || lastSent.body || '') : '',
    threadContext: { history: hist.map(m => ({
      type: String(m.type || '').toUpperCase(),
      time: m.time || '',
      email_body: clean(m.email_body || m.body || ''),
    })) },
  };
}

async function fetchPositives(client) {
  const positives = [];
  const seen = new Set();
  let offset = 0;
  let pagesWithoutRecent = 0;

  while (true) {
    let rows;
    try { rows = await fetchInboxPage(client.smartlead_api_key, offset); }
    catch (e) { console.warn(`  [${client.name}] inbox fetch failed at offset ${offset}: ${e.message}`); break; }
    if (!rows.length) break;

    let anyRecent = false;
    for (const row of rows) {
      const replyTime = new Date(row.last_reply_time || 0);
      if (replyTime < CUTOFF) continue;
      anyRecent = true;

      const email = String(row.lead_email || '').toLowerCase().trim();
      if (seen.has(email)) continue;

      const extracted = extractLatestReply(row);
      if (!extracted || !extracted.inbound) continue;
      if (!isPositive(extracted.inbound)) continue;

      seen.add(email);
      positives.push({
        leadName: `${row.lead_first_name || ''} ${row.lead_last_name || ''}`.trim() || 'Unknown',
        leadEmail: row.lead_email || '',
        campaignId: String(row.email_campaign_id || ''),
        leadId: String(row.email_lead_id || ''),
        mapId: String(row.email_lead_map_id || ''),
        campaignName: row.email_campaign_name || '',
        replyTime: row.last_reply_time,
        inbound: extracted.inbound,
        lastOutbound: extracted.lastOutbound,
        threadContext: extracted.threadContext,
      });
    }

    if (!anyRecent) { if (++pagesWithoutRecent >= 2) break; }
    else pagesWithoutRecent = 0;
    if (rows.length < 20) break;
    offset += 20;
  }

  return positives;
}

// ─── Draft generation ─────────────────────────────────────────────────────────

async function generateDraft(client, lead) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const draft = await draftOnly({
        classification: 'INTERESTED',
        threadContext: lead.threadContext,
        inboundMessage: lead.inbound,
        leadName: lead.leadName,
        voicePrompt: client.voice_prompt || '',
        bookingLink: client.booking_link || '',
        schedulingPromptBlock: '',
        platform: 'smartlead',
      });
      if (draft && draft.length > 10) return draft;
    } catch (e) {
      console.warn(`  Draft generation failed for ${lead.leadName}: ${e.message}`);
    }
  }

  // Fallback: simple personalized template
  const name = firstName(lead.leadName);
  const link = client.booking_link ? ` ${client.booking_link}` : '';
  const s = lead.inbound.toLowerCase();
  if (/what states?|where do you/.test(s)) {
    return `Hey ${name}, thanks for getting back to me. We primarily service the Southeast — would love to walk through the details on a quick call with our CEO.${link}`;
  }
  if (/how much|cost|pricing|seal/.test(s)) {
    return `Hey ${name}, thanks for getting back to me. Pricing depends on a few things — easiest is to hop on a quick call with our CEO and he can give you a number.${link}`;
  }
  if (/what type of ticket|for how many|what dates/.test(s)) {
    return `Hey ${name}, thanks for getting back to me! Tickets are flexible — let's get something on the calendar with our CEO and we'll sort out the tickets from there.${link}`;
  }
  if (/not sure what this is|what is this/.test(s)) {
    return `Hey ${name}, sorry for any confusion! We're a commercial roofing company — our CEO would love to do a quick intro call and see if there's a fit.${link}`;
  }
  return `Hey ${name}, thanks for getting back to me. Would love to connect — here's our CEO's calendar if you want to grab a time.${link}`;
}

// ─── DB + Slack ───────────────────────────────────────────────────────────────

async function upsertAndPost(db, client, lead) {
  const draft = await generateDraft(client, lead);
  const classification = 'INTERESTED';

  // Check for existing row for this lead
  const { rows: [existing] } = await db.query(
    `SELECT id, status FROM pending_replies
      WHERE client_id = $1 AND platform = 'smartlead'
        AND campaign_id = $2 AND lead_id = $3
      ORDER BY created_at DESC LIMIT 1`,
    [client.id, lead.campaignId, lead.leadId],
  );

  let replyId;
  if (existing && existing.status === 'pending') {
    // Already pending — update draft and re-post
    replyId = existing.id;
    await db.query(
      `UPDATE pending_replies SET draft_reply = $1, classification = $2, updated_at = now() WHERE id = $3`,
      [draft, classification, replyId],
    );
  } else {
    // Insert fresh row
    const { rows: [reply] } = await db.query(
      `INSERT INTO pending_replies
        (client_id, platform, campaign_id, lead_id, lead_name, lead_email,
         inbound_message, thread_context, classification, draft_reply, status)
       VALUES ($1, 'smartlead', $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING id`,
      [
        client.id, lead.campaignId, lead.leadId,
        lead.leadName, lead.leadEmail,
        lead.inbound, JSON.stringify(lead.threadContext),
        classification, draft,
      ],
    );
    replyId = reply.id;
  }

  const campaignDisplay = lead.campaignName || (lead.campaignId ? `Campaign ${lead.campaignId}` : undefined);

  // Post as a new top-level message — do NOT thread under old cards for this lead.
  // (postProspectSlackCard would thread them under June 29 cards, burying them.)
  const result = await slackService.postDraftApproval(client.slack_bot_token, client.slack_channel_id, {
    replyId,
    leadName: lead.leadName,
    leadEmail: lead.leadEmail,
    platform: 'smartlead',
    classification,
    draft,
    reasoning: 'Positive reply — follow-up card (backfill).',
    inboundMessage: lead.inbound,
    lastOutboundMessage: lead.lastOutbound || undefined,
    campaignDisplay,
  });

  // Store the new top-level message ts
  if (result?.ts) {
    await db.query(
      'UPDATE pending_replies SET slack_message_ts = $1, updated_at = now() WHERE id = $2',
      [result.ts, replyId],
    );
  }

  return replyId;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Scanning last ${DAYS_BACK} days. Cutoff: ${CUTOFF.toISOString()}`);
  console.log(`Max ${MAX_PER_CLIENT} prospects per client`);
  if (DRY_RUN) console.log('DRY RUN — will not write to DB or post to Slack\n');
  if (!process.env.GEMINI_API_KEY) console.log('GEMINI_API_KEY not set — will use fallback drafts\n');

  const conn = resolveDatabaseUrl();
  if (!conn) { console.error('DATABASE_URL required'); process.exit(1); }

  const db = new Client({ connectionString: conn, ssl: pgSslOption(conn) });
  await db.connect();

  const { rows: clients } = ALL_CLIENTS
    ? await db.query(
      `SELECT id, name, smartlead_api_key, slack_bot_token, slack_channel_id, booking_link, voice_prompt
         FROM clients
        WHERE active IS DISTINCT FROM false
          AND smartlead_api_key IS NOT NULL
          AND trim(smartlead_api_key) <> ''
        ORDER BY name`
    )
    : await db.query(
      `SELECT id, name, smartlead_api_key, slack_bot_token, slack_channel_id, booking_link, voice_prompt
         FROM clients WHERE name = ANY($1) AND active = true ORDER BY name`,
      [TARGET_CLIENT_NAMES],
    );

  let totalPosted = 0;
  for (const client of clients) {
    if (!client.smartlead_api_key) { console.log(`\n${client.name}: no SmartLead API key, skipping`); continue; }
    console.log(`\n=== ${client.name} ===`);

    const positives = await fetchPositives(client);
    console.log(`Found ${positives.length} positive replies; posting up to ${MAX_PER_CLIENT} new:`);

    let postedForClient = 0;
    for (const [i, lead] of positives.entries()) {
      if (postedForClient >= MAX_PER_CLIENT) break;

      console.log(`  ${i + 1}. ${lead.leadName} <${lead.leadEmail}> [${lead.replyTime?.slice(0, 10)}]`);
      console.log(`     ${lead.inbound.slice(0, 120)}`);

      if (DRY_RUN) { postedForClient++; continue; }

      try {
        // Skip if we already have a card for this exact inbound text
        const { inboundPrefix, normalizeInboundText, sameReplySql } = require('../src/services/reply-dedupe');
        const prefix = inboundPrefix(lead.inbound);
        const full = normalizeInboundText(lead.inbound);
        const { rows: dupes } = await db.query(
          `SELECT id, status FROM pending_replies
            WHERE client_id = $1 AND platform = 'smartlead'
              AND COALESCE(lead_id, '') = $2
              AND ${sameReplySql('$3', '$4')}
            LIMIT 1`,
          [client.id, String(lead.leadId || ''), prefix, full],
        );
        if (dupes[0]) {
          console.log(`     · skipped — already have ${dupes[0].status} row ${dupes[0].id}`);
          continue;
        }

        const replyId = await upsertAndPost(db, client, lead);
        console.log(`     ✓ Posted card (reply_id: ${replyId})`);
        totalPosted++;
        postedForClient++;
        await sleep(500); // small pause between Slack posts
      } catch (err) {
        console.error(`     ✗ Failed: ${err.message}`);
      }
    }
  }

  await db.end();
  console.log(`\nDone. ${totalPosted} cards posted.`);
}

main().catch(e => { console.error(e); process.exit(1); });
