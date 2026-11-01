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
let sgId = null;
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
    const { rows: [sg] } = await pg.query(
      `INSERT INTO clients (name, slack_bot_token, slack_channel_id) VALUES ('SalesGlider', 'xoxb-test', 'C3') RETURNING id`);
    sgId = sg.id;
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

// ─── manual mode (no SmartLead / HeyReach reply) ─────────────────────────────

const manualBody = (over = {}) => ({
  manual: true, leadName: 'Test Person', leadEmail: 'manual@example.com', phone: '+15555550123', company: 'Example Co',
  clientId: sgId, meetingStart: MEET, ...over,
});

test('manual enroll: context row + sequence + card step, inert source, idempotent, dryRun writes nothing', { skip }, async () => {
  await setup();
  await withServer(async (call) => {
    const dry = await call('POST', '/admin/ghosted-meetings/enroll', manualBody({ dryRun: true }));
    assert.equal(dry.status, 200);
    assert.equal(dry.body.wouldEnroll, true);
    assert.equal(dry.body.sourceKind, 'manual');
    assert.match(dry.body.sendPath, /new email from the connected SalesGlider Gmail/);
    assert.equal(await count('pending_replies'), 0);
    assert.equal(await count('followup_sequences'), 0);

    const first = await call('POST', '/admin/ghosted-meetings/enroll', manualBody());
    assert.equal(first.status, 201);
    assert.equal(first.body.sourceKind, 'manual');
    assert.ok(!JSON.stringify(first.body).includes('manual@example.com'));
    const rows = (await pg.query('SELECT * FROM pending_replies')).rows;
    assert.equal(rows.length, 1);
    const src = rows[0];
    assert.equal(src.campaign_id, 'manual-ghost');
    assert.equal(src.status, 'skipped', 'inert: no recap, digest, scan or resurface job picks it up');
    assert.equal(src.classification, 'OTHER');
    assert.equal(src.lead_name, 'Test Person');
    assert.equal(src.lead_phone, '+15555550123');
    assert.equal(src.lead_company, 'Example Co');
    const [seq] = (await pg.query('SELECT * FROM followup_sequences')).rows;
    assert.equal(seq.origin, 'ghosted_meeting');
    assert.equal(seq.source_reply_id, src.id);
    assert.deepEqual((await pg.query('SELECT kind, status FROM followup_sequence_steps')).rows, [{ kind: 'ghost_email', status: 'pending' }]);

    const again = await call('POST', '/admin/ghosted-meetings/enroll', manualBody());
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyEnrolled, true);
    assert.equal(again.body.sequenceId, first.body.sequenceId);
    const other = await call('POST', '/admin/ghosted-meetings/enroll', manualBody({ meetingStart: '2026-10-29T15:00:00-05:00', leadName: 'Renamed' }));
    assert.equal(other.body.alreadyEnrolled, true);
    assert.equal(await count('pending_replies'), 1);
    assert.equal(await count('followup_sequences'), 1);
  });
});

