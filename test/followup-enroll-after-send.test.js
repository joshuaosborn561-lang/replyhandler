/**
 * Sandro Duval, Vector, Nov 4 2026 11:53 AM ET.
 * Card: "We only want Tesla chargers", rated Not a fit, still pending.
 * At 11:56 the sequence posted "Call today · Day 1 of 5 · went quiet..."
 * because a pending card enrolled immediately and Day 0 was "now".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const seq = require('../src/services/followup-sequence');
const time = require('../src/utils/followup-sequence-time');

const SENT_AT = new Date('2026-11-04T16:53:00.000Z'); // 11:53 AM ET
const TICK = new Date('2026-11-04T16:56:00.000Z'); // 11:56 AM ET
const HOUR = 60 * 60 * 1000;

function sandro(over = {}) {
  return {
    id: 'sandro-duval',
    client_id: '11111111-1111-4111-8111-111111111111',
    client_name: 'Vector',
    client_tz: 'America/New_York',
    classification: 'INTERESTED',
    status: 'pending',
    slack_message_ts: '1762271580.000100',
    lead_email: 'sandro.duval@example.com',
    lead_name: 'Sandro Duval',
    inbound_message: 'We only want Tesla chargers',
    platform: 'smartlead',
    campaign_id: 'vector-1',
    lead_id: '9001',
    lead_timezone: 'America/New_York',
    created_at: SENT_AT,
    updated_at: SENT_AT,
    sent_reply: null,
    icp_verdict: { status: 'disqualified', reason: 'only wants Tesla chargers' },
    ...over,
  };
}

function fakeDb(rows) {
  const writes = [];
  return {
    writes,
    async query(sql) {
      const s = String(sql);
      if (/INSERT INTO followup_sequences|INSERT INTO followup_sequence_steps/i.test(s)) {
        writes.push(s);
        return { rows: [{ id: 'seq-should-not-exist' }] };
      }
      if (/FROM pending_replies/i.test(s) && /followup_sequences/i.test(s)) {
        return { rows };
      }
      return { rows: [] };
    },
  };
}

test('Sandro is not enrolled: pending, Not a fit, and Day 0 is not the card time', async () => {
  const db = fakeDb([sandro()]);
  const out = await seq.enrollNewReplies({ now: TICK, dbClient: db, env: { FOLLOWUP_SEQUENCE_ENABLED: 'true' } });
  assert.equal(out.enrolled, 0);
  assert.equal(db.writes.length, 0);
  assert.equal(seq.isNotAFitVerdict(sandro().icp_verdict), true);

  const pendingFit = sandro({ icp_verdict: { status: 'qualified', reason: 'EV installer' }, status: 'pending' });
  const db2 = fakeDb([pendingFit]);
  const out2 = await seq.enrollNewReplies({ now: TICK, dbClient: db2, env: { FOLLOWUP_SEQUENCE_ENABLED: 'true' } });
  assert.equal(out2.enrolled, 0);
  assert.equal(db2.writes.length, 0);

  const flagged = sandro({
    status: 'flagged',
    sent_reply: 'Hey Sandro, Tuesday?',
    icp_verdict: { status: 'qualified', reason: 'EV installer' },
  });
  const db3 = fakeDb([flagged]);
  const out3 = await seq.enrollNewReplies({ now: TICK, dbClient: db3, env: { FOLLOWUP_SEQUENCE_ENABLED: 'true' } });
  assert.equal(out3.enrolled, 0);
  assert.equal(db3.writes.length, 0);

  const sentNotFit = sandro({ status: 'sent', sent_reply: 'Hey Sandro, want to walk through chargers?' });
  const db4 = fakeDb([sentNotFit]);
  const out4 = await seq.enrollNewReplies({ now: TICK, dbClient: db4, env: { FOLLOWUP_SEQUENCE_ENABLED: 'true' } });
  assert.equal(out4.enrolled, 0);
  assert.equal(db4.writes.length, 0);
});

test('Day 0 is the send plus a few hours, not the enrollment tick', () => {
  const anchor = seq.day0Anchor({ sentAt: SENT_AT, now: TICK, env: {} });
  assert.equal(anchor.toISOString(), '2026-11-04T19:53:00.000Z');
  const steps = time.planSequence({ enrolledAt: anchor, timeZone: 'America/New_York' });
  const day0 = steps.find((s) => s.kind === 'call_day0').due;
  assert.ok(day0.getTime() - SENT_AT.getTime() >= 3 * HOUR);
  assert.ok(day0.getTime() > TICK.getTime(), 'the 11:56 reminder must not be due');
  assert.equal(time.inCallWindow(day0, 'America/New_York'), true);

  const immediate = time.planSequence({ enrolledAt: TICK, timeZone: 'America/New_York' });
  assert.equal(immediate.find((s) => s.kind === 'call_day0').due.toISOString(), TICK.toISOString());
});

test('enrollment SQL is sent-only and Not a fit is excluded', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/followup-sequence.js'), 'utf8');
  assert.match(src, /const ENROLL_STATUSES = \['sent'\]/);
  const enroll = src.slice(src.indexOf('async function enrollNewReplies'), src.indexOf('async function createSequence'));
  assert.match(enroll, /btrim\(coalesce\(pr\.sent_reply, ''\)\) <> ''/);
  assert.match(enroll, /pr\.updated_at >= \$2/);
  assert.match(enroll, /icp_verdict->>'status', ''\) <> 'disqualified'/);
  assert.match(enroll, /isNotAFitVerdict\(reply\.icp_verdict\)/);
  assert.doesNotMatch(enroll, /'pending'|'flagged'/);
  const create = src.slice(src.indexOf('async function createSequence'), src.indexOf('async function stopReasonForLead'));
  assert.match(create, /day0Anchor\(/);
  assert.match(create, /enrolledAt: anchor/);
});
