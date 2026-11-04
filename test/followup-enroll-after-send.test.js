/**
 * Sandro Duval, Vector, Nov 4 2026 11:53 AM ET.
 * Card: "We only want Tesla chargers", rated Not a fit, still pending.
 * At 11:56 the sequence posted "Call today · Day 1 of 5 · went quiet..."
 * because Day 0 was due the moment the cron saw the card.
 *
 * Cayden: a posted card gets a follow-up unless he DQs or rejects it.
 * The reminder still waits three hours after the card (or after the send).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const seq = require('../src/services/followup-sequence');
const time = require('../src/utils/followup-sequence-time');

const POSTED = new Date('2026-11-04T16:53:00.000Z'); // 11:53 AM ET
const TICK = new Date('2026-11-04T16:56:00.000Z'); // 11:56 AM ET
const HOUR = 60 * 60 * 1000;

function sandro(over = {}) {
  const sec = Math.floor(POSTED.getTime() / 1000);
  return {
    id: 'sandro-duval',
    client_id: '11111111-1111-4111-8111-111111111111',
    client_name: 'Vector',
    client_tz: 'America/New_York',
    classification: 'INTERESTED',
    status: 'pending',
    slack_message_ts: `${sec}.000100`,
    lead_email: 'sandro.duval@example.com',
    lead_name: 'Sandro Duval',
    inbound_message: 'We only want Tesla chargers',
    platform: 'smartlead',
    campaign_id: 'vector-1',
    lead_id: '9001',
    lead_timezone: 'America/New_York',
    created_at: POSTED,
    updated_at: TICK,
    sent_reply: null,
    icp_verdict: { status: 'disqualified', reason: 'only wants Tesla chargers' },
    ...over,
  };
}

test('Sandro is enrolled from the card, and no reminder is due within 3 hours', () => {
  const reply = sandro();
  const anchor = seq.day0Anchor({ reply, now: TICK, env: {} });
  assert.equal(anchor.toISOString(), '2026-11-04T19:53:00.000Z');
  assert.equal(seq.cardPostedAt(reply).toISOString(), POSTED.toISOString());

  const steps = time.planSequence({ enrolledAt: anchor, timeZone: 'America/New_York' });
  const day0 = steps.find((s) => s.kind === 'call_day0').due;
  assert.ok(day0.getTime() - POSTED.getTime() >= 3 * HOUR);
  assert.ok(day0.getTime() > TICK.getTime(), 'the 11:56 tick must not post the reminder');
  assert.equal(time.inCallWindow(day0, 'America/New_York'), true);

  const sentAt = new Date('2026-11-04T18:00:00.000Z');
  const sent = sandro({ status: 'sent', sent_reply: 'Hey Sandro, Tuesday or Wednesday?', updated_at: sentAt });
  const sentAnchor = seq.day0Anchor({ reply: sent, now: TICK, env: {} });
  assert.equal(sentAnchor.toISOString(), '2026-11-04T21:00:00.000Z');
});

test('DQ or reject stops a running sequence; Not a fit does not', async () => {
  async function stopFor(status) {
    const stops = [];
    const db = {
      async query(sql, params) {
        const s = String(sql);
        if (/FROM followup_sequences s/i.test(s)) {
          return { rows: [{
            seq_id: 'seq-1',
            seq_origin: 'reply',
            seq_enrolled_at: POSTED,
            seq_client_id: sandro().client_id,
            seq_lead_email: sandro().lead_email,
            seq_client_active: true,
            ...sandro({ status }),
          }] };
        }
        if (/UPDATE followup_sequences/i.test(s)) {
          stops.push(params[1]);
          return { rows: [{ id: params[0], client_id: sandro().client_id }] };
        }
        return { rows: [] };
      },
    };
    const n = await seq.applyStopRules({
      dbClient: db,
      slackApi: { updateMessage: async () => {} },
    });
    return { n, stops };
  }

  const dq = await stopFor('disqualified');
  assert.equal(dq.n, 1);
  assert.deepEqual(dq.stops, ['disqualified']);

  const rejected = await stopFor('rejected');
  assert.equal(rejected.n, 1);
  assert.deepEqual(rejected.stops, ['rejected']);
});

test('a posted card enrolls, including pending and Not a fit; DQ and reject do not', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/followup-sequence.js'), 'utf8');
  assert.match(src, /const ENROLL_STATUSES = \['pending', 'approved', 'sending', 'sent', 'flagged'\]/);
  const enroll = src.slice(src.indexOf('async function enrollNewReplies'), src.indexOf('async function createSequence'));
  assert.match(enroll, /pr\.created_at >= \$2/);
  assert.match(enroll, /pr\.slack_message_ts IS NOT NULL/);
  assert.doesNotMatch(enroll, /sent_reply/);
  assert.doesNotMatch(enroll, /isNotAFitVerdict|not_a_fit|<> 'disqualified'/);
  const create = src.slice(src.indexOf('async function createSequence'), src.indexOf('async function stopReasonForLead'));
  assert.match(create, /day0Anchor\(\{ reply/);
  const stop = src.slice(src.indexOf('async function applyStopRules'), src.indexOf('async function completeFinishedSequences'));
  assert.match(stop, /source\.status === 'disqualified'/);
  assert.match(stop, /source\.status === 'rejected'/);
  assert.doesNotMatch(stop, /isNotAFitVerdict|not_a_fit/);
});
