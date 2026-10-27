/**
 * End-to-end sequence behaviour on a real Postgres (PGlite, in memory).
 * PGlite is a dev-only tool and not a dependency of this repo: the suite skips
 * itself when it is not installed (NODE_PATH=<dir with @electric-sql/pglite>).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { /* skip below */ }
const skip = PGlite ? false : 'PGlite not installed (dev-only integration test)';

for (const k of ['ALLO_API_KEY', 'ALLO_PHONE_NUMBERS', 'ALLO_PHONE_NUMBER', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
  'BOOKING_BRIDGE_URL', 'CAMPAIGN_INTELLIGENCE_URL']) delete process.env[k];

const ENV = { FOLLOWUP_SEQUENCE_ENABLED: 'true', FOLLOWUP_CALLER_NAME: 'Gabe' };
const MIN = 60000;
const NOW = new Date('2026-10-27T17:00:00Z'); // Tue 12:00 CT

let shared = null;
async function setup() {
  // The services capture `db` at require time, so one PGlite serves the whole
  // file and each test starts from empty tables.
  if (!shared) {
    const pg = new PGlite();
    const adapter = {
      async query(sql, params) {
        const r = await pg.query(sql, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
    };
    require.cache[require.resolve('../src/db')] = { id: 'db', filename: 'db', loaded: true, exports: adapter };
    const root = path.join(__dirname, '..');
    await pg.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8').replace(/CREATE EXTENSION[^;]*;/gi, ''));
    shared = { pg, svc: require('../src/services/followup-sequence') };
  }
  const { pg, svc } = shared;
  await pg.exec(`TRUNCATE followup_sequence_steps, followup_sequences, followup_sequence_copy,
                          pending_replies, disqualified_prospects, meetings, outbound_follow_ups RESTART IDENTITY`);
  if (!shared.clientId) {
    // Client rows cannot be deleted (protect trigger), so create it once.
    const { rows: [client] } = await pg.query(
      `INSERT INTO clients (name, slack_bot_token, slack_channel_id) VALUES ('Acme Co', 'xoxb-test', 'C1') RETURNING id`);
    shared.clientId = client.id;
  }
  return { pg, svc, clientId: shared.clientId };
}

let n = 0;
async function addReply(pg, clientId, over = {}) {
  n += 1;
  const row = {
    classification: 'INTERESTED', status: 'pending', slack_message_ts: `1700.${n}`,
    lead_email: `lead${n}@x.co`, lead_name: 'Pat Smith', inbound_message: `Sounds good, send times ${n}`,
    lead_phone: '+15555550100', phone_enrichment_status: 'found', created_at: new Date(NOW - MIN),
    lead_timezone: 'America/Chicago', platform: 'smartlead', campaign_id: '111', lead_id: String(n), ...over,
  };
  const cols = Object.keys(row);
  const { rows: [r] } = await pg.query(
    `INSERT INTO pending_replies (client_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [clientId, ...cols.map((c) => row[c])]);
  return r;
}

function fakes() {
  const calls = { posts: [], updates: [], cards: [], slotCalls: [] };
  const slackApi = {
    getPermalink: async () => 'https://slack.example/p',
    updateMessage: async (...a) => { calls.updates.push(a); },
    getClient: () => ({ chat: {
      postMessage: async (a) => { calls.posts.push(a); return { ts: `2000.${calls.posts.length}` }; },
      update: async (a) => { calls.updates.push(['chat.update', a]); },
    } }),
  };
  let slotN = 0;
  const deps = {
    postCard: async (a) => { calls.cards.push(a); return { ts: `3000.${calls.cards.length}` }; },
    resolveSlots: async (_c, o) => {
      calls.slotCalls.push(o);
      slotN += 1;
      return { slots: [
        { start: `2026-11-0${slotN}T16:00:00Z`, label: `Slot${slotN}A` },
        { start: `2026-11-0${slotN}T18:00:00Z`, label: `Slot${slotN}B` },
      ] };
    },
    resolveCopy: async () => ({ offerLine: 'cutting your IT costs', proofPoint: null }),
  };
  return { slackApi, deps, calls };
}

const stepStates = async (pg, seqId) => Object.fromEntries((await pg.query(
  'SELECT kind, status, skip_reason FROM followup_sequence_steps WHERE sequence_id = $1', [seqId])).rows
  .map((r) => [r.kind, r.skip_reason ? `${r.status}/${r.skip_reason}` : r.status]));

test('full Day 0 path: call card, No answer queues the voicemail email 5 min later with two live times', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const src = await addReply(pg, clientId);
  const { slackApi, deps, calls } = fakes();

  let t = await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  assert.equal(t.enrolled, 1);
  assert.equal(t.posted, 1);
  const callPost = calls.posts[0];
  assert.equal(callPost.channel, 'C0BRRS8DV19', 'follow-ups channel');
  const blockText = JSON.stringify(callPost.blocks);
  assert.ok(blockText.includes('Hey Pat, this is Gabe with Acme Co. We emailed you about cutting your IT costs.'));
  assert.ok(blockText.includes('+15555550100'));
  assert.ok(blockText.includes('fseq_no_answer'));

  // Second tick must not duplicate the call card.
  t = await svc.runSequenceTick({ now: new Date(NOW.getTime() + MIN), slackApi, deps, env: ENV });
  assert.equal(calls.posts.length, 1);

  const { rows: [seq] } = await pg.query('SELECT * FROM followup_sequences WHERE source_reply_id = $1', [src.id]);
  const { rows: [step] } = await pg.query(`SELECT * FROM followup_sequence_steps WHERE kind = 'call_day0'`);
  const clickAt = new Date(NOW.getTime() + 2 * MIN);
  const out = await svc.applyCallOutcome({ stepId: step.id, outcome: 'no_answer', slackUserId: 'U1', now: clickAt, slackApi, env: ENV });
  assert.equal(out.applied, true);
  // Clicking twice does nothing.
  assert.equal((await svc.applyCallOutcome({ stepId: step.id, outcome: 'no_answer', now: clickAt, slackApi, env: ENV })).applied, false);

  // The email is queued by the click itself, due 5 minutes out. No second click needed.
  const { rows: [queued] } = await pg.query(`SELECT status, due_at FROM followup_sequence_steps WHERE kind = 'email_vm'`);
  assert.equal(queued.status, 'pending');
  assert.equal(new Date(queued.due_at).getTime() - clickAt.getTime(), 5 * MIN);
  // 4 min after the click: not yet.
  await svc.runSequenceTick({ now: new Date(clickAt.getTime() + 4 * MIN), slackApi, deps, env: ENV });
  assert.equal(calls.cards.length, 0);
  // 5+ min after: the voicemail email card.
  await svc.runSequenceTick({ now: new Date(clickAt.getTime() + 6 * MIN), slackApi, deps, env: ENV });
  assert.equal(calls.cards.length, 1);
  const card = calls.cards[0];
  assert.equal(card.channelId, 'C0BRRS8DV19');
  assert.match(card.card.draft, /^Hey Pat, just tried you, left you a voicemail\. Still want to take a peek at this\?\n\nDoes Slot1A or Slot1B work for a quick call\?/);
  assert.match(card.card.draft, /Slot1A or Slot1B/);
  assert.equal(card.card.classification, 'FOLLOW_UP');
  const { rows: [pr] } = await pg.query('SELECT status, classification, draft_reply FROM pending_replies WHERE id = $1', [card.replyId]);
  assert.equal(pr.status, 'pending', 'nothing is sent; a human still clicks Approve');
  assert.equal(pr.classification, 'FOLLOW_UP');
  const states = await stepStates(pg, seq.id);
  assert.equal(states.email_vm, 'posted');
});

test('Day 1 email offers fresh slots, excluding the ones already offered', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  await addReply(pg, clientId);
  const { slackApi, deps, calls } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  const { rows: [seq] } = await pg.query('SELECT * FROM followup_sequences');
  const { rows: [vm] } = await pg.query(`SELECT * FROM followup_sequence_steps WHERE kind = 'call_day0'`);
  await svc.applyCallOutcome({ stepId: vm.id, outcome: 'no_answer', now: NOW, slackApi, env: ENV });
  await svc.runSequenceTick({ now: new Date(NOW.getTime() + 6 * MIN), slackApi, deps, env: ENV });
  assert.equal(calls.cards.length, 1);
  // Jump to Day 1, 10:30 CT (inside the email send window, after the 9:30... call+30m).
  const day1 = new Date('2026-10-28T20:00:00Z');
  await pg.query(`UPDATE followup_sequence_steps SET status = 'skipped' WHERE sequence_id = $1 AND kind IN ('call_day0_late')`, [seq.id]);
  await pg.query(`UPDATE followup_sequence_steps SET due_at = $2 WHERE sequence_id = $1 AND kind IN ('call_day1', 'email_day1')`, [seq.id, new Date(day1.getTime() - 3600000)]);
  await svc.runSequenceTick({ now: day1, slackApi, deps, env: ENV });
  const d1 = calls.cards[calls.cards.length - 1];
  assert.match(d1.card.draft, /those times got taken/i);
  assert.match(d1.card.draft, /Slot2A/);
  const last = calls.slotCalls[calls.slotCalls.length - 1];
  assert.deepEqual(last.excludeStarts, ['2026-11-01T16:00:00Z', '2026-11-01T18:00:00Z']);
});

test('no phone: call cards are skipped, email steps still run', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  await addReply(pg, clientId, { lead_phone: null, phone_enrichment_status: 'not_found' });
  const { slackApi, deps, calls } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  assert.equal(calls.posts.length, 0, 'no call card without a phone');
  const { rows: [seq] } = await pg.query('SELECT * FROM followup_sequences');
  const states = await stepStates(pg, seq.id);
  assert.equal(states.call_day0, 'skipped/no_phone');
  assert.equal(states.email_breakup, 'pending');
  // Day 5 breakup card still posts.
  const d5 = new Date('2026-11-03T17:00:00Z');
  await pg.query(`UPDATE followup_sequence_steps SET status = 'skipped' WHERE sequence_id = $1 AND kind <> 'email_breakup'`, [seq.id]);
  await svc.runSequenceTick({ now: d5, slackApi, deps, env: ENV });
  assert.equal(calls.cards.length, 1);
  assert.equal(calls.cards[0].card.draft, "Hey Pat, don't want to keep emailing you. Did you still want to meet about this, or have priorities changed?");
});

test('phone still being looked up: Day 0 call waits, then posts when the number lands', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const src = await addReply(pg, clientId, { lead_phone: null, phone_enrichment_status: 'processing' });
  const { slackApi, deps, calls } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  await svc.runSequenceTick({ now: new Date(NOW.getTime() + 3 * MIN), slackApi, deps, env: ENV });
  assert.equal(calls.posts.length, 0);
  await pg.query(`UPDATE pending_replies SET lead_phone = '+15555550111', phone_enrichment_status = 'found' WHERE id = $1`, [src.id]);
  await svc.runSequenceTick({ now: new Date(NOW.getTime() + 6 * MIN), slackApi, deps, env: ENV });
  assert.equal(calls.posts.length, 1);
  assert.ok(JSON.stringify(calls.posts[0].blocks).includes('+15555550111'));
});

test('calls only inside the lead local business hours', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  // 12:00 CT but the lead is in Pacific: 10am there, fine. Make it 7:30am PT: not fine.
  await addReply(pg, clientId, { lead_timezone: 'America/Los_Angeles', created_at: new Date('2026-10-27T14:29:00Z') });
  const { slackApi, deps, calls } = fakes();
  const early = new Date('2026-10-27T14:30:00Z'); // 7:30am PT
  await svc.runSequenceTick({ now: early, slackApi, deps, env: ENV });
  assert.equal(calls.posts.length, 0);
  const { rows: [st] } = await pg.query(`SELECT due_at FROM followup_sequence_steps WHERE kind = 'call_day0'`);
  assert.equal(new Date(st.due_at).toISOString(), '2026-10-27T16:00:00.000Z', 'moved to 9am PT');
  await svc.runSequenceTick({ now: new Date('2026-10-27T16:01:00Z'), slackApi, deps, env: ENV });
  assert.equal(calls.posts.length, 1);
});

test('a later inbound reply stops the sequence and closes its unsent cards', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const src = await addReply(pg, clientId, { lead_email: 'a@x.co' });
  const { slackApi, deps, calls } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  const { rows: [vm] } = await pg.query(`SELECT * FROM followup_sequence_steps WHERE kind = 'call_day0'`);
  await svc.applyCallOutcome({ stepId: vm.id, outcome: 'no_answer', now: NOW, slackApi, env: ENV });
  await svc.runSequenceTick({ now: new Date(NOW.getTime() + 6 * MIN), slackApi, deps, env: ENV });
  const cardReplyId = calls.cards[0].replyId;

  // The lead writes back (a different message).
  await addReply(pg, clientId, { lead_email: 'a@x.co', inbound_message: 'Actually, can you call me tomorrow?', classification: 'QUESTION', created_at: new Date(NOW.getTime() + 8 * MIN) });
  const t = await svc.runSequenceTick({ now: new Date(NOW.getTime() + 9 * MIN), slackApi, deps, env: ENV });
  assert.ok(t.stopped >= 1);
  const { rows: [seq] } = await pg.query('SELECT status, stop_reason FROM followup_sequences WHERE source_reply_id = $1', [src.id]);
  assert.deepEqual([seq.status, seq.stop_reason], ['stopped', 'inbound_reply']);
  const { rows: [pr] } = await pg.query('SELECT status FROM pending_replies WHERE id = $1', [cardReplyId]);
  assert.equal(pr.status, 'skipped', 'the unsent email card can no longer be approved');
  assert.ok(calls.updates.some((u) => String(u[3] || '').includes('sequence stopped')), 'slack card closed');
  const left = (await pg.query(`SELECT count(*)::int AS n FROM followup_sequence_steps WHERE status = 'pending'`)).rows[0].n;
  assert.equal(left, 0);
  // Nothing posts afterwards.
  const before = calls.cards.length + calls.posts.length;
  await svc.runSequenceTick({ now: new Date('2026-11-05T17:00:00Z'), slackApi, deps, env: ENV });
  assert.equal(calls.cards.length + calls.posts.length, before);
});

test('a duplicate row of the same inbound text does not count as a new reply', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  await addReply(pg, clientId, { lead_email: 'dup@x.co', inbound_message: 'send times' });
  const { slackApi, deps } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  await addReply(pg, clientId, { lead_email: 'dup@x.co', inbound_message: 'send times', created_at: new Date(NOW.getTime() + MIN) });
  await svc.runSequenceTick({ now: new Date(NOW.getTime() + 2 * MIN), slackApi, deps, env: ENV });
  const { rows } = await pg.query(`SELECT status FROM followup_sequences WHERE lead_email = 'dup@x.co' ORDER BY created_at`);
  assert.equal(rows[0].status, 'active');
});

test('Booked on a call card stops the sequence and marks the meeting booked', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const src = await addReply(pg, clientId);
  const { slackApi, deps } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  const { rows: [step] } = await pg.query(`SELECT * FROM followup_sequence_steps WHERE kind = 'call_day0'`);
  await svc.applyCallOutcome({ stepId: step.id, outcome: 'booked', slackUserId: 'U9', now: NOW, slackApi, env: ENV });
  const { rows: [seq] } = await pg.query('SELECT status, stop_reason FROM followup_sequences');
  assert.deepEqual([seq.status, seq.stop_reason], ['stopped', 'booked']);
  const { rows: [pr] } = await pg.query('SELECT status FROM pending_replies WHERE id = $1', [src.id]);
  assert.equal(pr.status, 'meeting_booked');
});

test('a DQ stops the sequence', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const src = await addReply(pg, clientId);
  const { slackApi, deps } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  await require('../src/services/disqualified-prospects').markDisqualified({ clientId, reply: src, slackUserId: 'U1' });
  const { rows: [seq] } = await pg.query('SELECT status, stop_reason FROM followup_sequences');
  assert.deepEqual([seq.status, seq.stop_reason], ['stopped', 'disqualified']);
});

test('Day 3 proof card is held when the campaign copy has no real proof, and never invented', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  await addReply(pg, clientId);
  const { slackApi, deps, calls } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  const { rows: [seq] } = await pg.query('SELECT * FROM followup_sequences');
  await pg.query(`UPDATE followup_sequence_steps SET status = 'skipped' WHERE sequence_id = $1 AND kind <> 'email_proof'`, [seq.id]);
  const thu = new Date('2026-10-29T20:30:00Z'); // Thu 3:30pm CT, inside the email send window
  await pg.query(`UPDATE followup_sequence_steps SET due_at = $1 WHERE kind = 'email_proof'`, [new Date(thu.getTime() - MIN)]);
  await svc.runSequenceTick({ now: thu, slackApi, deps, env: ENV });
  assert.equal(calls.cards.length, 0, 'held, not posted');
  assert.equal((await stepStates(pg, seq.id)).email_proof, 'held/no_proof');

  // Real proof appears (extracted from copy or entered by hand): the held card is released.
  deps.resolveCopy = async () => ({ offerLine: 'x', proofPoint: 'Last quarter we booked 212 meetings for 14 clients.' });
  await pg.query(`UPDATE followup_sequence_steps SET due_at = $1 WHERE kind = 'email_proof'`, [new Date(thu.getTime() - MIN)]);
  await svc.runSequenceTick({ now: new Date(thu.getTime() + 30 * MIN), slackApi, deps, env: ENV });
  assert.equal(calls.cards.length, 1);
  assert.ok(calls.cards[0].card.draft.includes('Last quarter we booked 212 meetings for 14 clients.'));
  assert.equal((await stepStates(pg, seq.id)).email_proof, 'posted');
});

test('only recent INTERESTED / MEETING_PROPOSED replies enrol; old ones and questions do not', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  await addReply(pg, clientId, { created_at: new Date(NOW.getTime() - 10 * 3600000) });
  await addReply(pg, clientId, { classification: 'QUESTION' });
  await addReply(pg, clientId, { classification: 'NOT_INTERESTED' });
  await addReply(pg, clientId, { status: 'suppressed' });
  await addReply(pg, clientId, { classification: 'MEETING_PROPOSED' });
  const { slackApi, deps } = fakes();
  const t = await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  assert.equal(t.enrolled, 1);
});

test('FOLLOWUP_SEQUENCE_START keeps older replies out', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  await addReply(pg, clientId, { created_at: new Date(NOW.getTime() - 2 * 3600000) });
  const { slackApi, deps } = fakes();
  const t = await svc.runSequenceTick({ now: NOW, slackApi, deps, env: { ...ENV, FOLLOWUP_SEQUENCE_START: new Date(NOW.getTime() - 3600000).toISOString() } });
  assert.equal(t.enrolled, 0);
});

test('one live sequence per lead', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  await addReply(pg, clientId, { lead_email: 'same@x.co', inbound_message: 'first' });
  await addReply(pg, clientId, { lead_email: 'same@x.co', inbound_message: 'second' });
  const { slackApi, deps } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  const { rows } = await pg.query(`SELECT status FROM followup_sequences WHERE lead_email = 'same@x.co'`);
  assert.equal(rows.filter((r) => r.status === 'active').length <= 1, true);
});

async function postedCallStep(pg, svc, clientId, over = {}) {
  await addReply(pg, clientId, over);
  const { slackApi, deps, calls } = fakes();
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  const { rows: [step] } = await pg.query(`SELECT * FROM followup_sequence_steps WHERE kind = 'call_day0'`);
  const { rows: [seq] } = await pg.query('SELECT * FROM followup_sequences');
  return { step, seq, slackApi, deps, calls };
}

test('Connected - not interested stops the sequence and closes unsent cards', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, seq, slackApi, deps, calls } = await postedCallStep(pg, svc, clientId);
  // An email card is already out and unsent.
  await svc.applyCallOutcome({ stepId: step.id, outcome: 'no_answer', now: NOW, slackApi, env: ENV });
  await svc.runSequenceTick({ now: new Date(NOW.getTime() + 6 * MIN), slackApi, deps, env: ENV });
  assert.equal(calls.cards.length, 1);
  const { rows: [callLater] } = await pg.query(`SELECT * FROM followup_sequence_steps WHERE kind = 'call_day0_late'`);
  await pg.query(`UPDATE followup_sequence_steps SET status = 'posted', slack_channel = 'C0BRRS8DV19', slack_ts = '2000.9' WHERE id = $1`, [callLater.id]);
  const out = await svc.applyCallOutcome({ stepId: callLater.id, outcome: 'not_interested', slackUserId: 'U7', now: new Date(NOW.getTime() + 10 * MIN), slackApi, env: ENV });
  assert.equal(out.applied, true);
  const { rows: [after] } = await pg.query('SELECT status, stop_reason FROM followup_sequences WHERE id = $1', [seq.id]);
  assert.deepEqual([after.status, after.stop_reason], ['stopped', 'not_interested']);
  const { rows: [pr] } = await pg.query('SELECT status FROM pending_replies WHERE id = $1', [calls.cards[0].replyId]);
  assert.equal(pr.status, 'skipped', 'the unsent email card can no longer be approved');
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM followup_sequence_steps WHERE status IN ('pending','held')`)).rows[0].n, 0);
});

