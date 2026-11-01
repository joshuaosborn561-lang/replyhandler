/**
 * Admin: POST /admin/ghosted-meetings/enroll and POST /admin/cards/:id/status.
 * Runs on a real Postgres (PGlite, in memory; dev-only, skipped when not installed).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { /* skip below */ }
const skip = PGlite ? false : 'PGlite not installed (dev-only integration test)';

for (const k of ['ALLO_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'FIREFLIES_API_KEY', 'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];
process.env.GHOSTED_MEETING_ENABLED = 'true';

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ─── source guards (no database needed) ──────────────────────────────────────

test('the new admin services cannot send to a lead', () => {
  for (const f of ['src/services/ghosted-manual-enroll.js', 'src/services/card-status-admin.js']) {
    const s = read(f);
    assert.ok(!/sendReplyToPlatform|reply-send|gmail-send|heyreach\.send|smartlead\.send|chat\.postMessage|postProspectSlackCard/i.test(s), f);
  }
});

test('the routes are registered and take no key, like the other admin routes', () => {
  const s = read('src/routes/admin.js');
  assert.match(s, /router\.post\('\/admin\/ghosted-meetings\/enroll', async/);
  assert.match(s, /router\.post\('\/admin\/cards\/:id\/status', async/);
  assert.ok(!/requireAdminApiKey/.test(s));
});

// ─── database flow ────────────────────────────────────────────────────────────

let pg = null;
let schemaReady = null;
if (PGlite) {
  pg = new PGlite();
  const adapter = {
    async query(sql, params) {
      const r = await pg.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
  require.cache[require.resolve('../src/db')] = { id: 'db', filename: 'db', loaded: true, exports: adapter };
}

let clientId = null;
let n = 0;
async function setup() {
  if (!schemaReady) schemaReady = pg.exec(read('schema.sql').replace(/CREATE EXTENSION[^;]*;/gi, ''));
  await schemaReady;
  await pg.exec(`TRUNCATE ghosted_meeting_checks, followup_sequence_steps, followup_sequences, followup_card_events,
                          pending_replies, disqualified_prospects, meetings, outbound_follow_ups, client_dayof_briefs RESTART IDENTITY`);
  if (!clientId) {
    const { rows: [c] } = await pg.query(
      `INSERT INTO clients (name, slack_bot_token, slack_channel_id) VALUES ('Acme Co', 'xoxb-test', 'C1') RETURNING id`);
    clientId = c.id;
  }
}

async function addReply(over = {}) {
  n += 1;
  const row = {
    classification: 'INTERESTED', status: 'meeting_booked', slack_message_ts: `1700.${n}`, slack_channel_id: 'C1',
    lead_email: 'lead@example.com', lead_name: 'Test Lead', inbound_message: `Sounds good ${n}`,
    lead_timezone: 'America/Chicago', platform: 'smartlead', campaign_id: '111', lead_id: String(n), ...over,
  };
  const cols = Object.keys(row);
  const { rows: [r] } = await pg.query(
    `INSERT INTO pending_replies (client_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [clientId, ...cols.map((c) => row[c])]);
  return r;
}

async function withServer(fn) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(require('../src/routes/admin'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try { return await fn(call); } finally { await new Promise((r) => server.close(r)); }
}

const count = async (table) => (await pg.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const MEET = '2026-10-30T15:00:00-05:00';

test('enroll: creates one ghosted_meeting sequence + checks row, sends nothing, and is idempotent', { skip }, async () => {
  await setup();
  await addReply();
  await withServer(async (call) => {
    const first = await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'Lead@Example.com', clientId, meetingStart: MEET });
    assert.equal(first.status, 201);
    assert.equal(first.body.enrolled, true);
    assert.ok(first.body.sequenceId && first.body.checkId);
    assert.ok(!JSON.stringify(first.body).includes('lead@example.com'), 'no lead email in the response');
    assert.deepEqual(first.body.warnings, []);

    const [seq] = (await pg.query('SELECT * FROM followup_sequences')).rows;
    assert.equal(seq.origin, 'ghosted_meeting');
    assert.equal(seq.status, 'active');
    const steps = (await pg.query('SELECT kind, status, payload FROM followup_sequence_steps')).rows;
    assert.deepEqual(steps.map((s) => s.kind), ['ghost_email']);
    assert.equal(steps[0].status, 'pending'); // the runner posts the existing approval card; a human clicks it
    const [check] = (await pg.query('SELECT * FROM ghosted_meeting_checks')).rows;
    assert.equal(check.decision, 'enrolled');
    assert.equal(check.source, 'manual');
    assert.equal(check.sequence_id, seq.id);
    assert.equal(new Date(check.meeting_start).toISOString(), '2026-10-30T20:00:00.000Z');
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM pending_replies WHERE classification = $1', ['FOLLOW_UP'])).rows[0].n, 0, 'no card row written by the route');

    // Same lead again: same sequence, nothing new.
    const again = await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'lead@example.com', clientId, meetingStart: MEET });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyEnrolled, true);
    assert.equal(again.body.sequenceId, first.body.sequenceId);
    // Different meeting time for the same lead is still the same lead.
    const other = await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'lead@example.com', clientId, meetingStart: '2026-10-29T15:00:00-05:00' });
    assert.equal(other.status, 200);
    assert.equal(other.body.alreadyEnrolled, true);
    // No client given: resolved from the lead's replies; still idempotent.
    const noClient = await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'lead@example.com' });
    assert.equal(noClient.body.alreadyEnrolled, true);
    assert.equal(await count('followup_sequences'), 1);
    assert.equal(await count('followup_sequence_steps'), 1);
    assert.equal(await count('ghosted_meeting_checks'), 1);
  });
});

test('enroll: dryRun writes nothing; bad input and unknown leads are refused', { skip }, async () => {
  await setup();
  await addReply();
  await withServer(async (call) => {
    const dry = await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'lead@example.com', dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.wouldEnroll, true);
    assert.equal(await count('followup_sequences'), 0);
    assert.equal(await count('ghosted_meeting_checks'), 0);

    assert.equal((await call('POST', '/admin/ghosted-meetings/enroll', {})).status, 400);
    assert.equal((await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'lead@example.com', meetingStart: '2026-10-30 10:00' })).status, 400, 'wall clock time refused');
    assert.equal((await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'lead@example.com', meetingStart: '2099-01-01T10:00:00Z' })).status, 400, 'future meeting refused');
    assert.equal((await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'nobody@example.com' })).status, 404);
    assert.equal((await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'lead@example.com', client: 'No Such Client' })).status, 404);
    assert.equal(await count('followup_sequences'), 0);
  });
});

test('enroll: a lead with no source reply, a DQ, or an active sequence is not enrolled', { skip }, async () => {
  await setup();
  const r = await addReply({ lead_email: 'dq@example.com' });
  await addReply({ lead_email: 'busy@example.com' });
  await withServer(async (call) => {
    await pg.query(`INSERT INTO pending_replies (client_id, platform, lead_email, inbound_message, classification, status)
                    VALUES ($1, 'smartlead', 'noreply@example.com', 'x', 'FOLLOW_UP', 'sent')`, [clientId]);
    const none = await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'noreply@example.com', clientId });
    assert.equal(none.status, 409);
    assert.equal(none.body.error, 'no_source_reply');

    await pg.query(`INSERT INTO disqualified_prospects (client_id, platform, lead_email, reason) VALUES ($1, 'smartlead', 'dq@example.com', 'test')`, [clientId]);
    const dq = await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'dq@example.com', clientId });
    assert.equal(dq.status, 409);
    assert.equal(dq.body.error, 'disqualified');

    const busy = (await pg.query(`SELECT * FROM pending_replies WHERE lead_email = 'busy@example.com'`)).rows[0];
    await pg.query(`INSERT INTO followup_sequences (client_id, source_reply_id, platform, lead_key, lead_email, status, origin)
                    VALUES ($1, $2, 'smartlead', $3, 'busy@example.com', 'active', 'reply')`, [clientId, busy.id, `${clientId}|busy@example.com`]);
    const act = await call('POST', '/admin/ghosted-meetings/enroll', { leadEmail: 'busy@example.com', clientId });
    assert.equal(act.status, 409);
    assert.equal(act.body.error, 'sequence_already_active');
    assert.equal(await count('ghosted_meeting_checks'), 0);
    assert.ok(r.id);
  });
});

test('card status: rejected -> pending with an audit row; nothing else changes', { skip }, async () => {
  await setup();
  const card = await addReply({ status: 'rejected', classification: 'OTHER', draft_reply: 'Draft text' });
  const before = (await pg.query('SELECT * FROM pending_replies WHERE id = $1', [card.id])).rows[0];
  await withServer(async (call) => {
    const bad = await call('POST', `/admin/cards/${card.id}/status`, { status: 'sent' });
    assert.equal(bad.status, 400);
    assert.equal((await call('POST', `/admin/cards/${card.id}/status`, { status: 'approved' })).status, 400);
    assert.equal((await call('POST', '/admin/cards/not-a-uuid/status', { status: 'pending' })).status, 400);
    assert.equal((await call('POST', '/admin/cards/00000000-0000-4000-8000-000000000000/status', { status: 'pending' })).status, 404);
    assert.equal((await pg.query('SELECT status FROM pending_replies WHERE id = $1', [card.id])).rows[0].status, 'rejected');
    assert.equal(await count('followup_card_events'), 0);

    const ok = await call('POST', `/admin/cards/${card.id}/status`, { status: 'interested', reason: 'prospect replied by phone', actor: 'replies-followups' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.changed, true);
    assert.equal(ok.body.status, 'pending');
    assert.equal(ok.body.classification, 'INTERESTED');
    assert.equal(ok.body.cardRepainted, 'not_requested');

    const after = (await pg.query('SELECT * FROM pending_replies WHERE id = $1', [card.id])).rows[0];
    assert.equal(after.status, 'pending');
    assert.equal(after.classification, 'INTERESTED');
    for (const k of Object.keys(before)) {
      if (['status', 'classification', 'updated_at'].includes(k)) continue;
      assert.deepEqual(after[k], before[k], `${k} unchanged`);
    }
    assert.equal(after.sent_reply, null);
    const events = (await pg.query('SELECT * FROM followup_card_events')).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'admin_status_change');
    assert.equal(events[0].pending_reply_id, card.id);
    assert.equal(events[0].detail.from, 'rejected');
    assert.equal(events[0].detail.to, 'pending');
    assert.equal(events[0].detail.actor, 'replies-followups');
    assert.equal(events[0].detail.classification_from, 'OTHER');

    // Again: idempotent, no second audit row.
    const again = await call('POST', `/admin/cards/${card.id}/status`, { status: 'pending' });
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false);
    assert.equal(await count('followup_card_events'), 1);
  });
});

test('card status: only a rejected card can be reopened', { skip }, async () => {
  await setup();
  for (const status of ['sent', 'approved', 'disqualified', 'meeting_booked', 'suppressed']) {
    const c = await addReply({ status });
    await withServer(async (call) => {
      const r = await call('POST', `/admin/cards/${c.id}/status`, { status: 'pending' });
      assert.equal(r.status, 409, status);
      assert.equal(r.body.error, 'not_rejected');
    });
    assert.equal((await pg.query('SELECT status FROM pending_replies WHERE id = $1', [c.id])).rows[0].status, status);
  }
  assert.equal(await count('followup_card_events'), 0);
});

test('card status: a positive classification is kept; repaintCard redraws the existing Slack message only', { skip }, async () => {
  await setup();
  const card = await addReply({ status: 'rejected', classification: 'QUESTION', draft_reply: 'Draft' });
  const calls = [];
  const svc = require('../src/services/card-status-admin');
  const out = await svc.setCardStatus(card.id, { status: 'interested', repaintCard: true }, {
    slackApi: {
      updateDraftApprovalCard: async (...a) => { calls.push(['draft', ...a]); },
      updateAlertCard: async () => { throw new Error('should not be used for a drafted card'); },
    },
    loadCard: async () => ({ replyId: card.id, draft: 'Draft' }),
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.classification, 'QUESTION');
  assert.equal(out.body.cardRepainted, 'repainted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'xoxb-test');
  assert.equal(calls[0][3], card.slack_message_ts);
});