test('manual enroll: needs name, client and meeting time; only SalesGlider can use the Gmail send path', { skip }, async () => {
  await setup();
  const { rows: [other] } = await pg.query(
    `INSERT INTO clients (name, slack_bot_token, slack_channel_id) VALUES ('Other Client', 'xoxb-test', 'C2') RETURNING id`);
  await withServer(async (call) => {
    assert.equal((await call('POST', '/admin/ghosted-meetings/enroll', manualBody({ leadName: '' }))).status, 400);
    assert.equal((await call('POST', '/admin/ghosted-meetings/enroll', manualBody({ clientId: undefined }))).status, 400);
    assert.equal((await call('POST', '/admin/ghosted-meetings/enroll', manualBody({ meetingStart: undefined }))).status, 400);
    const refused = await call('POST', '/admin/ghosted-meetings/enroll', manualBody({ clientId: other.id }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'manual_send_not_supported_for_client');
    assert.equal(await count('pending_replies'), 0);
    assert.equal(await count('followup_sequences'), 0);
  });
});

test('manual enroll: a lead with a real reply uses that reply, not a manual row', { skip }, async () => {
  await setup();
  await addReply();
  await withServer(async (call) => {
    const r = await call('POST', '/admin/ghosted-meetings/enroll', manualBody({ leadEmail: 'lead@example.com', clientId }));
    assert.equal(r.status, 201);
    assert.equal(r.body.sourceKind, 'reply');
    assert.equal(await count('pending_replies'), 1);
  });
});

test('manual lead: the ghost card is posted from the context row and only a human approval can send', { skip }, async () => {
  await setup();
  await withServer(async (call) => { assert.equal((await call('POST', '/admin/ghosted-meetings/enroll', manualBody())).status, 201); });
  const seqSvc = require('../src/services/followup-sequence');
  const { rows: [enrolled] } = await pg.query('SELECT s.*, pr.campaign_id FROM followup_sequences s JOIN pending_replies pr ON pr.id = s.source_reply_id');
  assert.equal(await require('../src/services/ghosted-meetings').stopReason(enrolled, enrolled, {}), null, 'the manual context row is not a prospect reply');
  // Move the enrollment to a Tuesday late morning in Chicago so the step is due inside the send window.
  await pg.exec(`UPDATE followup_sequences SET enrolled_at = '2030-01-08T16:00:00Z'; UPDATE followup_sequence_steps SET due_at = '2030-01-08T17:00:00Z'`);
  const cards = [];
  const slackApi = { getPermalink: async () => 'https://slack.example/p', getClient: () => ({ chat: { postMessage: async () => ({ ts: '1.1' }), update: async () => {} } }) };
  const deps = {
    postCard: async (a) => { cards.push(a); return { ts: '3000.1' }; },
    resolveSlots: async () => ({ slots: [{ start: '2026-11-02T16:00:00Z', label: 'Mon 10am' }, { start: '2026-11-02T20:00:00Z', label: 'Mon 2pm' }] }),
    resolveCopy: async () => ({ offerLine: null, proofPoint: null }),
  };
  const env = { GHOSTED_MEETING_ENABLED: 'true', FOLLOWUP_CALLERS: 'U0CAL8ZDG92:Gabe' };
  const t = await seqSvc.runSequenceTick({ now: new Date('2030-01-08T18:00:00Z'), slackApi, deps, env }) // a Tuesday noon in Chicago: inside the send window;
  assert.equal(t.posted, 1);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].campaignId, 'manual-ghost');
  assert.equal(cards[0].card.classification, 'FOLLOW_UP');
  assert.match(cards[0].card.draft, /^Hey Test, looks like we missed each other\./);
  const { rows: [card] } = await pg.query(`SELECT * FROM pending_replies WHERE classification = 'FOLLOW_UP'`);
  assert.equal(card.status, 'pending', 'gated on the card: nothing is sent until Approve');
  assert.equal(card.campaign_id, 'manual-ghost');
});

test('manual lead send: new Gmail email to the lead, SalesGlider only, never SmartLead', { skip }, async () => {
  const send = require('../src/services/reply-send');
  const calls = [];
  const gmail = {
    isConfigured: () => true, getAccount: async () => ({ email: 'sender@example.com' }), expectedFromEmail: () => 'sender@example.com',
    sendMail: async (m) => { calls.push(m); return { from: 'sender@example.com' }; },
  };
  const reply = { id: 'r1', campaign_id: 'manual-ghost', lead_email: 'manual@example.com' };
  const out = await send.sendManualGhostEmail({ id: 'c', name: 'SalesGlider' }, reply, 'Hey Test,\nlooks like we missed each other.', { gmail });
  assert.equal(out.manualGhostGmail, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'manual@example.com');
  assert.match(calls[0].textBody, /missed each other/);
  assert.match(calls[0].htmlBody, /Hey Test,<br>looks/);
  await assert.rejects(() => send.sendManualGhostEmail({ id: 'x', name: 'Other Client' }, reply, 'x', { gmail }), /only be emailed for SalesGlider/);
  await assert.rejects(() => send.sendManualGhostEmail({ id: 'c', name: 'SalesGlider' }, { ...reply, lead_email: '' }, 'x', { gmail }), /No email address/);
  await assert.rejects(() => send.sendManualGhostEmail({ id: 'c', name: 'SalesGlider' }, reply, 'x', { gmail: { ...gmail, isConfigured: () => false } }), /not configured/);
  await assert.rejects(() => send.sendManualGhostEmail({ id: 'c', name: 'SalesGlider' }, reply, 'x', { gmail: { ...gmail, getAccount: async () => null } }), /not connected/);
  assert.equal(calls.length, 1, 'every refusal happens before any send');
  // sendReplyToPlatform hands manual rows to Gmail before the SmartLead branch.
  const src = read('src/services/reply-send.js');
  assert.ok(src.indexOf('isManualGhostReply(reply)') > 0 && src.indexOf('isManualGhostReply(reply)') < src.indexOf("if (reply.platform === 'smartlead') {"));
});

// ─── status route: Slack reference backfill + repaint fallback ────────────────

function repaintFakes() {
  const calls = [];
  return {
    calls,
    slackApi: {
      updateDraftApprovalCard: async (...a) => { calls.push(['draft', ...a]); },
      updateAlertCard: async (...a) => { calls.push(['alert', ...a]); },
    },
    loadCard: async (id) => ({ replyId: id, draft: 'Draft' }),
  };
}

