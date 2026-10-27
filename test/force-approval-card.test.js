/**
 * force: true on the admin card endpoints posts a NEW pending row and card,
 * even when a card exists or a send failed. Never sends. Refuses an
 * unsubscribed or disqualified lead.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const db = require('../src/db');
const { postStoredHeyreachApprovalCard } = require('../src/services/heyreach-approval-card');
const force = require('../src/services/force-approval-card');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const THREAD_TS = '1793045289.147269';

function sourceRow(overrides = {}) {
  return {
    id: 'src-row',
    client_id: 'client-1',
    client_name: 'Client One',
    platform: 'heyreach',
    campaign_id: '777',
    campaign_name: 'Succession',
    lead_id: 'lead-9',
    lead_name: 'Test Lead',
    lead_email: null,
    linkedin_url: 'https://www.linkedin.com/in/test-lead/',
    inbound_message: 'Sure, send it over.',
    thread_context: JSON.stringify({
      heyreach: { conversationId: 'conv-1', linkedinAccountId: 55 },
      messages: [{ role: 'us', message: 'Hey' }, { role: 'prospect', message: 'Sure, send it over.' }],
    }),
    classification: 'INTERESTED',
    status: 'flagged',
    slack_message_ts: '1793045290.000100',
    slack_bot_token: 'xoxb-test',
    slack_channel_id: 'C0CLIENT01',
    active: true,
    created_at: new Date('2026-10-26T20:00:00Z'),
    ...overrides,
  };
}

/** Fake query that records SQL and serves the source row / inserts. */
function fakeQuery(row, { blockedSibling = null, sibling = null } = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/JOIN clients/.test(sql)) return { rows: [row] };
    if (/INSERT INTO pending_replies/.test(sql)) {
      return {
        rows: [{
          id: 'new-row',
          client_id: params[0],
          campaign_id: params[1],
          campaign_name: params[2],
          lead_id: params[3],
          lead_name: params[4],
          lead_email: params[5],
          linkedin_url: params[6],
          inbound_message: params[14],
          thread_context: params[15],
          classification: params[16],
          draft_reply: params[17],
          status: 'pending',
        }],
      };
    }
    if (/status = 'disqualified'/.test(sql) && /REMOVE_ME/.test(sql)) {
      return { rows: blockedSibling ? [blockedSibling] : [] };
    }
    if (/slack_message_ts IS NOT NULL/.test(sql)) return { rows: sibling ? [sibling] : [] };
    if (/UPDATE pending_replies/.test(sql)) return { rows: [] };
    throw new Error(`unexpected sql: ${sql}`);
  };
  return { query, calls };
}

const NEW_DRAFT = 'Hey, I just left you a voicemail. Still want to take a peek?';
const notDq = async () => false;