test('Call back later is logged and the sequence keeps going', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, seq, slackApi } = await postedCallStep(pg, svc, clientId);
  await svc.applyCallOutcome({ stepId: step.id, outcome: 'call_back', slackUserId: 'U7', now: NOW, slackApi, env: ENV });
  const { rows: [s] } = await pg.query('SELECT status FROM followup_sequences WHERE id = $1', [seq.id]);
  assert.equal(s.status, 'active');
  const { rows: [st] } = await pg.query('SELECT outcome FROM followup_sequence_steps WHERE id = $1', [step.id]);
  assert.equal(st.outcome, 'call_back');
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM followup_sequence_steps WHERE kind = 'email_vm'`)).rows[0].n, 0, 'only No answer queues the voicemail email');
});

test('Wrong number cancels the remaining call cards but the email cards stay', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, seq, slackApi } = await postedCallStep(pg, svc, clientId);
  await svc.applyCallOutcome({ stepId: step.id, outcome: 'wrong_number', now: NOW, slackApi, env: ENV });
  const states = await stepStates(pg, seq.id);
  for (const k of ['call_day0_late', 'call_day1', 'call_day3', 'call_day6']) assert.equal(states[k], 'cancelled/wrong_number', k);
  for (const k of ['email_day1', 'email_proof', 'email_thoughts', 'email_breakup']) assert.equal(states[k], 'pending', k);
  const { rows: [s] } = await pg.query('SELECT status FROM followup_sequences WHERE id = $1', [seq.id]);
  assert.equal(s.status, 'active');
});

test('a bare "connected" outcome no longer exists', { skip }, async () => {
  const { svc } = await setup();
  assert.equal(Object.values(svc.OUTCOME_BY_ACTION).includes('connected'), false);
  assert.equal(svc.OUTCOME_BY_ACTION.fseq_connected, undefined);
});

async function day6Voicemail(proofPoint) {
  const { pg, svc, clientId } = await setup();
  await addReply(pg, clientId);
  const { slackApi, deps, calls } = fakes();
  deps.resolveCopy = async () => ({ offerLine: 'cutting your IT costs', proofPoint });
  await svc.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
  const { rows: [seq] } = await pg.query('SELECT * FROM followup_sequences');
  await pg.query(`UPDATE followup_sequence_steps SET status = 'skipped' WHERE sequence_id = $1 AND kind <> 'call_day6'`, [seq.id]);
  const d6 = new Date('2026-11-03T18:00:00Z'); // Tue 12:00 CT
  await pg.query(`UPDATE followup_sequence_steps SET due_at = $1 WHERE kind = 'call_day6'`, [new Date(d6.getTime() - MIN)]);
  const before = calls.posts.length;
  await svc.runSequenceTick({ now: d6, slackApi, deps, env: ENV });
  assert.equal(calls.posts.length, before + 1);
  return JSON.stringify(calls.posts[calls.posts.length - 1].blocks);
}

test('Day 6 call card voicemail is the breakup script with offer and real proof', { skip }, async () => {
  const blocks = await day6Voicemail('Last quarter we booked 212 meetings for 14 clients.');
  assert.ok(blocks.includes('Last call from me. Quick recap: cutting your IT costs. Last quarter we booked 212 meetings for 14 clients. If it'));
  assert.ok(blocks.includes('reply to my email and we'));
});

test('Day 6 call card voicemail omits the proof sentence when there is none', { skip }, async () => {
  const blocks = await day6Voicemail(null);
  assert.ok(blocks.includes('Quick recap: cutting your IT costs. If it'));
  assert.ok(!blocks.includes('212'));
});

// ─── call back later: time picker + scheduled callback card ──────────────────

const CB_SECS = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const cbSubmission = (stepId, iso, tz = 'America/Chicago', user = 'U7') => ({
  user: { id: user },
  view: {
    private_metadata: JSON.stringify({ stepId, tz }),
    state: { values: { when_block: { when: { selected_date_time: CB_SECS(iso) } } } },
  },
});

test('clicking Call back later opens the picker and records nothing yet', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, slackApi } = await postedCallStep(pg, svc, clientId);
  const opened = [];
  const api = { ...slackApi, getClient: () => ({ ...slackApi.getClient(), views: { open: async (a) => { opened.push(a); return { ok: true }; } } }) };
  await svc.handleCallButton({ action_id: 'fseq_call_back', value: step.id },
    { user: { id: 'U7' }, trigger_id: 'trig1', channel: { id: 'C0BRRS8DV19' }, message: { ts: '2000.1' } },
    { slackApi: api });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].trigger_id, 'trig1');
  assert.equal(opened[0].view.callback_id, 'fseq_callback_modal');
  assert.ok(JSON.stringify(opened[0].view).includes('America/Chicago'));
  const { rows: [st] } = await pg.query('SELECT outcome FROM followup_sequence_steps WHERE id = $1', [step.id]);
  assert.equal(st.outcome, null, 'outcome is recorded on submit, not on click');
});

test('submitting a time schedules a callback card, confirms on the card, and posts at that time', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, seq, slackApi, deps, calls } = await postedCallStep(pg, svc, clientId);
  const when = '2026-10-27T20:00:00Z'; // 3pm CT, same day, before the Day 0 second call
  const res = await svc.handleCallbackSubmit(cbSubmission(step.id, when), { slackApi, now: new Date(NOW.getTime() + 2 * MIN) });
  assert.equal(res.scheduled, true);

  const { rows: [cb] } = await pg.query(`SELECT * FROM followup_sequence_steps WHERE kind = 'call_callback_1'`);
  assert.equal(cb.status, 'pending');
  assert.equal(new Date(cb.due_at).toISOString(), new Date(when).toISOString());
  assert.equal(cb.sequence_id, seq.id, 'logged on the sequence');
  const { rows: [orig] } = await pg.query('SELECT outcome, outcome_by FROM followup_sequence_steps WHERE id = $1', [step.id]);
  assert.deepEqual([orig.outcome, orig.outcome_by], ['call_back', 'U7']);

  const redraw = calls.updates.find((u) => u[0] === 'chat.update');
  const redrawText = JSON.stringify(redraw[1].blocks);
  assert.ok(redrawText.includes('Callback set for'));
  assert.ok(redrawText.includes('Tue, Oct 27, 3:00 PM'), 'lead-time confirmation');
  assert.ok(!redrawText.includes('fseq_booked'), 'buttons are gone');

  // Not before the time...
  const posts0 = calls.posts.length;
  await svc.runSequenceTick({ now: new Date('2026-10-27T19:58:00Z'), slackApi, deps, env: ENV });
  assert.ok(!calls.posts.slice(posts0).some((p) => /Callback call/.test(p.text)));
  // ...and at the time the callback card posts with the same script and buttons.
  await svc.runSequenceTick({ now: new Date('2026-10-27T20:01:00Z'), slackApi, deps, env: ENV });
  const cbPost = calls.posts.find((p) => /Callback call/.test(p.text));
  assert.ok(cbPost, 'callback card posted');
  const blocks = JSON.stringify(cbPost.blocks);
  assert.ok(blocks.includes('Hey Pat, this is Gabe with Acme Co. We emailed you about cutting your IT costs.'));
  for (const id of ['fseq_booked', 'fseq_no_answer', 'fseq_not_interested', 'fseq_call_back', 'fseq_wrong_number']) assert.ok(blocks.includes(id), id);
  const states = await stepStates(pg, seq.id);
  assert.equal(states.call_callback_1, 'posted');
});

test('the normal sequence carries on after a callback', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, seq, slackApi } = await postedCallStep(pg, svc, clientId);
  await svc.handleCallbackSubmit(cbSubmission(step.id, '2026-10-27T20:00:00Z'), { slackApi, now: NOW });
  const states = await stepStates(pg, seq.id);
  for (const k of ['call_day0_late', 'call_day1', 'email_day1', 'call_day3', 'email_proof', 'email_thoughts', 'email_breakup', 'call_day6']) {
    assert.equal(states[k], 'pending', `${k} untouched`);
  }
  const { rows: [s] } = await pg.query('SELECT status FROM followup_sequences WHERE id = $1', [seq.id]);
  assert.equal(s.status, 'active');
});

test('a second "call back later" on the callback card queues callback 2', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, seq, slackApi, deps, calls } = await postedCallStep(pg, svc, clientId);
  await svc.handleCallbackSubmit(cbSubmission(step.id, '2026-10-27T20:00:00Z'), { slackApi, now: NOW });
  await svc.runSequenceTick({ now: new Date('2026-10-27T20:01:00Z'), slackApi, deps, env: ENV });
  const { rows: [cb1] } = await pg.query(`SELECT * FROM followup_sequence_steps WHERE kind = 'call_callback_1'`);
  const res = await svc.handleCallbackSubmit(cbSubmission(cb1.id, '2026-10-28T15:00:00Z'), { slackApi, now: new Date('2026-10-27T20:05:00Z') });
  assert.equal(res.kind, 'call_callback_2');
  void seq; void calls;
});

test('a booking, reply, unsubscribe or DQ cancels the pending callback', { skip }, async () => {
  for (const cancel of ['booked', 'reply', 'unsub', 'dq']) {
    const { pg, svc, clientId } = await setup();
    const { step, seq, slackApi, deps, calls } = await postedCallStep(pg, svc, clientId, { lead_email: `cb-${cancel}@x.co` });
    const { rows: [src] } = await pg.query('SELECT * FROM pending_replies WHERE id = $1', [seq.source_reply_id]);
    await svc.handleCallbackSubmit(cbSubmission(step.id, '2026-10-27T22:00:00Z'), { slackApi, now: NOW });
    assert.equal((await stepStates(pg, seq.id)).call_callback_1, 'pending');

    let reason;
    if (cancel === 'booked') {
      reason = 'booked';
      await require('../src/services/meeting-booked').markMeetingBooked({ clientId, reply: src, slackUserId: 'U1' });
    } else if (cancel === 'dq') {
      reason = 'disqualified';
      await require('../src/services/disqualified-prospects').markDisqualified({ clientId, reply: src, slackUserId: 'U1' });
    } else {
      reason = 'inbound_reply';
      const msg = cancel === 'unsub' ? 'please unsubscribe me' : 'Actually, call me tomorrow instead';
      await addReply(pg, clientId, { lead_email: `cb-${cancel}@x.co`, inbound_message: msg, classification: cancel === 'unsub' ? 'UNSUBSCRIBE' : 'QUESTION', created_at: new Date(NOW.getTime() + 5 * MIN) });
      await svc.runSequenceTick({ now: new Date(NOW.getTime() + 10 * MIN), slackApi, deps, env: ENV });
    }
    assert.equal((await stepStates(pg, seq.id)).call_callback_1, `cancelled/sequence_${reason}`, cancel);
    const before = calls.posts.length;
    await svc.runSequenceTick({ now: new Date('2026-10-27T22:05:00Z'), slackApi, deps, env: ENV });
    assert.equal(calls.posts.length, before, `${cancel}: no callback card posts`);
  }
});

test('a callback set after the last step still fires (completed sequence is reopened)', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, seq, slackApi, deps, calls } = await postedCallStep(pg, svc, clientId);
  await pg.query(`UPDATE followup_sequence_steps SET status = 'skipped' WHERE sequence_id = $1 AND id <> $2`, [seq.id, step.id]);
  await svc.runSequenceTick({ now: new Date(NOW.getTime() + MIN), slackApi, deps, env: ENV });
  assert.equal((await pg.query('SELECT status FROM followup_sequences WHERE id = $1', [seq.id])).rows[0].status, 'completed');
  await svc.handleCallbackSubmit(cbSubmission(step.id, '2026-10-27T20:00:00Z'), { slackApi, now: new Date(NOW.getTime() + 2 * MIN) });
  assert.equal((await pg.query('SELECT status FROM followup_sequences WHERE id = $1', [seq.id])).rows[0].status, 'active');
  await svc.runSequenceTick({ now: new Date('2026-10-27T20:01:00Z'), slackApi, deps, env: ENV });
  assert.ok(calls.posts.some((p) => /Callback call/.test(p.text)));
});

test('wrong number cancels a pending callback too', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, seq, slackApi } = await postedCallStep(pg, svc, clientId);
  await svc.handleCallbackSubmit(cbSubmission(step.id, '2026-10-28T15:00:00Z'), { slackApi, now: NOW });
  const { rows: [late] } = await pg.query(`SELECT id FROM followup_sequence_steps WHERE kind = 'call_day0_late'`);
  await pg.query(`UPDATE followup_sequence_steps SET status = 'posted', slack_channel = 'C0BRRS8DV19', slack_ts = '2000.9' WHERE id = $1`, [late.id]);
  await svc.applyCallOutcome({ stepId: late.id, outcome: 'wrong_number', now: new Date(NOW.getTime() + MIN), slackApi, env: ENV });
  assert.equal((await stepStates(pg, seq.id)).call_callback_1, 'cancelled/wrong_number');
});

test('submitting twice does not schedule two callbacks', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { step, slackApi } = await postedCallStep(pg, svc, clientId);
  await svc.handleCallbackSubmit(cbSubmission(step.id, '2026-10-27T20:00:00Z'), { slackApi, now: NOW });
  const again = await svc.handleCallbackSubmit(cbSubmission(step.id, '2026-10-27T21:00:00Z'), { slackApi, now: NOW });
  assert.equal(again.applied, false);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM followup_sequence_steps WHERE kind LIKE 'call\\_callback\\_%'`)).rows[0].n, 1);
});
