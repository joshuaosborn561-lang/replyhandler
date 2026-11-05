/**
 * POST /admin/prospects/dq — dry run by default, one lead, same write as Slack DQ.
 * The database is an in-memory stand-in for the SQL this route and markDisqualified run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT = '22222222-2222-4222-8222-222222222222';
const ORPHAN = 'ef912971-bd11-47a9-8f5b-f291ea3a0477';
const CARD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SUPPRESSED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const HEYREACH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const OTHER_LEAD = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const OTHER_CLIENT_REPLY = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const SEQ = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const STEP_PENDING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
const STEP_POSTED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';
const FU_THREAD = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
const FU_EMAIL = 'ffffffff-ffff-4fff-8fff-fffffffffff2';
const FU_HEY = 'ffffffff-ffff-4fff-8fff-fffffffffff3';
const FU_OTHER = 'ffffffff-ffff-4fff-8fff-fffffffffff4';
const EMAIL = 'michael.kovacina@example.com';
const LEAD_ID = '99887766';
const KEY = 'test-admin-key-not-a-secret';

function norm(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function emailOf(value) {
  return String(value || '').trim().toLowerCase();
}

function coalesce(value) {
  return value == null ? '' : String(value);
}

function clone(row) {
  return row ? { ...row } : row;
}

function createStore() {
  const tables = {
    clients: [],
    pending_replies: [],
    disqualified_prospects: [],
    followup_sequences: [],
    followup_sequence_steps: [],
    outbound_follow_ups: [],
  };
  const state = { writes: 0 };

  function dqMatch(row, params) {
    if (String(row.client_id) !== String(params[0])) return false;
    const email = params[1] || '';
    const platform = params[2] || '';
    const lead = params[3] || '';
    const camp = params[4] || '';
    const conv = params[5] || '';
    const li = params[6] || '';
    if (email && emailOf(row.lead_email) === email) return true;
    if (row.platform === platform && lead && coalesce(row.lead_id) === lead
      && (platform === 'heyreach' || coalesce(row.campaign_id) === camp)) return true;
    if (row.platform === 'heyreach' && conv && coalesce(row.conversation_id) === conv) return true;
    if (li && row.linkedin_url && row.linkedin_url === li) return true;
    return false;
  }

  async function query(sql, params = []) {
    const s = norm(sql);
    const write = /^(update|insert|delete)\b/i.test(s);
    if (write) state.writes += 1;

    if (s.startsWith('INSERT INTO disqualified_prospects')) {
      const row = {
        id: `dq-${tables.disqualified_prospects.length + 1}`,
        client_id: params[0],
        platform: params[1],
        campaign_id: params[2],
        lead_id: params[3],
        conversation_id: params[4],
        lead_email: params[5],
        linkedin_url: params[6],
        lead_name: params[7],
        source_pending_reply_id: params[8],
        reason: params[9],
        created_by_slack_user: params[10],
      };
      tables.disqualified_prospects.push(row);
      return { rows: [clone(row)], rowCount: 1 };
    }

    if (s.startsWith('UPDATE outbound_follow_ups') && s.includes("status = 'cancelled'")) {
      const hit = tables.outbound_follow_ups.filter((row) => row.status === 'pending'
        && String(row.client_id) === String(params[0])
        && row.platform === params[1]
        && coalesce(row.campaign_id) === coalesce(params[2])
        && coalesce(row.lead_id) === coalesce(params[3])
        && coalesce(row.conversation_id) === coalesce(params[4]));
      for (const row of hit) row.status = 'cancelled';
      return { rows: [], rowCount: hit.length };
    }

    if (s.startsWith('UPDATE outbound_follow_ups') && s.includes('skip_reason')) {
      const hit = tables.outbound_follow_ups.filter((row) => row.status === 'pending'
        && String(row.client_id) === String(params[0])
        && emailOf(row.lead_email) === params[1]);
      for (const row of hit) {
        row.status = 'skipped';
        row.skip_reason = 'disqualified';
      }
      return { rows: [], rowCount: hit.length };
    }

    if (s.startsWith('UPDATE pending_replies') && s.includes('IS DISTINCT FROM')) {
      const hit = tables.pending_replies.filter((row) => String(row.client_id) === String(params[0])
        && row.platform === params[1]
        && ['pending', 'alert_only', 'flagged'].includes(row.status)
        && String(row.id) !== String(params[2])
        && ((params[3] && coalesce(row.lead_id) === params[3])
          || (params[4] && emailOf(row.lead_email) === params[4])));
      for (const row of hit) {
        row.status = 'disqualified';
        row.draft_reply = null;
      }
      return { rows: hit.map(clone), rowCount: hit.length };
    }

    if (s.startsWith('UPDATE pending_replies') && s.includes('id = ANY')) {
      const ids = new Set((params[1] || []).map((id) => String(id).toLowerCase()));
      const hit = tables.pending_replies.filter((row) => String(row.client_id) === String(params[0])
        && ids.has(String(row.id).toLowerCase())
        && ['pending', 'alert_only', 'flagged'].includes(row.status));
      for (const row of hit) {
        row.status = 'disqualified';
        row.draft_reply = null;
      }
      return { rows: hit.map((row) => ({ id: row.id })), rowCount: hit.length };
    }

    if (s.startsWith('UPDATE pending_replies') && s.includes("status = 'skipped'")) {
      const hit = tables.pending_replies.filter((row) => String(row.id) === String(params[0])
        && ['pending', 'flagged'].includes(row.status));
      for (const row of hit) row.status = 'skipped';
      return { rows: [], rowCount: hit.length };
    }

    if (s.startsWith('UPDATE pending_replies') && s.includes("status = 'disqualified'")) {
      const hit = tables.pending_replies.filter((row) => String(row.id) === String(params[0])
        && ['pending', 'alert_only', 'flagged'].includes(row.status));
      for (const row of hit) {
        row.status = 'disqualified';
        row.draft_reply = null;
      }
      return { rows: [], rowCount: hit.length };
    }

    if (s.startsWith('UPDATE followup_sequences')) {
      const hit = tables.followup_sequences.filter((row) => String(row.id) === String(params[0]) && row.status === 'active');
      for (const row of hit) {
        row.status = 'stopped';
        row.stop_reason = params[1];
      }
      return { rows: hit.map((row) => ({ id: row.id, client_id: row.client_id })), rowCount: hit.length };
    }

    if (s.startsWith('UPDATE followup_sequence_steps')) {
      const hit = tables.followup_sequence_steps.filter((row) => String(row.sequence_id) === String(params[0])
        && ['pending', 'held', 'posting'].includes(row.status));
      for (const row of hit) {
        row.status = 'cancelled';
        row.skip_reason = params[1];
      }
      return { rows: [], rowCount: hit.length };
    }

    if (s.includes('FROM disqualified_prospects') && s.startsWith('SELECT')) {
      const hit = tables.disqualified_prospects.filter((row) => dqMatch(row, params));
      return { rows: hit.slice(0, 1).map((row) => ({ id: row.id })), rowCount: hit.length ? 1 : 0 };
    }

    if (s.includes('FROM pending_replies') && s.includes('lower(coalesce(lead_email')) {
      const email = params[0] || '';
      const leadId = params[1] || '';
      const clientId = params[2];
      const hit = tables.pending_replies.filter((row) => {
        if (clientId && String(row.client_id) !== String(clientId)) return false;
        const emailHit = email && emailOf(row.lead_email) === email;
        const idHit = leadId && row.platform === 'smartlead' && coalesce(row.lead_id) === leadId;
        return emailHit || idHit;
      });
      return { rows: hit.map(clone), rowCount: hit.length };
    }

    if (s.includes('FROM pending_replies') && s.includes('ANY($2::text[])')) {
      const emails = params[1] || [];
      const leadIds = params[2] || [];
      const hit = tables.pending_replies.filter((row) => String(row.client_id) === String(params[0])
        && ((emails.length && emails.includes(emailOf(row.lead_email)))
          || (leadIds.length && row.platform === 'smartlead' && leadIds.includes(coalesce(row.lead_id)))));
      return { rows: hit.map(clone), rowCount: hit.length };
    }

    if (s.includes('FROM pending_replies') && s.includes('id = ANY')) {
      const ids = new Set((params[0] || []).map((id) => String(id).toLowerCase()));
      const hit = tables.pending_replies.filter((row) => ids.has(String(row.id).toLowerCase()));
      return { rows: hit.map(clone), rowCount: hit.length };
    }

    if (s.includes('SELECT status FROM pending_replies')) {
      const row = tables.pending_replies.find((item) => String(item.id) === String(params[0]));
      return { rows: row ? [{ status: row.status }] : [], rowCount: row ? 1 : 0 };
    }

    if (s.includes('FROM followup_sequences') && s.includes('client_id = $1') && s.includes("status = 'active'")) {
      const hit = tables.followup_sequences.filter((row) => String(row.client_id) === String(params[0]) && row.status === 'active');
      return { rows: hit.map(clone), rowCount: hit.length };
    }

    if (s.includes('FROM followup_sequences') && s.includes('source_reply_id')) {
      const key = params[1] || '';
      const hit = tables.followup_sequences.filter((row) => row.status === 'active'
        && (String(row.source_reply_id) === String(params[0]) || (key && row.lead_key === key)));
      return { rows: hit.map((row) => ({ id: row.id })), rowCount: hit.length };
    }

    if (s.includes('FROM followup_sequence_steps') && s.includes('sequence_id = ANY')) {
      const ids = new Set((params[0] || []).map((id) => String(id)));
      const hit = tables.followup_sequence_steps.filter((row) => ids.has(String(row.sequence_id))
        && ['pending', 'held', 'posting'].includes(row.status));
      return { rows: hit.map(clone), rowCount: hit.length };
    }

    if (s.includes('FROM followup_sequence_steps') && s.includes("status = 'posted'")) {
      const hit = tables.followup_sequence_steps.filter((row) => String(row.sequence_id) === String(params[0])
        && row.status === 'posted' && row.slack_ts);
      return { rows: hit.map(clone), rowCount: hit.length };
    }

    if (s.includes('FROM outbound_follow_ups') && s.startsWith('SELECT')) {
      const hit = tables.outbound_follow_ups.filter((row) => String(row.client_id) === String(params[0]) && row.status === 'pending');
      return { rows: hit.map(clone), rowCount: hit.length };
    }

    if (s.includes('FROM clients') && s.startsWith('SELECT')) {
      const row = tables.clients.find((item) => String(item.id) === String(params[0]));
      return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`unexpected sql: ${s}`);
  }

  return { query, tables, state };
}

const store = createStore();
const slackCalls = [];
const dbPath = require.resolve('../src/db');
const slackPath = require.resolve('../src/services/slack');
const slackRoutePath = require.resolve('../src/routes/slack');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: store };
require.cache[slackPath] = {
  id: slackPath,
  filename: slackPath,
  loaded: true,
  exports: new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then' || typeof prop !== 'string') return undefined;
      return async (...args) => {
        slackCalls.push(prop);
        return { ok: true, ts: '1.2' };
      };
    },
  }),
};
const slackRouter = function slackRouterStub() {};
slackRouter.cardHelpers = {
  slackCardContextFromReply: async () => ({ leadName: 'Michael Kovacina' }),
  sentCardPayload: () => ({ text: 'DQ', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'DQ' } }] }),
};
require.cache[slackRoutePath] = {
  id: slackRoutePath,
  filename: slackRoutePath,
  loaded: true,
  exports: slackRouter,
};

const { resolveDryRun } = require('../src/services/admin-prospect-dq');

function seed() {
  for (const name of Object.keys(store.tables)) store.tables[name].length = 0;
  store.state.writes = 0;
  slackCalls.length = 0;
  store.tables.clients.push(
    { id: CLIENT, name: 'Goliath', slack_bot_token: 'xoxb-test', slack_channel_id: 'C1', smartlead_api_key: 'stored' },
    { id: OTHER_CLIENT, name: 'Other', slack_bot_token: 'xoxb-test', slack_channel_id: 'C2', smartlead_api_key: 'stored' },
  );
  const base = {
    client_id: CLIENT,
    platform: 'smartlead',
    campaign_id: '555',
    lead_id: LEAD_ID,
    lead_email: EMAIL,
    lead_name: 'Michael Kovacina',
    classification: 'INTERESTED',
    draft_reply: 'Happy to jump on a call.',
    updated_at: '2026-11-05T12:00:00Z',
  };
  store.tables.pending_replies.push(
    { ...base, id: ORPHAN, status: 'pending', slack_message_ts: null, draft_reply: 'Orphan draft' },
    { ...base, id: CARD, status: 'pending', slack_message_ts: '1700000000.000100' },
    { ...base, id: SENT, status: 'sent', slack_message_ts: '1700000000.000050', draft_reply: null, sent_reply: 'Sent already' },
    { ...base, id: SUPPRESSED, status: 'suppressed', slack_message_ts: null, draft_reply: null },
    {
      ...base,
      id: HEYREACH,
      platform: 'heyreach',
      campaign_id: 'hr-camp',
      lead_id: 'hr-9',
      status: 'pending',
      slack_message_ts: null,
      thread_context: { heyreach: { conversationId: 'conv-9' } },
      draft_reply: 'LinkedIn draft',
    },
    {
      id: OTHER_LEAD,
      client_id: CLIENT,
      platform: 'smartlead',
      campaign_id: '1',
      lead_id: '111',
      lead_email: 'other.person@example.com',
      lead_name: 'Other Person',
      classification: 'INTERESTED',
      status: 'pending',
      draft_reply: 'Leave me',
      slack_message_ts: '1700000000.000300',
    },
    {
      id: OTHER_CLIENT_REPLY,
      client_id: OTHER_CLIENT,
      platform: 'smartlead',
      campaign_id: '9',
      lead_id: '555',
      lead_email: EMAIL,
      lead_name: 'Michael Kovacina',
      classification: 'INTERESTED',
      status: 'pending',
      draft_reply: 'Other client',
      slack_message_ts: null,
    },
  );
  store.tables.followup_sequences.push({
    id: SEQ,
    client_id: CLIENT,
    source_reply_id: CARD,
    platform: 'smartlead',
    campaign_id: '555',
    lead_key: `${CLIENT}|${EMAIL}`,
    status: 'active',
    stop_reason: null,
  });
  store.tables.followup_sequence_steps.push(
    {
      id: STEP_PENDING, sequence_id: SEQ, kind: 'call_day1', status: 'pending', slack_ts: null, pending_reply_id: null,
    },
    {
      id: STEP_POSTED,
      sequence_id: SEQ,
      kind: 'call_day0',
      status: 'posted',
      slack_channel: 'C9',
      slack_ts: '1700000000.000200',
      outcome: null,
      pending_reply_id: null,
    },
  );
  store.tables.outbound_follow_ups.push(
    {
      id: FU_THREAD, client_id: CLIENT, platform: 'smartlead', campaign_id: '555', lead_id: LEAD_ID,
      conversation_id: null, lead_email: EMAIL, status: 'pending',
    },
    {
      id: FU_EMAIL, client_id: CLIENT, platform: 'smartlead', campaign_id: '777', lead_id: LEAD_ID,
      conversation_id: null, lead_email: EMAIL, status: 'pending',
    },
    {
      id: FU_HEY, client_id: CLIENT, platform: 'heyreach', campaign_id: 'hr-camp', lead_id: 'hr-9',
      conversation_id: 'conv-9', lead_email: EMAIL, status: 'pending',
    },
    {
      id: FU_OTHER, client_id: CLIENT, platform: 'smartlead', campaign_id: '1', lead_id: '111',
      conversation_id: null, lead_email: 'other.person@example.com', status: 'pending',
    },
  );
}

function row(table, id) {
  return store.tables[table].find((item) => String(item.id) === String(id));
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('POST /admin/prospects/dq dry-runs by default and disqualifies one lead', async (t) => {
  const previous = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = KEY;
  const app = express();
  app.use(express.json());
  app.use(require('../src/routes/admin-prospect-dq'));
  const server = await listen(app);
  const { port } = server.address();

  async function post(body, { headers, path: urlPath = '/admin/prospects/dq' } = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json();
    return { status: res.status, json };
  }

  const payload = {
    leadEmail: 'Michael.Kovacina@Example.com',
    leadId: LEAD_ID,
    clientId: CLIENT,
    pendingReplyIds: [ORPHAN],
    actor: 'cayden',
    note: 'close orphan card',
  };

  try {
    await t.test('auth failure does not write', async () => {
      seed();
      const missing = await post(payload, { headers: {} });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error, 'unauthorized');
      assert.equal(JSON.stringify(missing.json).includes(KEY), false);

      const wrong = await post(payload, { headers: { ADMIN_API_KEY: 'wrong-key' } });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.json.error, 'unauthorized');

      delete process.env.ADMIN_API_KEY;
      const closed = await post(payload, { headers: { ADMIN_API_KEY: KEY, 'x-admin-api-key': KEY } });
      assert.equal(closed.status, 503);
      assert.equal(closed.json.error, 'admin auth not configured');
      process.env.ADMIN_API_KEY = KEY;

      assert.equal(store.state.writes, 0);
      assert.equal(store.tables.disqualified_prospects.length, 0);
      assert.equal(row('pending_replies', ORPHAN).status, 'pending');
      assert.equal(slackCalls.length, 0);
    });

    await t.test('no match and a different lead are refused', async () => {
      seed();
      const none = await post(
        { leadEmail: 'nobody@example.com', clientId: CLIENT },
        { headers: { ADMIN_API_KEY: KEY } },
      );
      assert.equal(none.status, 404);
      assert.equal(none.json.error, 'no_match');

      const mismatch = await post(
        { leadEmail: EMAIL, leadId: '111', clientId: CLIENT },
        { headers: { ADMIN_API_KEY: KEY } },
      );
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.json.error, 'ambiguous_lead');

      const otherCard = await post(
        { leadEmail: EMAIL, clientId: CLIENT, pendingReplyIds: [OTHER_LEAD] },
        { headers: { ADMIN_API_KEY: KEY } },
      );
      assert.equal(otherCard.status, 409);
      assert.equal(otherCard.json.error, 'pending_reply_not_this_lead');

      const missingId = await post(
        { leadEmail: EMAIL, clientId: CLIENT, pendingReplyIds: ['abababab-abab-4aba-8aba-abababababab'] },
        { headers: { ADMIN_API_KEY: KEY } },
      );
      assert.equal(missingId.status, 404);
      assert.equal(missingId.json.error, 'pending_reply_not_found');

      const twoClients = await post({ leadEmail: EMAIL }, { headers: { ADMIN_API_KEY: KEY } });
      assert.equal(twoClients.status, 409);
      assert.equal(twoClients.json.error, 'ambiguous_lead');
      assert.equal(twoClients.json.clients.length, 2);

      const bad = await post({}, { headers: { ADMIN_API_KEY: KEY } });
      assert.equal(bad.status, 400);

      assert.equal(store.state.writes, 0);
      assert.equal(row('pending_replies', ORPHAN).status, 'pending');
      assert.equal(row('pending_replies', OTHER_LEAD).status, 'pending');
      assert.equal(row('pending_replies', OTHER_CLIENT_REPLY).status, 'pending');
    });

    await t.test('dry run lists rows per table and writes nothing', async () => {
      seed();
      const alias = await post(payload, { headers: { 'x-admin-api-key': KEY } });
      assert.equal(alias.status, 200);
      assert.equal(alias.json.dryRun, true);
      assert.equal(alias.json.already, false);
      assert.equal(alias.json.reason, 'admin_dq');
      assert.equal(alias.json.actor, 'cayden | close orphan card');
      assert.equal(alias.json.lead.clientId, CLIENT);
      assert.equal(alias.json.lead.leadEmail, EMAIL);
      assert.deepEqual(alias.json.counts, {
        disqualified_prospects: 1,
        pending_replies: 3,
        followup_sequences: 1,
        followup_sequence_steps: 1,
        outbound_follow_ups: 3,
      });
      assert.equal(alias.json.tables.disqualified_prospects[0].source_pending_reply_id, ORPHAN);
      assert.equal(alias.json.tables.disqualified_prospects[0].reason, 'admin_dq');
      assert.equal(alias.json.tables.disqualified_prospects[0].created_by_slack_user, 'cayden | close orphan card');
      const closed = alias.json.tables.pending_replies.map((item) => item.id).sort();
      assert.deepEqual(closed, [CARD, HEYREACH, ORPHAN].sort());
      assert.equal(alias.json.tables.pending_replies.find((item) => item.id === ORPHAN).slack_message_ts, null);
      assert.equal(alias.json.tables.followup_sequence_steps[0].kind, 'call_day1');
      assert.equal(alias.json.tables.followup_sequence_steps[0].to, 'cancelled');
      const followUps = Object.fromEntries(alias.json.tables.outbound_follow_ups.map((item) => [item.id, item.to]));
      assert.equal(followUps[FU_THREAD], 'cancelled');
      assert.equal(followUps[FU_HEY], 'cancelled');
      assert.equal(followUps[FU_EMAIL], 'skipped');
      assert.equal(followUps[FU_OTHER], undefined);
      assert.equal(alias.json.lead.replyIds.includes(OTHER_LEAD), false);
      assert.equal(alias.json.lead.replyIds.includes(OTHER_CLIENT_REPLY), false);
      assert.equal(alias.json.lead.replyIds.includes(SENT), true);
      assert.equal(JSON.stringify(alias.json).includes(KEY), false);
      assert.equal(store.state.writes, 0);
      assert.equal(row('pending_replies', ORPHAN).status, 'pending');
      assert.equal(row('pending_replies', ORPHAN).draft_reply, 'Orphan draft');
      assert.equal(row('followup_sequences', SEQ).status, 'active');
      assert.equal(row('outbound_follow_ups', FU_THREAD).status, 'pending');
      assert.equal(slackCalls.length, 0);
    });

    await t.test('real run matches the dry-run rows and leaves every other lead', async () => {
      seed();
      const dry = await post(payload, { headers: { ADMIN_API_KEY: KEY } });
      assert.equal(dry.json.dryRun, true);
      assert.equal(store.state.writes, 0);
      const live = await post({ ...payload, dryRun: false }, { headers: { ADMIN_API_KEY: KEY } });
      assert.equal(live.status, 200);
      assert.equal(live.json.dryRun, false);
      assert.deepEqual(live.json.counts, dry.json.counts);
      assert.equal(live.json.result.cancelledFollowUps, 2);
      assert.equal(live.json.result.skippedFollowUps, 1);
      assert.equal(live.json.result.slackCards.retired, 1);
      assert.equal(live.json.result.already, false);

      const dq = store.tables.disqualified_prospects;
      assert.equal(dq.length, 1);
      assert.equal(dq[0].reason, 'admin_dq');
      assert.equal(dq[0].created_by_slack_user, 'cayden | close orphan card');
      assert.equal(dq[0].source_pending_reply_id, ORPHAN);
      assert.equal(dq[0].lead_email, EMAIL);
      assert.equal(dq[0].lead_id, LEAD_ID);
      assert.equal(dq[0].client_id, CLIENT);

      assert.equal(row('pending_replies', ORPHAN).status, 'disqualified');
      assert.equal(row('pending_replies', ORPHAN).draft_reply, null);
      assert.equal(row('pending_replies', CARD).status, 'disqualified');
      assert.equal(row('pending_replies', CARD).draft_reply, null);
      assert.equal(row('pending_replies', HEYREACH).status, 'disqualified');
      assert.equal(row('pending_replies', SENT).status, 'sent');
      assert.equal(row('pending_replies', SENT).sent_reply, 'Sent already');
      assert.equal(row('pending_replies', SUPPRESSED).status, 'suppressed');
      assert.equal(row('pending_replies', OTHER_LEAD).status, 'pending');
      assert.equal(row('pending_replies', OTHER_LEAD).draft_reply, 'Leave me');
      assert.equal(row('pending_replies', OTHER_CLIENT_REPLY).status, 'pending');

      assert.equal(row('followup_sequences', SEQ).status, 'stopped');
      assert.equal(row('followup_sequences', SEQ).stop_reason, 'disqualified');
      assert.equal(row('followup_sequence_steps', STEP_PENDING).status, 'cancelled');
      assert.equal(row('followup_sequence_steps', STEP_PENDING).skip_reason, 'sequence_disqualified');
      assert.equal(row('followup_sequence_steps', STEP_POSTED).status, 'posted');

      assert.equal(row('outbound_follow_ups', FU_THREAD).status, 'cancelled');
      assert.equal(row('outbound_follow_ups', FU_HEY).status, 'cancelled');
      assert.equal(row('outbound_follow_ups', FU_EMAIL).status, 'skipped');
      assert.equal(row('outbound_follow_ups', FU_EMAIL).skip_reason, 'disqualified');
      assert.equal(row('outbound_follow_ups', FU_OTHER).status, 'pending');

      assert.ok(slackCalls.includes('updateSentConfirmationCard'));
      assert.ok(slackCalls.includes('updateMessage'));
      assert.equal(JSON.stringify(live.json).includes(KEY), false);

      const again = await post(
        { leadEmail: EMAIL, clientId: CLIENT, dryRun: 'false' },
        { headers: { ADMIN_API_KEY: KEY } },
      );
      assert.equal(again.status, 200);
      assert.equal(again.json.dryRun, false);
      assert.equal(again.json.already, true);
      assert.equal(again.json.result.already, true);
      assert.equal(again.json.counts.disqualified_prospects, 0);
      assert.equal(again.json.counts.pending_replies, 0);
      assert.equal(store.tables.disqualified_prospects.length, 1);
      assert.equal(row('pending_replies', OTHER_LEAD).status, 'pending');
    });
  } finally {
    if (previous === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dryRun only writes when the caller passes false', () => {
  assert.equal(resolveDryRun(undefined), true);
  assert.equal(resolveDryRun(''), true);
  assert.equal(resolveDryRun(true), true);
  assert.equal(resolveDryRun('true'), true);
  assert.equal(resolveDryRun('yes'), true);
  assert.equal(resolveDryRun(false), false);
  assert.equal(resolveDryRun('false'), false);
  assert.equal(resolveDryRun('0'), false);
  assert.equal(resolveDryRun(0), false);
});

test('the DQ route is authed on its own router and the open admin router stays open', () => {
  const route = read('src/routes/admin-prospect-dq.js');
  const admin = read('src/routes/admin.js');
  const app = read('src/app.js');
  const decisions = read('DECISIONS.md');
  assert.match(route, /\/admin\/prospects\/dq/);
  assert.match(route, /requireAdminApiKey/);
  assert.match(route, /dqProspect/);
  assert.doesNotMatch(route, /console\.(log|info|warn|error|debug)\([^)]*ADMIN_API_KEY/);
  assert.doesNotMatch(admin, /requireAdminApiKey/);
  assert.doesNotMatch(admin, /\/admin\/prospects\/dq/);
  assert.match(app, /admin-prospect-dq/);
  assert.doesNotMatch(app, /requireAdminApiKey/);
  assert.match(decisions, /Admin DQ route for one prospect/);
  assert.match(decisions, /POST \/admin\/prospects\/dq dry-runs by default and disqualifies one lead/);
  assert.match(decisions, /no route requires ADMIN_API_KEY/);
  assert.match(read('src/services/admin-prospect-dq.js'), /markDisqualified/);
  assert.match(read('src/routes/slack.js'), /reason: 'slack_dq'/);
});