test('force posts a new row and card even when the source already has a card', async () => {
  const row = sourceRow({ status: 'pending' });
  const { query, calls } = fakeQuery(row);
  let posted = null;
  const result = await postStoredHeyreachApprovalCard({
    replyId: row.id,
    draft: NEW_DRAFT,
    force: true,
    threadTs: THREAD_TS,
    query,
    isDisqualifiedFn: notDq,
    postFn: async (args) => { posted = args; return { ts: '1793999999.000200' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.posted, true);
  assert.equal(result.forced, true);
  assert.equal(result.replyId, 'new-row');
  assert.equal(result.sourceReplyId, 'src-row');
  assert.equal(result.slackMessageTs, '1793999999.000200');
  assert.equal(result.threadTs, THREAD_TS);
  assert.equal(result.channelId, 'C0CLIENT01');

  // The card is for the NEW row, in the lead's thread, with the claim guard bypassed.
  assert.equal(posted.replyId, 'new-row');
  assert.equal(posted.card.replyId, 'new-row');
  assert.equal(posted.card.draft, NEW_DRAFT);
  assert.equal(posted.threadTs, THREAD_TS);
  assert.equal(posted.isDraft, true);
  assert.equal(typeof posted.claimFn, 'function');
  assert.equal(posted.channelId, 'C0CLIENT01');

  // Old row untouched: no UPDATE on it, no sibling/dup lookup needed.
  assert.equal(calls.some((c) => /UPDATE pending_replies/.test(c.sql)), false);
  const insert = calls.find((c) => /INSERT INTO pending_replies/.test(c.sql));
  assert.match(insert.sql, /'pending'\)/);
  assert.equal(insert.params[0], 'client-1');
  assert.equal(insert.params[2], 'Succession');
  assert.equal(insert.params[3], 'lead-9');
  assert.equal(insert.params[6], 'https://www.linkedin.com/in/test-lead/');
  assert.equal(insert.params[17], NEW_DRAFT);
  // conversation / linkedin account ids are copied so the send path works
  assert.equal(JSON.parse(insert.params[15]).heyreach.conversationId, 'conv-1');
  assert.equal(JSON.parse(insert.params[15]).heyreach.linkedinAccountId, 55);
});

test('force posts when a duplicate sibling card exists and when the send failed (flagged)', async () => {
  const row = sourceRow({ status: 'flagged', slack_message_ts: null });
  const { query } = fakeQuery(row, { sibling: { id: 'other', slack_message_ts: '1.2' } });
  const result = await postStoredHeyreachApprovalCard({
    replyId: row.id, draft: NEW_DRAFT, force: 'true', query, isDisqualifiedFn: notDq,
    postFn: async () => ({ ts: '5.6' }),
  });
  assert.equal(result.posted, true);
  assert.equal(result.forced, true);

  // Without force the same row is still refused as a duplicate (unchanged).
  const plain = await postStoredHeyreachApprovalCard({
    replyId: row.id, draft: NEW_DRAFT, query,
    postFn: async () => { throw new Error('must not post'); },
  });
  assert.equal(plain.posted, false);
  assert.equal(plain.reason, 'duplicate_card');
});

test('without force an existing card is still not duplicated', async () => {
  const row = sourceRow({ status: 'pending' });
  const { query } = fakeQuery(row);
  const result = await postStoredHeyreachApprovalCard({
    replyId: row.id, draft: NEW_DRAFT, query,
    postFn: async () => { throw new Error('must not post'); },
  });
  assert.equal(result.reason, 'card_already_posted');
});

test('force still refuses a disqualified or unsubscribed lead', async () => {
  const never = async () => { throw new Error('must not post'); };

  // disqualified_prospects entry
  let { query } = fakeQuery(sourceRow());
  await assert.rejects(
    postStoredHeyreachApprovalCard({
      replyId: 'src-row', draft: NEW_DRAFT, force: true, query,
      isDisqualifiedFn: async () => true, postFn: never,
    }),
    (err) => err.status === 409 && err.reason === 'lead_disqualified',
  );

  // the source row itself was disqualified
  ({ query } = fakeQuery(sourceRow({ status: 'disqualified' })));
  await assert.rejects(
    postStoredHeyreachApprovalCard({
      replyId: 'src-row', draft: NEW_DRAFT, force: true, query, isDisqualifiedFn: notDq, postFn: never,
    }),
    (err) => err.status === 409 && err.reason === 'lead_disqualified',
  );

  // source row classed REMOVE_ME
  ({ query } = fakeQuery(sourceRow({ classification: 'REMOVE_ME' })));
  await assert.rejects(
    postStoredHeyreachApprovalCard({
      replyId: 'src-row', draft: NEW_DRAFT, force: true, query, isDisqualifiedFn: notDq, postFn: never,
    }),
    (err) => err.status === 409 && err.reason === 'lead_unsubscribed',
  );

  // another row for the same lead was an unsubscribe
  const sibling = fakeQuery(sourceRow(), { blockedSibling: { id: 'x', status: 'suppressed' } });
  await assert.rejects(
    postStoredHeyreachApprovalCard({
      replyId: 'src-row', draft: NEW_DRAFT, force: true, query: sibling.query,
      isDisqualifiedFn: notDq, postFn: never,
    }),
    (err) => err.status === 409 && err.reason === 'lead_unsubscribed',
  );
  assert.equal(sibling.calls.some((c) => /INSERT INTO pending_replies/.test(c.sql)), false);
});

test('force does not re-post an already sent reply', async () => {
  const { query } = fakeQuery(sourceRow({ status: 'sent' }));
  const result = await postStoredHeyreachApprovalCard({
    replyId: 'src-row', draft: NEW_DRAFT, force: true, query, isDisqualifiedFn: notDq,
    postFn: async () => { throw new Error('must not post'); },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'already_sent');
});

test('a forced card that does not post is parked, not left pending', async () => {
  const row = sourceRow();
  const { query, calls } = fakeQuery(row);
  const result = await postStoredHeyreachApprovalCard({
    replyId: row.id, draft: NEW_DRAFT, force: true, query, isDisqualifiedFn: notDq,
    postFn: async () => ({ skipped: true, reason: 'lost_race', ts: null }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.posted, false);
  assert.equal(result.replyId, 'new-row');
  assert.ok(calls.some((c) => /SET status = 'skipped'/.test(c.sql) && c.params[0] === 'new-row'));

  const failing = fakeQuery(row);
  await assert.rejects(
    postStoredHeyreachApprovalCard({
      replyId: row.id, draft: NEW_DRAFT, force: true, query: failing.query, isDisqualifiedFn: notDq,
      postFn: async () => { throw new Error('slack down'); },
    }),
    /slack down/,
  );
  assert.ok(failing.calls.some((c) => /SET status = 'skipped'/.test(c.sql)));
});

test('channelId and route: followup post to another channel, buttons still use the row', async () => {
  const row = sourceRow();
  const seen = [];
  const run = (extra) => postStoredHeyreachApprovalCard({
    replyId: row.id, draft: NEW_DRAFT, force: true, query: fakeQuery(row).query,
    isDisqualifiedFn: notDq,
    postFn: async (args) => { seen.push(args); return { ts: '9.9' }; },
    ...extra,
  });

  const byId = await run({ channelId: 'C0OTHER123' });
  assert.equal(byId.channelId, 'C0OTHER123');
  assert.equal(seen[0].channelId, 'C0OTHER123');
  // The row and token still belong to the original client.
  assert.equal(seen[0].clientId, 'client-1');
  assert.equal(seen[0].token, 'xoxb-test');

  const prev = process.env.FOLLOW_UP_SLACK_CHANNEL_ID;
  delete process.env.FOLLOW_UP_SLACK_CHANNEL_ID;
  try {
    const byRoute = await run({ route: 'followup' });
    assert.equal(byRoute.channelId, 'C0BRRS8DV19');
    assert.equal(seen[1].channelId, 'C0BRRS8DV19');
  } finally {
    if (prev !== undefined) process.env.FOLLOW_UP_SLACK_CHANNEL_ID = prev;
  }

  await assert.rejects(run({ channelId: 'general' }), (e) => e.status === 400);
  await assert.rejects(run({ route: 'nonsense' }), (e) => e.status === 400);
  await assert.rejects(run({ channelId: 'C0OTHER123', route: 'followup' }), (e) => e.status === 400);
  await assert.rejects(run({ threadTs: 'not-a-ts' }), (e) => e.status === 400);
});

test('force never sends: the force path has no send code', () => {
  for (const file of ['src/services/force-approval-card.js', 'src/services/heyreach-approval-card.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /reply-send|sendHeyreachReply|sendMessage|require\('\.\/heyreach'\)/);
  }
  // Buttons resolve the client from the row, not the channel.
  const slackRoute = read('src/routes/slack.js');
  assert.match(slackRoute, /SELECT \* FROM clients WHERE id = \$1', \[reply\.client_id\]/);
});

test('parseForce and parseThreadTs', () => {
  assert.equal(force.parseForce(true), true);
  assert.equal(force.parseForce('1'), true);
  assert.equal(force.parseForce('yes'), true);
  assert.equal(force.parseForce(undefined), false);
  assert.equal(force.parseForce('false'), false);
  assert.equal(force.parseThreadTs(''), null);
  assert.equal(force.parseThreadTs(THREAD_TS), THREAD_TS);
  assert.throws(() => force.parseThreadTs('abc'), (e) => e.status === 400);
});

// --- HTTP routes (no Slack call is reached on these paths) -----------------

async function withServer(fn) {
  const { createApp } = require('../src/app');
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  const post = (url, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      port: server.address().port, path: url, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
  try { await fn(post); } finally { await new Promise((r) => server.close(r)); }
}

test('POST /admin/post-approval-card: force refuses a disqualified lead, bad channel is 400', async () => {
  const realQuery = db.query;
  const sqls = [];
  db.query = async (sql) => {
    sqls.push(sql);
    if (/FROM clients WHERE id/.test(sql)) {
      return { rows: [{ id: 'client-1', active: true, slack_bot_token: 'xoxb-test', slack_channel_id: 'C0CLIENT01' }] };
    }
    if (/FROM disqualified_prospects/.test(sql)) return { rows: [{ id: 'dq' }] };
    if (/INSERT INTO pending_replies/.test(sql)) throw new Error('must not insert');
    return { rows: [] };
  };
  try {
    await withServer(async (post) => {
      const base = {
        clientId: 'client-1', leadName: 'Test Lead', leadEmail: 'lead@example.com',
        campaignId: '1', leadId: '2', inboundMessage: 'hi', draft: 'hello',
      };
      const blocked = await post('/admin/post-approval-card', { ...base, force: true });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.reason, 'lead_disqualified');

      const badChannel = await post('/admin/post-approval-card', { ...base, force: true, channelId: 'nope' });
      assert.equal(badChannel.status, 400);
    });
  } finally {
    db.query = realQuery;
  }
  assert.equal(sqls.some((s) => /INSERT INTO pending_replies/.test(s)), false);
});

test('POST /admin/heyreach/approval-card: force + bad thread_ts is 400, disqualified is 409', async () => {
  const realQuery = db.query;
  db.query = async (sql) => {
    if (/JOIN clients/.test(sql)) return { rows: [sourceRow()] };
    if (/FROM disqualified_prospects/.test(sql)) return { rows: [{ id: 'dq' }] };
    return { rows: [] };
  };
  try {
    await withServer(async (post) => {
      const bad = await post('/admin/heyreach/approval-card', {
        replyId: 'src-row', draft: NEW_DRAFT, force: true, thread_ts: 'abc',
      });
      assert.equal(bad.status, 400);
      const dq = await post('/admin/heyreach/approval-card', {
        replyId: 'src-row', draft: NEW_DRAFT, force: true, thread_ts: THREAD_TS,
      });
      assert.equal(dq.status, 409);
      assert.equal(dq.body.reason, 'lead_disqualified');
    });
  } finally {
    db.query = realQuery;
  }
});

test('post-approval-card source: force flows to the claim guard bypass', () => {
  const src = read('src/routes/admin.js');
  assert.match(src, /force: forceRaw/);
  assert.match(src, /claimFn: forced \? forceCard\.makeForceClaim\(\) : null/);
  assert.match(src, /channelId: channelOverride \|\| client\.slack_channel_id/);
});
