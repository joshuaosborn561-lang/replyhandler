#!/usr/bin/env node
/**
 * One-time backfill: post Slack alerts for replies that were silently muted
 * earlier today by the "only notify for actionable replies" bug (fixed in
 * commit 2945730). Any pending_replies row with status = 'alert_only' and
 * no slack_message_ts never got a Slack card at all.
 *
 * Skips anything we can confirm was already replied to manually (SmartLead
 * thread shows an outbound message sent after the inbound reply we logged).
 *
 * Usage:
 *   node scripts/backfill-muted-alerts.js                 # since start of today, dry-run
 *   node scripts/backfill-muted-alerts.js --apply          # actually post to Slack
 *   node scripts/backfill-muted-alerts.js --since=2026-07-28T16:00:00Z --apply
 */
const { Client } = require('pg');
const smartlead = require('../src/services/smartlead');
const slack = require('../src/services/slack');

function resolveDatabaseUrl() {
  const u = process.env.DATABASE_URL;
  if (u && !/railway\.internal/.test(u)) return u;
  const host = process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const port = process.env.RAILWAY_TCP_PROXY_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  const pass = process.env.POSTGRES_PASSWORD;
  const db = process.env.POSTGRES_DB || 'railway';
  if (host && pass) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }
  return u || null;
}

function pgSslOption(url) {
  if (url && (url.includes('amazonaws.com') || /sslmode=require/.test(url))) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function historyMessages(historyResponse) {
  if (!historyResponse || typeof historyResponse !== 'object') return [];
  if (Array.isArray(historyResponse.history)) return historyResponse.history;
  if (Array.isArray(historyResponse.messages)) return historyResponse.messages;
  if (Array.isArray(historyResponse)) return historyResponse;
  return [];
}

/**
 * Best-effort check: did a SENT message appear in the thread after this
 * reply arrived, that our system did NOT send (status never reached 'sent')?
 * That would mean someone replied manually outside this system.
 */
async function wasRepliedToManually(client, row) {
  if (row.platform !== 'smartlead') {
    // No reliable re-fetch mechanism for HeyReach conversations here — can't confirm either way.
    return false;
  }
  try {
    const history = await smartlead.getThreadHistory(client.smartlead_api_key, row.campaign_id, row.lead_id);
    const rows = historyMessages(history);
    const inboundTime = new Date(row.created_at).getTime();
    return rows.some((m) => {
      const type = String(m.type || m.direction || '').toUpperCase();
      if (type !== 'SENT' && type !== 'OUTBOUND') return false;
      const t = new Date(m.time || m.sent_at || m.created_at || 0).getTime();
      return t > inboundTime;
    });
  } catch (err) {
    console.warn(`[Backfill] Could not verify manual-reply status for ${row.id}, will alert to be safe`, { err: err.message });
    return false;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sinceArg = process.argv.find((a) => a.startsWith('--since='));
  const since = sinceArg ? new Date(sinceArg.split('=')[1]) : new Date(new Date().toISOString().slice(0, 10));

  const conn = resolveDatabaseUrl();
  if (!conn) throw new Error('No DATABASE_URL available');

  const db = new Client({ connectionString: conn, ssl: pgSslOption(conn) });
  await db.connect();

  const { rows } = await db.query(
    `SELECT pr.*, c.slack_bot_token, c.slack_channel_id, c.name AS client_name, c.smartlead_api_key
     FROM pending_replies pr
     JOIN clients c ON pr.client_id = c.id
     WHERE pr.status = 'alert_only'
       AND pr.slack_message_ts IS NULL
       AND pr.created_at >= $1
     ORDER BY pr.created_at ASC`,
    [since]
  );

  console.log(`[Backfill] Found ${rows.length} muted alert_only replies since ${since.toISOString()}${apply ? '' : ' (DRY RUN — pass --apply to post)'}`);

  let posted = 0;
  let skippedManual = 0;

  for (const row of rows) {
    const manual = await wasRepliedToManually({ smartlead_api_key: row.smartlead_api_key }, row);
    if (manual) {
      skippedManual++;
      console.log(`[Backfill] SKIP (already replied to manually): ${row.id} — ${row.client_name} — ${row.lead_name} — ${row.classification}`);
      continue;
    }

    console.log(`[Backfill] ${apply ? 'POSTING' : 'WOULD POST'}: ${row.id} — ${row.client_name} — ${row.platform} — ${row.lead_name} — classification="${row.classification}"`);
    console.log(`           message: ${String(row.inbound_message || '').slice(0, 150).replace(/\n/g, ' ')}`);

    if (apply) {
      try {
        const result = await slack.postAlert(row.slack_bot_token, row.slack_channel_id, {
          leadName: row.lead_name,
          platform: row.platform,
          classification: row.classification,
          inboundMessage: row.inbound_message,
          reasoning: 'Backfilled — this reply was silently muted earlier today by a notification bug and never reached Slack.',
        });
        await db.query('UPDATE pending_replies SET slack_message_ts = $1, updated_at = now() WHERE id = $2', [result.ts, row.id]);
        posted++;
      } catch (err) {
        console.error(`[Backfill] Failed to post for ${row.id}`, { err: err.message });
      }
    }
  }

  await db.end();
  console.log(`[Backfill] Done. ${apply ? `Posted ${posted}` : `Would post ${rows.length - skippedManual}`}, skipped ${skippedManual} already-handled manually.`);
}

main().catch((err) => {
  console.error('[Backfill] Failed:', err.message);
  process.exit(1);
});
