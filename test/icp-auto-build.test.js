const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  inIcpBuildWindow,
  runAutomaticIcpBuilds,
  icpAutoBuildEnabled,
  ICP_CALL_LOOKBACK_MS,
} = require('../src/services/icp-auto-build');
const { isNoIcpVerdict, regradeNoIcpCards } = require('../src/services/regrade-no-icp-cards');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('ICP auto-build window is weekdays 6am-8pm CT', () => {
  // Wednesday 1pm CT (18:00 UTC in CDT)
  assert.equal(inIcpBuildWindow(new Date('2026-10-14T18:00:00Z')), true);
  // Wednesday 5am CT (10:00 UTC CDT)
  assert.equal(inIcpBuildWindow(new Date('2026-10-14T10:00:00Z')), false);
  // Wednesday 9pm CT (02:00 UTC Thursday CDT)
  assert.equal(inIcpBuildWindow(new Date('2026-10-15T02:00:00Z')), false);
  // Saturday noon CT
  assert.equal(inIcpBuildWindow(new Date('2026-10-17T17:00:00Z')), false);
});

test('DISABLE_ICP_AUTO_BUILD turns the job off', () => {
  assert.equal(icpAutoBuildEnabled({}), true);
  assert.equal(icpAutoBuildEnabled({ DISABLE_ICP_AUTO_BUILD: '1' }), false);
});

test('automatic build writes skipped_existing and retries stale needs_review', async () => {
  const now = Date.parse('2026-10-15T18:00:00Z');
  const ensured = [];
  const db = {
    query: async (sql) => {
      if (/FROM clients/.test(sql)) {
        return {
          rows: [
            { id: '1', name: 'bcp', active: true, icp_status: null },
            { id: '2', name: 'New Co LLC', active: true, icp_status: 'needs_review', icp_built_at: '2026-10-14T12:00:00Z' },
            { id: '3', name: 'Fresh Review LLC', active: true, icp_status: 'needs_review', icp_built_at: '2026-10-15T16:00:00Z' },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const counts = await runAutomaticIcpBuilds({
    db,
    now,
    ensureFn: async (client) => {
      ensured.push(client.id);
      if (client.name === 'bcp') {
        return { status: 'skipped_existing', reason: 'existing_variant', transcript_count: 0 };
      }
      return { status: 'needs_review', reason: 'no_calls', transcript_count: 0 };
    },
    regradeFn: async () => ({ updated: 0 }),
  });
  assert.deepEqual(ensured, ['1', '2']);
  assert.equal(counts.skipped_existing, 2); // fresh review + bcp skip
  assert.equal(counts.needs_review, 1);
  assert.equal(counts.no_calls, 1);
  assert.ok(!JSON.stringify(counts).includes('New Co'));
});

test('ready ICP re-grades no-ICP cards in place and never posts', async () => {
  const posted = [];
  const updated = [];
  const db = {
    query: async (sql) => {
      if (/FROM pending_replies/.test(sql)) {
        return {
          rows: [
            {
              id: 'r1',
              status: 'pending',
              classification: 'QUESTION',
              draft_reply: 'draft',
              inbound_message: 'when can we talk?',
              slack_message_ts: '123.4',
              lead_name: 'redacted',
              lead_email: 'a@example.test',
              lead_website: 'https://example.test',
              icp_verdict: { status: 'unknown', reason: 'no ICP' },
              platform: 'smartlead',
              campaign_id: 'c1',
              slack_bot_token: 'xoxb-t',
              slack_channel_id: 'C1',
              client_name: 'redacted-client',
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const counts = await regradeNoIcpCards({
    clientId: 'client-1',
    dbClient: db,
    resolveIcp: async () => ({ status: 'qualified', reason: 'fits HVAC', confidence: 80 }),
    updateCard: async (_api, args) => {
      updated.push(args.ts);
      return { ok: true };
    },
    slackApi: {
      postDraftApproval: async () => { posted.push('draft'); },
      postAlert: async () => { posted.push('alert'); },
    },
  });
  assert.equal(counts.scanned, 1);
  assert.equal(counts.updated, 1);
  assert.deepEqual(updated, ['123.4']);
  assert.equal(posted.length, 0);
  assert.ok(!JSON.stringify(counts).includes('redacted'));
});

test('isNoIcpVerdict matches the stored reason only', () => {
  assert.equal(isNoIcpVerdict({ status: 'unknown', reason: 'no ICP' }), true);
  assert.equal(isNoIcpVerdict({ status: 'unknown', reason: 'no website' }), false);
  assert.equal(isNoIcpVerdict({ status: 'qualified', reason: 'fits' }), false);
});

test('automatic build searches Fireflies across a 90 day window', async () => {
  const seen = [];
  const db = {
    query: async () => ({
      rows: [{ id: '1', name: 'New Co LLC', active: true, icp_status: null }],
    }),
  };
  await runAutomaticIcpBuilds({
    db,
    now: Date.parse('2026-10-15T18:00:00Z'),
    ensureFn: async (_client, opts) => {
      seen.push(opts.callLookbackMs);
      return { status: 'needs_review', reason: 'no_calls', transcript_count: 0 };
    },
    regradeFn: async () => ({ updated: 0 }),
  });
  assert.equal(ICP_CALL_LOOKBACK_MS, 90 * 24 * 60 * 60 * 1000);
  assert.deepEqual(seen, [ICP_CALL_LOOKBACK_MS]);
});

test('cron and admin wire automatic ICP + rebuild', () => {
  const cron = read('src/cron.js');
  const admin = read('src/routes/admin.js');
  assert.match(cron, /runAutomaticIcpBuilds/);
  assert.match(cron, /0 6-20 \* \* 1-5/);
  assert.match(cron, /\[Startup\] ICP auto-build/);
  assert.match(admin, /\/admin\/clients\/:clientId\/rebuild-icp/);
  assert.match(admin, /force/);
});
