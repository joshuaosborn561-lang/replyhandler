const test = require('node:test');
const assert = require('node:assert');
const m = require('../src/services/missed-call-followup');

test('outcome: Jev label wins, then Allo result', () => {
  assert.equal(m.callOutcome({ result: 'ANSWERED' }, 'voicemail'), 'missed');
  assert.equal(m.callOutcome({ result: 'VOICEMAIL' }, 'interested'), 'connected');
  assert.equal(m.callOutcome({ result: 'VOICEMAIL' }), 'missed');
  assert.equal(m.callOutcome({ result: 'no answer' }), 'missed');
  assert.equal(m.callOutcome({ result: 'ANSWERED' }), 'connected');
  assert.equal(m.callOutcome({ result: 'CLOSED' }), null);
  assert.equal(m.callOutcome({}, 'hung_up_or_no_response'), 'missed');
});

test('candidates: outbound, by the caller, inside the window', () => {
  const now = Date.parse('2026-10-26T16:00:00Z');
  const env = { MISSED_CALL_CALLER_EMAILS: 'caller@example.com', MISSED_CALL_LOOKBACK_MINUTES: '60' };
  const calls = [
    { id: 'a', type: 'OUTBOUND', user_email: 'caller@example.com', start_date: '2026-10-26T15:30:00Z' },
    { id: 'b', type: 'INBOUND', user_email: 'caller@example.com', start_date: '2026-10-26T15:30:00Z' },
    { id: 'c', type: 'OUTBOUND', user_email: 'other@example.com', start_date: '2026-10-26T15:30:00Z' },
    { id: 'd', type: 'OUTBOUND', user_email: 'caller@example.com', start_date: '2026-10-26T13:00:00Z' },
  ];
  assert.deepEqual(m.candidateCalls(calls, { now, env }).map((c) => c.id), ['a']);
});

test('off unless MISSED_CALL_FOLLOWUPS=true; default caller is Cayden', () => {
  assert.equal(m.enabled({}), false);
  assert.equal(m.enabled({ MISSED_CALL_FOLLOWUPS: 'true' }), true);
  assert.deepEqual(m.callerEmails({}), ['cayden@salesglidergrowth.com']);
});

test('runner is a no-op while disabled', async () => {
  const prev = process.env.MISSED_CALL_FOLLOWUPS;
  delete process.env.MISSED_CALL_FOLLOWUPS;
  const r = await m.runMissedCallFollowUps({ postCard: () => { throw new Error('should not post'); } });
  assert.deepEqual(r, { calls: 0, missed: 0, matched: 0, carded: 0 });
  if (prev !== undefined) process.env.MISSED_CALL_FOLLOWUPS = prev;
});
