/**
 * Ghosted-meeting follow-up: pure helpers, then the whole flow on a real Postgres
 * (PGlite, in memory; dev-only, skipped when not installed, like followup-sequence-db).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const text = require('../src/utils/ghosted-meeting-text');
const time = require('../src/utils/followup-sequence-time');

let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { /* skip below */ }
const skip = PGlite ? false : 'PGlite not installed (dev-only integration test)';

for (const k of ['ALLO_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'FIREFLIES_API_KEY', 'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];

const MIN = 60000;
const NOW = new Date('2026-10-27T17:00:00Z'); // Tue 12:00 CT
const ENV = { GHOSTED_MEETING_ENABLED: 'true', FOLLOWUP_CALLER_NAME: 'Gabe' };
const MEET_START = new Date('2026-10-27T15:00:00Z'); // 10:00 CT, ended 90 min before NOW
const MEET_END = new Date('2026-10-27T15:30:00Z');

// ─── pure ─────────────────────────────────────────────────────────────────────

test('meetingTimesFromPayload reads scheduler payloads and refuses wall-clock guesses', () => {
  const g = require('../src/services/ghosted-meetings');
  const a = g.meetingTimesFromPayload({ scheduled_event: { start_time: '2026-10-27T15:00:00-05:00', end_time: '2026-10-27T15:30:00-05:00' } });
  assert.equal(a.start.toISOString(), '2026-10-27T20:00:00.000Z');
  assert.equal(a.end.toISOString(), '2026-10-27T20:30:00.000Z');
  const b = g.meetingTimesFromPayload(JSON.stringify({ payload: { startTime: '2026-10-27T15:00:00Z' } }));
  assert.equal(b.start.toISOString(), '2026-10-27T15:00:00.000Z');
  assert.equal(b.end, null);
  assert.equal(g.meetingTimesFromPayload({ start_time: '2026-10-27 10:00' }), null, 'no offset, no guess');
  assert.equal(g.meetingTimesFromPayload({ email: 'a@b.co' }), null);
  assert.equal(g.meetingTimesFromPayload(null), null);
});

test('normalizeCalendarEvent handles Google and Microsoft shapes', () => {
  const g = require('../src/services/ghosted-meetings');
  const goog = g.normalizeCalendarEvent('google', {
    id: 'e1', status: 'confirmed', start: { dateTime: '2026-10-27T15:00:00Z' }, end: { dateTime: '2026-10-27T15:30:00Z' },
    attendees: [{ email: 'Host@Client.com', self: true }, { email: 'Pat@X.co', responseStatus: 'accepted' }],
  }, 'host@client.com');
  assert.deepEqual(goog.attendees.map((a) => a.email), ['pat@x.co']);
  assert.equal(goog.attendees[0].response, 'accepted');
  const ms = g.normalizeCalendarEvent('microsoft', {
    id: 'e2', isCancelled: true, start: { dateTime: '2026-10-27T15:00:00.0000000' }, end: { dateTime: '2026-10-27T15:30:00.0000000' },
    attendees: [{ emailAddress: { address: 'pat@x.co' }, status: { response: 'declined' } }],
  }, 'host@client.com');
  assert.equal(ms.cancelled, true);
  assert.equal(ms.attendees[0].response, 'declined');
  assert.equal(ms.start.toISOString(), '2026-10-27T15:00:00.000Z');
  assert.equal(g.normalizeCalendarEvent('google', { start: { date: '2026-10-27' } }, ''), null, 'all-day events have no time');
});

test('ghost copy: no claims, fixed scripts, two live times, nothing without times', () => {
  assert.match(text.ghostCallScript({ firstName: 'Pat', callerName: 'Gabe', clientName: 'Acme' }), /^Hey Pat, this is Gabe with Acme\. We had a meeting on the calendar/);
  const body = text.emailBody('ghost_email', { firstName: 'Pat', slots: [{ label: 'Thu 10am' }, { label: 'Fri 2pm' }] });
  assert.match(body, /^Hey Pat, looks like we missed each other\./);
  assert.match(body, /Thu 10am or Fri 2pm/);
  assert.equal(text.emailBody('ghost_email', { firstName: 'Pat', slots: [] }), null);
  assert.match(text.emailBody('ghost_email', { firstName: 'Pat', askForTimes: true }), /What time works/);
  assert.match(text.emailBody('ghost_breakup', { firstName: 'Pat' }), /don't want to keep emailing you/);
  assert.equal(text.emailBody('email_vm', {}), null);
  const seqText = require('../src/utils/followup-sequence-text');
  assert.equal(seqText.stepLabel('ghost_call'), 'Missed meeting call');
  assert.ok(Object.prototype.hasOwnProperty.call(seqText.CALL_KINDS, 'ghost_call_2'));
});

test('ghost plan: email now, call in the window, day 2 call + email, day 4 breakup, business days only', () => {
  const plan = text.planGhostSequence({ enrolledAt: NOW, timeZone: 'America/Chicago', time, env: {} });
  assert.deepEqual(plan.map((s) => s.kind), ['ghost_email', 'ghost_call', 'ghost_call_2', 'ghost_email_2', 'ghost_breakup']);
  assert.equal(plan[0].due.toISOString(), NOW.toISOString());
  assert.equal(plan[1].due.toISOString(), new Date(NOW.getTime() + 10 * MIN).toISOString());
  const wd = (d) => time.zonedParts(d, 'America/Chicago').weekday;
  assert.equal(wd(plan[2].due), 'Thu'); // Tue + 2 business days
  assert.equal(wd(plan[4].due), 'Mon'); // Tue + 4 business days
  // Enrolled late Friday: the call waits for Monday, never a weekend.
  const fri = text.planGhostSequence({ enrolledAt: new Date('2026-10-30T23:00:00Z'), timeZone: 'America/Chicago', time, env: {} });
  assert.equal(wd(fri[1].due), 'Mon');
});

test('Fireflies check: no key holds, never guesses', async () => {
  const g = require('../src/services/ghosted-meetings');
  const r = await g.checkFireflies({ start: MEET_START, end: MEET_END, email: 'p@x.co', name: 'Pat Smith' }, { env: {} });
  assert.equal(r.status, 'held');
  assert.equal(r.reason, 'fireflies_not_configured');
});

function ffApi({ list = [], detail = null, listError = null } = {}) {
  return {
    isConfigured: () => true,
    listTranscriptsBetween: async () => { if (listError) throw new Error(listError); return list; },
    getTranscriptAttendance: async () => detail,
  };
}
const withLead = { id: 't1', title: 'Call with Pat Smith', participants: ['pat@x.co'], meeting_info: { summary_status: 'processed' } };

test('Fireflies check: recording with the prospect speaking = attended; only the host = silent call; none = no recording', async () => {
  const g = require('../src/services/ghosted-meetings');
  const cand = { start: MEET_START, end: MEET_END, email: 'pat@x.co', name: 'Pat Smith' };
  const spoke = await g.checkFireflies(cand, { env: {}, deps: { firefliesApi: ffApi({ list: [withLead], detail: { sentences: [
    { speaker_name: 'Gabe', text: 'Hi' }, { speaker_name: 'Pat Smith', text: 'Hello' }] } }) } });
  assert.equal(spoke.status, 'attended');
  const silent = await g.checkFireflies(cand, { env: {}, deps: { firefliesApi: ffApi({ list: [withLead], detail: { sentences: [
    { speaker_name: 'Gabe', text: 'Hello? Anyone there?' }] } }) } });
  assert.deepEqual([silent.status, silent.reason], ['ghosted', 'silent_call']);
  const none = await g.checkFireflies(cand, { env: {}, deps: { firefliesApi: ffApi({ list: [{ id: 'other', title: 'Someone Else' }] }) } });
  assert.deepEqual([none.status, none.reason], ['ghosted', 'no_recording']);
  const flagged = await g.checkFireflies(cand, { env: {}, deps: { firefliesApi: ffApi({ list: [{ ...withLead, meeting_info: { silent_meeting: true } }] }) } });
  assert.equal(flagged.reason, 'silent_call');
  const proc = await g.checkFireflies(cand, { env: {}, deps: { firefliesApi: ffApi({ list: [{ ...withLead, meeting_info: { summary_status: 'processing' } }] }) } });
  assert.deepEqual([proc.status, proc.reason], ['held', 'transcript_processing']);
  const err = await g.checkFireflies(cand, { env: {}, deps: { firefliesApi: ffApi({ listError: 'HTTP 500' }) } });
  assert.deepEqual([err.status, err.reason], ['held', 'fireflies_error']);
});

test('nothing in the ghost files can send to a lead', () => {
  for (const f of ['src/services/ghosted-meetings.js', 'src/utils/ghosted-meeting-text.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/sendReplyToPlatform|reply-send|gmail-send|heyreach\.send|smartlead\.send|chat\.postMessage/i.test(s), f);
  }
});

// ─── database flow ────────────────────────────────────────────────────────────

// The services capture `db` at require time, so the PGlite adapter goes in before anything loads them.
let shared = null;
let schemaReady = null;
if (PGlite) {
  const pg = new PGlite();
  const adapter = {
    async query(sql, params) {
      const r = await pg.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
  require.cache[require.resolve('../src/db')] = { id: 'db', filename: 'db', loaded: true, exports: adapter };
  shared = { pg };
}

async function setup() {
  if (!schemaReady) {
    const root = path.join(__dirname, '..');
    schemaReady = shared.pg.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8').replace(/CREATE EXTENSION[^;]*;/gi, ''));
  }
  await schemaReady;
  shared.ghost = require('../src/services/ghosted-meetings');
  shared.seq = require('../src/services/followup-sequence');
  const { pg } = shared;
  await pg.exec(`TRUNCATE ghosted_meeting_checks, followup_sequence_steps, followup_sequences, followup_sequence_copy,
                          pending_replies, disqualified_prospects, meetings, outbound_follow_ups, calendar_connections RESTART IDENTITY`);
  if (!shared.clientId) {
    const { rows: [client] } = await pg.query(
      `INSERT INTO clients (name, slack_bot_token, slack_channel_id) VALUES ('Acme Co', 'xoxb-test', 'C1') RETURNING id`);
    shared.clientId = client.id;
  }
  return { ...shared };
}

let n = 0;
async function addReply(pg, clientId, over = {}) {
  n += 1;
  const row = {
    classification: 'INTERESTED', status: 'meeting_booked', slack_message_ts: `1700.${n}`,
    lead_email: 'pat@x.co', lead_name: 'Pat Smith', inbound_message: `Sounds good ${n}`,
    lead_phone: '+15555550100', phone_enrichment_status: 'found', created_at: new Date(NOW.getTime() - 3 * 24 * 60 * MIN),
    lead_timezone: 'America/Chicago', platform: 'smartlead', campaign_id: '111', lead_id: String(n), ...over,
  };
  const cols = Object.keys(row);
  const { rows: [r] } = await pg.query(
    `INSERT INTO pending_replies (client_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [clientId, ...cols.map((c) => row[c])]);
  return r;
}

function bookingEvent(over = {}) {
  return {
    id: 501, client_slug: 'acme', client_name: 'Acme Co', lead_email: 'pat@x.co', lead_name: 'Pat Smith',
    created_at: new Date(NOW.getTime() - 2 * 24 * 60 * MIN).toISOString(),
    payload: { scheduled_event: { start_time: MEET_START.toISOString(), end_time: MEET_END.toISOString() } },
    ...over,
  };
}

function fakes({ events = [bookingEvent()], firefliesApi = ffApi({ list: [] }), history = [] } = {}) {
  const calls = { posts: [], updates: [], cards: [], histories: [] };
  const slackApi = {
    getPermalink: async () => 'https://slack.example/p',
    updateMessage: async (...a) => { calls.updates.push(a); },
    getClient: () => ({ chat: {
      postMessage: async (a) => { calls.posts.push(a); return { ts: `2000.${calls.posts.length}` }; },
      update: async (a) => { calls.updates.push(['chat.update', a]); },
    } }),
  };
  const deps = {
    fetchBookingEvents: async () => ({ rows: events, error: null }),
    firefliesApi,
    channelHistory: async (a) => { calls.histories.push(a); return history; },
    postCard: async (a) => { calls.cards.push(a); return { ts: `3000.${calls.cards.length}` }; },
    resolveSlots: async () => ({ slots: [
      { start: '2026-11-02T16:00:00Z', label: 'Mon 10am' }, { start: '2026-11-02T20:00:00Z', label: 'Mon 2pm' }] }),
    resolveCopy: async () => ({ offerLine: 'cutting your IT costs', proofPoint: null }),
  };
  return { slackApi, deps, calls };
}

function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { if (a[0] === '[GhostedMeeting]') lines.push(JSON.parse(a[1])); else orig(...a); };
  return { lines, restore: () => { console.log = orig; } };
}

const checks = async (pg) => (await pg.query('SELECT * FROM ghosted_meeting_checks ORDER BY first_seen_at')).rows;

test('ghosted meeting is enrolled, posts its cards, and is traceable end to end', { skip }, async () => {
  const { pg, ghost, seq, clientId } = await setup();
  await addReply(pg, clientId);
  const { slackApi, deps, calls } = fakes();
  const cap = captureLogs();
  try {
    const res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps });
    assert.equal(res.enrolled, 1);
    assert.equal(res.candidates, 1);

    const [check] = await checks(pg);
    assert.equal(check.decision, 'enrolled');
    assert.equal(check.reason, 'no_recording');
    assert.ok(check.sequence_id);

    // Same scan again: one row, one sequence, no duplicate.
    const again = await ghost.runGhostedMeetingScan({ now: new Date(NOW.getTime() + MIN), env: ENV, deps });
    assert.equal(again.enrolled, 0);
    assert.equal((await checks(pg)).length, 1);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM followup_sequences')).rows[0].n, 1);

    const { rows: [sq] } = await pg.query('SELECT * FROM followup_sequences');
    assert.equal(sq.origin, 'ghosted_meeting');
    const kinds = (await pg.query('SELECT kind FROM followup_sequence_steps ORDER BY seq_order')).rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['ghost_email', 'ghost_call', 'ghost_call_2', 'ghost_email_2', 'ghost_breakup']);

    // Only the ghost flag is on: the tick posts the ghost cards and enrolls nothing else.
    await addReply(pg, clientId, { status: 'pending', lead_email: 'new@x.co', created_at: new Date(NOW.getTime() - MIN) });
    const t1 = await seq.runSequenceTick({ now: NOW, slackApi, deps, env: ENV });
    assert.equal(t1.enrolled, 0, 'the regular sequence stays off');
    assert.equal(t1.posted, 1);
    const email = calls.cards[0];
    assert.equal(email.channelId, 'C0BRRS8DV19');
    assert.match(email.card.draft, /^Hey Pat, looks like we missed each other\./);
    assert.match(email.card.draft, /Mon 10am or Mon 2pm/);
    assert.equal(email.card.classification, 'FOLLOW_UP');
    assert.match(email.card.reasoning, /Missed meeting \(no recording\)/);
    const { rows: [pr] } = await pg.query('SELECT status FROM pending_replies WHERE id = $1', [email.replyId]);
    assert.equal(pr.status, 'pending', 'nothing sends until a human approves');

    await seq.runSequenceTick({ now: new Date(NOW.getTime() + 11 * MIN), slackApi, deps, env: ENV });
    assert.equal(calls.posts.length, 1);
    const blocks = JSON.stringify(calls.posts[0].blocks);
    assert.match(blocks, /We had a meeting on the calendar and it looks like we missed each other/);
    assert.match(blocks, /fseq_booked/);

    // The trail names every stage, and each stage was logged as one line.
    const [done] = await checks(pg);
    const stages = done.trail.map((t) => t.stage);
    for (const s of ['candidate_found', 'fireflies_checked', 'ghosted', 'enrolled', 'posted']) {
      assert.ok(stages.includes(s), `trail has ${s}: ${stages.join(',')}`);
    }
    const logged = cap.lines.map((l) => l.stage);
    for (const s of ['candidate_found', 'fireflies_checked', 'ghosted', 'enrolled', 'posted']) {
      assert.ok(logged.includes(s), `log has ${s}`);
    }
    assert.ok(cap.lines.every((l) => !JSON.stringify(l).includes('xoxb')));
  } finally { cap.restore(); }
});

test('prospect attended: recorded as attended, nothing enrolled', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  await addReply(pg, clientId);
  const { deps } = fakes({ firefliesApi: ffApi({ list: [withLead], detail: { sentences: [
    { speaker_name: 'Gabe', text: 'Hi' }, { speaker_name: 'Pat Smith', text: 'Hey' }] } }) });
  const res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps });
  assert.equal(res.attended, 1);
  const [c] = await checks(pg);
  assert.deepEqual([c.decision, c.reason], ['attended', 'prospect_spoke']);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM followup_sequences')).rows[0].n, 0);
});

test('silent call (recording exists, prospect never spoke) is ghosted and enrolled', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  await addReply(pg, clientId);
  const { deps } = fakes({ firefliesApi: ffApi({ list: [withLead], detail: { sentences: [{ speaker_name: 'Gabe', text: 'Hello?' }] } }) });
  const res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps });
  assert.equal(res.enrolled, 1);
  const [c] = await checks(pg);
  assert.equal(c.reason, 'silent_call');
});

test('no Fireflies key: held with a reason, no sequence, and retried later', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  await addReply(pg, clientId);
  const { deps } = fakes({ firefliesApi: { ...ffApi(), isConfigured: () => false } });
  const res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps });
  assert.equal(res.held, 1);
  const [c] = await checks(pg);
  assert.deepEqual([c.decision, c.reason], ['held', 'fireflies_not_configured']);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM followup_sequences')).rows[0].n, 0);
  // Key arrives: the next scan decides it.
  const { deps: d2 } = fakes();
  const r2 = await ghost.runGhostedMeetingScan({ now: new Date(NOW.getTime() + 10 * MIN), env: ENV, deps: d2 });
  assert.equal(r2.enrolled, 1);
  assert.equal((await checks(pg)).length, 1);
});

test('too early (inside the grace period) leaves no trace; too old is ignored', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  await addReply(pg, clientId);
  const { deps } = fakes();
  await ghost.runGhostedMeetingScan({ now: new Date(MEET_END.getTime() + 20 * MIN), env: ENV, deps });
  assert.equal((await checks(pg)).length, 0);
  await ghost.runGhostedMeetingScan({ now: new Date(MEET_END.getTime() + 72 * 60 * MIN), env: ENV, deps });
  assert.equal((await checks(pg)).length, 0);
});

test('dedupe: a card someone posted by hand, an existing follow-up card, or an active sequence', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  const src = await addReply(pg, clientId);

  // 1. Posted by hand in the channel (name appears in a plain text message).
  let f = fakes({ history: [{ text: 'Pat Smith (Acme, 10:00am CT) no-show, please follow up' }] });
  let res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  assert.equal(res.enrolled, 0);
  let [c] = await checks(pg);
  assert.deepEqual([c.decision, c.reason], ['dropped', 'already_in_channel']);
  assert.equal(f.calls.histories[0].channel, 'C0BRRS8DV19');

  // 2. A FOLLOW_UP card for the lead already exists since the meeting.
  await pg.query('TRUNCATE ghosted_meeting_checks');
  await addReply(pg, clientId, { classification: 'FOLLOW_UP', status: 'pending', created_at: new Date(MEET_END.getTime() + 20 * MIN), inbound_message: '(no new reply from prospect)' });
  f = fakes();
  res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  [c] = await checks(pg);
  assert.equal(c.reason, 'follow_up_card_exists');
  await pg.query(`DELETE FROM pending_replies WHERE classification = 'FOLLOW_UP'`);

  // 3. The lead already has an active sequence.
  await pg.query('TRUNCATE ghosted_meeting_checks');
  await pg.query(
    `INSERT INTO followup_sequences (client_id, source_reply_id, platform, lead_key, lead_email, status)
     VALUES ($1, $2, 'smartlead', $3, 'pat@x.co', 'active')`, [clientId, src.id, `${clientId}|pat@x.co`]);
  f = fakes();
  res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  [c] = await checks(pg);
  assert.equal(c.reason, 'sequence_already_active');
});

test('a failed channel-history read does not block posting, and is logged', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  await addReply(pg, clientId);
  const f = fakes();
  f.deps.channelHistory = async () => { throw new Error('missing_scope'); };
  const cap = captureLogs();
  try {
    const res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
    assert.equal(res.enrolled, 1);
    assert.ok(cap.lines.some((l) => l.stage === 'dedupe_history_unavailable'));
  } finally { cap.restore(); }
});

test('dropped with a reason: cancelled, declined, rescheduled, disqualified, replied since, no source reply', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  const calConn = async () => pg.query(
    `INSERT INTO calendar_connections (client_id, provider, email, access_token, refresh_token) VALUES ($1, 'google', 'host@acme.co', 'a', 'r')`, [clientId]);

  // Calendar says the invitee declined / the event was cancelled.
  await addReply(pg, clientId);
  await calConn();
  for (const [ev, reason] of [
    [{ status: 'cancelled' }, 'meeting_cancelled'],
    [{ attendees: [{ email: 'pat@x.co', responseStatus: 'declined' }] }, 'invitee_declined'],
  ]) {
    await pg.query('TRUNCATE ghosted_meeting_checks');
    const f = fakes({ events: [] });
    f.deps.calendarApi = { google: { listEventsBetween: async () => [{
      id: 'ev', status: 'confirmed', start: { dateTime: MEET_START.toISOString() }, end: { dateTime: MEET_END.toISOString() },
      attendees: [{ email: 'pat@x.co', responseStatus: 'accepted' }], ...ev }] } };
    await pg.query(`UPDATE pending_replies SET status = 'meeting_booked'`);
    await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
    const [c] = await checks(pg);
    assert.equal(c.reason, reason);
    assert.equal(c.source, 'calendar');
  }

  // A later booking for the same lead: the earlier meeting was rescheduled.
  await pg.query('TRUNCATE ghosted_meeting_checks');
  let f = fakes({ events: [
    bookingEvent(),
    bookingEvent({ id: 502, payload: { start_time: new Date(NOW.getTime() + 24 * 60 * MIN).toISOString() } }),
  ] });
  await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  let [c] = await checks(pg);
  assert.equal(c.reason, 'rescheduled_or_replaced');

  // Disqualified.
  await pg.query('TRUNCATE ghosted_meeting_checks');
  await pg.query(`INSERT INTO disqualified_prospects (client_id, lead_email, platform) VALUES ($1, 'pat@x.co', 'smartlead')`, [clientId]);
  f = fakes();
  await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  [c] = await checks(pg);
  assert.equal(c.reason, 'disqualified');
  await pg.query('TRUNCATE disqualified_prospects');

  // The prospect wrote back after the meeting started: a card already exists for that.
  await pg.query('TRUNCATE ghosted_meeting_checks');
  await addReply(pg, clientId, { status: 'pending', created_at: new Date(MEET_END.getTime() + 10 * MIN), inbound_message: 'Sorry, got pulled away' });
  f = fakes();
  await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  [c] = await checks(pg);
  assert.equal(c.reason, 'prospect_replied_since_meeting');

  // No reply row to hang a sequence off.
  await pg.query('TRUNCATE ghosted_meeting_checks');
  await pg.query('TRUNCATE pending_replies CASCADE');
  f = fakes();
  await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  [c] = await checks(pg);
  assert.equal(c.reason, 'no_source_reply');
});

test('dry run decides and logs but enrolls nothing; flag off does nothing', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  await addReply(pg, clientId);
  const { deps } = fakes();
  const off = await ghost.runGhostedMeetingScan({ now: NOW, env: {}, deps });
  assert.equal(off.disabled, true);
  assert.equal((await checks(pg)).length, 0);
  const dry = await ghost.runGhostedMeetingScan({ now: NOW, env: {}, dryRun: true, deps });
  assert.equal(dry.ghosted, 1);
  assert.equal(dry.enrolled, 0);
  const [c] = await checks(pg);
  assert.equal(c.decision, 'ghosted');
  assert.ok(c.trail.some((t) => t.stage === 'dry_run'));
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM followup_sequences')).rows[0].n, 0);
  // Turning it on enrolls the same row (no duplicate check).
  const live = await ghost.runGhostedMeetingScan({ now: new Date(NOW.getTime() + MIN), env: ENV, deps });
  assert.equal(live.enrolled, 1);
  assert.equal((await checks(pg)).length, 1);
});

test('a normal sequence on the same reply can coexist with the ghost sequence', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  const src = await addReply(pg, clientId);
  await pg.query(
    `INSERT INTO followup_sequences (client_id, source_reply_id, platform, lead_key, lead_email, status)
     VALUES ($1, $2, 'smartlead', $3, 'pat@x.co', 'stopped')`, [clientId, src.id, `${clientId}|pat@x.co`]);
  const { deps } = fakes();
  const res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps });
  assert.equal(res.enrolled, 1);
  const origins = (await pg.query('SELECT origin FROM followup_sequences ORDER BY origin')).rows.map((r) => r.origin);
  assert.deepEqual(origins, ['ghosted_meeting', 'reply']);
});

test('ghost sequence stops when the prospect writes back or rebooks, and closes its unsent cards', { skip }, async () => {
  const { pg, ghost, seq, clientId } = await setup();
  await addReply(pg, clientId);
  const f = fakes();
  await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  await seq.runSequenceTick({ now: NOW, slackApi: f.slackApi, deps: f.deps, env: ENV });
  assert.equal(f.calls.cards.length, 1);
  const cardReplyId = f.calls.cards[0].replyId;

  // Still active while nothing changed (source reply is booked, that must not stop it).
  await seq.runSequenceTick({ now: new Date(NOW.getTime() + 2 * MIN), slackApi: f.slackApi, deps: f.deps, env: ENV });
  assert.equal((await pg.query(`SELECT status FROM followup_sequences`)).rows[0].status, 'active');

  await addReply(pg, clientId, { status: 'pending', classification: 'QUESTION', inbound_message: 'Sorry! Can we do Thursday?', created_at: new Date(NOW.getTime() + 3 * MIN) });
  const t = await seq.runSequenceTick({ now: new Date(NOW.getTime() + 4 * MIN), slackApi: f.slackApi, deps: f.deps, env: ENV });
  assert.ok(t.stopped >= 1);
  const { rows: [sq] } = await pg.query('SELECT status, stop_reason FROM followup_sequences');
  assert.deepEqual([sq.status, sq.stop_reason], ['stopped', 'inbound_reply']);
  const { rows: [pr] } = await pg.query('SELECT status FROM pending_replies WHERE id = $1', [cardReplyId]);
  assert.equal(pr.status, 'skipped');

  // Rebooking stops it too.
  await pg.query('TRUNCATE ghosted_meeting_checks, followup_sequence_steps, followup_sequences, pending_replies CASCADE');
  await addReply(pg, clientId);
  await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  const later = fakes({ events: [bookingEvent(), bookingEvent({ id: 700, created_at: new Date(NOW.getTime() + 5 * MIN).toISOString(), payload: null })] });
  const t2 = await seq.runSequenceTick({ now: new Date(NOW.getTime() + 10 * MIN), slackApi: later.slackApi, deps: later.deps, env: ENV });
  assert.ok(t2.stopped >= 1);
  const { rows: [sq2] } = await pg.query('SELECT status, stop_reason FROM followup_sequences');
  assert.deepEqual([sq2.status, sq2.stop_reason], ['stopped', 'rebooked']);
});

test('Meeting booked on a ghost card stops the sequence', { skip }, async () => {
  const { pg, ghost, seq, clientId } = await setup();
  const src = await addReply(pg, clientId);
  const { deps, slackApi } = fakes();
  await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps });
  assert.equal(await seq.stopSequencesForLead(src, 'booked', { slackApi }), 1);
  const { rows: [sq] } = await pg.query('SELECT status, stop_reason FROM followup_sequences');
  assert.deepEqual([sq.status, sq.stop_reason], ['stopped', 'booked']);
});

test('booked meetings come from the calendar too, using booked evidence from meetings', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  const src = await addReply(pg, clientId);
  await pg.query(`INSERT INTO meetings (client_id, pending_reply_id, lead_email, status) VALUES ($1, $2, 'pat@x.co', 'booked')`, [clientId, src.id]);
  await pg.query(`INSERT INTO calendar_connections (client_id, provider, email, access_token, refresh_token) VALUES ($1, 'google', 'host@acme.co', 'a', 'r')`, [clientId]);
  const f = fakes({ events: [] });
  f.deps.calendarApi = { google: { listEventsBetween: async () => [
    { id: 'ev1', status: 'confirmed', start: { dateTime: MEET_START.toISOString() }, end: { dateTime: MEET_END.toISOString() },
      attendees: [{ email: 'host@acme.co', self: true }, { email: 'pat@x.co' }] },
    { id: 'ev2', status: 'confirmed', start: { dateTime: MEET_START.toISOString() }, end: { dateTime: MEET_END.toISOString() },
      attendees: [{ email: 'stranger@y.co' }] },
  ] } };
  const res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
  assert.equal(res.candidates, 1, 'only the booked prospect, not every attendee on the calendar');
  assert.equal(res.enrolled, 1);
  const [c] = await checks(pg);
  assert.equal(c.source, 'calendar');
  assert.equal(c.meeting_end.toISOString(), MEET_END.toISOString());
});

test('a source that errors is reported, not fatal', { skip }, async () => {
  const { pg, ghost, clientId } = await setup();
  await addReply(pg, clientId);
  const f = fakes();
  f.deps.fetchBookingEvents = async () => ({ rows: [], error: 'booking_events_http_500' });
  const cap = captureLogs();
  try {
    const res = await ghost.runGhostedMeetingScan({ now: NOW, env: ENV, deps: f.deps });
    assert.deepEqual(res.sourceErrors, [{ source: 'booking_events', error: 'booking_events_http_500' }]);
    assert.ok(cap.lines.some((l) => l.stage === 'source_error'));
  } finally { cap.restore(); }
});