test('card status: slackChannel + slackTs are backfilled onto a row that has none, audited, and repainted', { skip }, async () => {
  await setup();
  const card = await addReply({ status: 'rejected', draft_reply: 'Draft', slack_message_ts: null, slack_channel_id: null });
  const svc = require('../src/services/card-status-admin');
  const f = repaintFakes();
  const bad = await svc.setCardStatus(card.id, { status: 'pending', slackChannel: 'nope', slackTs: '1793313695.519449' }, f);
  assert.equal(bad.status, 400);
  assert.equal((await pg.query('SELECT status FROM pending_replies WHERE id = $1', [card.id])).rows[0].status, 'rejected', 'nothing changed on a bad reference');
  const out = await svc.setCardStatus(card.id, { status: 'pending', repaintCard: true, slackChannel: 'C0CC420V1TK', slackTs: '1793313695.519449' }, f);
  assert.equal(out.status, 200);
  assert.equal(out.body.cardRepainted, 'repainted');
  assert.deepEqual(out.body.slackBackfill.backfilled, ['slackChannel', 'slackTs']);
  const row = (await pg.query('SELECT * FROM pending_replies WHERE id = $1', [card.id])).rows[0];
  assert.equal(row.slack_channel_id, 'C0CC420V1TK');
  assert.equal(row.slack_message_ts, '1793313695.519449');
  assert.equal(row.status, 'pending');
  assert.deepEqual(f.calls[0].slice(0, 1).concat(f.calls[0].slice(2)).slice(0, 3), ['draft', 'C0CC420V1TK', '1793313695.519449']);
  const events = (await pg.query('SELECT event_type FROM followup_card_events ORDER BY created_at, event_type')).rows.map((r) => r.event_type);
  assert.deepEqual(events.sort(), ['admin_slack_backfill', 'admin_status_change']);

  // Already pending: nothing to reopen, but the repaint still runs; values the row has are not overwritten.
  const f2 = repaintFakes();
  const again = await svc.setCardStatus(card.id, { status: 'pending', repaintCard: true, slackChannel: 'C0OTHER12345', slackTs: '1700000000.000100' }, f2);
  assert.equal(again.body.changed, false);
  assert.equal(again.body.cardRepainted, 'repainted');
  assert.deepEqual(again.body.slackBackfill, { backfilled: [], ignored: ['slackChannel', 'slackTs'] });
  assert.equal((await pg.query('SELECT slack_channel_id FROM pending_replies WHERE id = $1', [card.id])).rows[0].slack_channel_id, 'C0CC420V1TK');
  assert.equal(f2.calls[0][2], 'C0CC420V1TK');
});

test('card status: with only the ts known, the channel falls back to the follow-up channel, then the client channel', { skip }, async () => {
  await setup();
  const svc = require('../src/services/card-status-admin');
  const fu = await addReply({ status: 'pending', classification: 'FOLLOW_UP', draft_reply: 'Draft', slack_channel_id: null, slack_message_ts: '1700.5' });
  const f = repaintFakes();
  const a = await svc.setCardStatus(fu.id, { status: 'pending', repaintCard: true }, f);
  assert.equal(a.body.cardRepainted, 'repainted');
  assert.equal(f.calls[0][2], require('../src/services/follow-up-runner').followUpSlackChannelId());
  const plain = await addReply({ status: 'rejected', draft_reply: 'Draft', slack_channel_id: null, slack_message_ts: null });
  const f2 = repaintFakes();
  const b = await svc.setCardStatus(plain.id, { status: 'pending', repaintCard: true, slackTs: '1793313695.519449' }, f2);
  assert.equal(b.body.cardRepainted, 'repainted');
  assert.equal(f2.calls[0][2], 'C1', "the client's configured card channel");
  assert.deepEqual(b.body.slackBackfill.backfilled, ['slackTs']);
  const none = await addReply({ status: 'pending', draft_reply: 'Draft', slack_channel_id: null, slack_message_ts: null });
  const c = await svc.setCardStatus(none.id, { status: 'pending', repaintCard: true }, repaintFakes());
  assert.equal(c.body.cardRepainted, 'no_slack_message');
});

test('card status: a row with no stored card payload is repainted from the row itself', { skip }, async () => {
  await setup();
  const card = await addReply({ status: 'pending', draft_reply: 'Draft text', campaign_name: 'Camp', lead_phone: '+15555550111' });
  const svc = require('../src/services/card-status-admin');
  const f = repaintFakes();
  const out = await svc.setCardStatus(card.id, { status: 'pending', repaintCard: true }, { ...f, loadCard: async () => null });
  assert.equal(out.body.cardRepainted, 'repainted');
  assert.equal(out.body.cardRebuiltFromRow, true);
  assert.equal(f.calls[0][0], 'draft');
  const painted = f.calls[0][4];
  assert.equal(painted.replyId, card.id);
  assert.equal(painted.draft, 'Draft text');
  assert.equal(painted.leadEmail, 'lead@example.com');
  assert.equal(painted.leadPhone, '+15555550111');
  // The rebuilt card is stored, so the next repaint does not need to rebuild.
  const { rows: [r] } = await pg.query('SELECT card_payload FROM pending_replies WHERE id = $1', [card.id]);
  assert.equal(r.card_payload && r.card_payload.draft, 'Draft text');
});
