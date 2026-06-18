#!/usr/bin/env node
/**
 * Clear all open Slack approval cards across every active client channel.
 *
 * Preferred (updates DB + Slack): after deploy, with WEBHOOK_TEST_SECRET:
 *   WEBHOOK_TEST_SECRET=... node scripts/clear-all-slack-alerts.js
 *
 * Slack-only fallback (no DB): scans channels and removes action buttons:
 *   node scripts/clear-all-slack-alerts.js --slack-only
 *
 * Env: BASE_URL, WEBHOOK_TEST_SECRET (optional)
 */

const { WebClient } = require('@slack/web-api');

const BASE = (process.env.BASE_URL || 'https://app-production-9354.up.railway.app').replace(/\/$/, '');
const UPDATE_DELAY_MS = parseInt(process.env.SLACK_CLEAR_DELAY_MS || '1200', 10);
const ACTION_IDS = new Set([
  'approve_reply',
  'open_edit_modal',
  'reject_reply',
  'already_replied_yes',
  'already_replied_no',
  'snooze_nudge_30',
]);

function hasActionButtons(blocks) {
  if (!Array.isArray(blocks)) return false;
  for (const block of blocks) {
    if (block.type !== 'actions' || !Array.isArray(block.elements)) continue;
    for (const el of block.elements) {
      if (el.type === 'button' && ACTION_IDS.has(el.action_id)) return true;
    }
  }
  return false;
}

function leadNameFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'prospect';
  for (const block of blocks) {
    if (block.type === 'section' && Array.isArray(block.fields)) {
      for (const f of block.fields) {
        const t = f.text || '';
        const m = t.match(/\*Lead\*\n\*([^*]+)\*/);
        if (m) return m[1].trim();
      }
    }
    if (block.type === 'section' && block.text?.text) {
      const m = block.text.text.match(/\*([^*]+)\*/);
      if (m) return m[1].trim();
    }
  }
  return 'prospect';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function clearViaAdminApi({ clientId, dryRun }) {
  const secret = process.env.WEBHOOK_TEST_SECRET;
  if (!secret) return null;
  const headers = {
    'Content-Type': 'application/json',
    'x-webhook-test-secret': secret,
  };
  const body = JSON.stringify({ clientId: clientId || undefined, dryRun: !!dryRun });
  try {
    return await fetchJson(`${BASE}/admin/alerts/clear-all`, { method: 'POST', headers, body });
  } catch (err) {
    if (String(err.message).includes('404')) return null;
    throw err;
  }
}

async function scanChannel(client, { dryRun }) {
  const slack = new WebClient(client.slack_bot_token);
  const channelId = client.slack_channel_id;
  let cursor;
  let updated = 0;
  let scanned = 0;

  do {
    const page = await slack.conversations.history({
      channel: channelId,
      limit: 200,
      cursor,
    });
    const messages = page.messages || [];
    for (const msg of messages) {
      scanned++;
      const toUpdate = [];

      if (hasActionButtons(msg.blocks)) {
        toUpdate.push(msg);
      }

      if (msg.reply_count > 0 && msg.ts && hasActionButtons(msg.blocks)) {
        try {
          const replies = await slack.conversations.replies({
            channel: channelId,
            ts: msg.ts,
            limit: 50,
          });
          for (const r of replies.messages || []) {
            if (r.ts === msg.ts) continue;
            if (hasActionButtons(r.blocks)) toUpdate.push(r);
          }
        } catch {
          // thread may be inaccessible
        }
      }

      for (const m of toUpdate) {
        const lead = leadNameFromBlocks(m.blocks);
        const text = `✅ Cleared — marked as actioned. *${lead}*`;
        if (!dryRun) {
          try {
            await slack.chat.update({
              channel: channelId,
              ts: m.ts,
              text,
              blocks: [],
            });
            updated++;
            await sleep(UPDATE_DELAY_MS);
          } catch (err) {
            console.warn(`  [${client.name}] failed ts=${m.ts}: ${err.message}`);
            await sleep(UPDATE_DELAY_MS);
          }
        } else {
          updated++;
        }
      }
    }
    cursor = page.response_metadata?.next_cursor;
  } while (cursor);

  return { scanned, updated };
}

async function main() {
  const slackOnly = process.argv.includes('--slack-only');
  const dryRun = process.argv.includes('--dry-run');
  const clientNeedle = process.argv.find((a) => a.startsWith('--client='))?.split('=')[1];

  const clients = await fetchJson(`${BASE}/admin/clients`);
  let active = clients.filter((c) => c.active);
  if (clientNeedle) {
    active = active.filter((c) => String(c.name).toLowerCase().includes(clientNeedle.toLowerCase()));
  }
  if (!active.length) throw new Error('No active clients matched');

  if (!slackOnly) {
    const apiResult = await clearViaAdminApi({
      clientId: clientNeedle ? active[0]?.id : undefined,
      dryRun,
    });
    if (apiResult) {
      console.log('[Clear] DB + Slack via admin API:', JSON.stringify(apiResult, null, 2));
      return;
    }
    console.log('[Clear] Admin API unavailable (deploy latest or set WEBHOOK_TEST_SECRET); using Slack scan fallback');
  }

  let totalUpdated = 0;
  for (const client of active) {
    console.log(`[Clear] Scanning #${client.slack_channel_id} (${client.name})...`);
    const { scanned, updated } = await scanChannel(client, { dryRun });
    console.log(`  scanned ${scanned} messages, cleared ${updated} cards`);
    totalUpdated += updated;
  }
  console.log(`[Clear] Done. Slack cards cleared: ${totalUpdated}${dryRun ? ' (dry-run)' : ''}`);
  if (slackOnly || !process.env.WEBHOOK_TEST_SECRET) {
    console.log('\nNote: Slack-only mode does not update the database. Deploy + run without --slack-only to stop future digests counting these as open.');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
