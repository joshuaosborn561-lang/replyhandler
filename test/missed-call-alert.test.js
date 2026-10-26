const test = require('node:test');
const assert = require('node:assert');
const m = require('../src/services/missed-call-alert');

const now = Date.parse('2026-10-26T15:10:00Z');
const base = { id: 'c1', type: 'INBOUND', result: 'NO_ANSWER', start_date: '2026-10-26T15:00:00Z', from_number: '+15125550142', allo_number: '+19162701857' };

test('only missed inbound calls in the window are picked', () => {
  const calls = [
    base,
    { ...base, id: 'c2', type: 'OUTBOUND' },
    { ...base, id: 'c3', result: 'ANSWERED' },
    { ...base, id: 'c4', start_date: '2026-10-26T13:00:00Z' },
    { ...base, id: 'c5', result: 'VOICEMAIL' },
  ];
  assert.deepEqual(m.candidateCalls(calls, { now, env: {} }).map((c) => c.id), ['c1', 'c5']);
});

test('called person: Allo user first, then line owner map', () => {
  const env = { MISSED_CALL_LINE_OWNERS: '+19162701857=Owner@x.com' };
  assert.equal(m.calledPerson({ ...base, user_email: 'Rep@x.com' }, env).email, 'rep@x.com');
  assert.equal(m.calledPerson(base, env).email, 'owner@x.com');
});

test('slack user: env map, then lookupByEmail', async () => {
  const env = { MISSED_CALL_SLACK_USERS: 'owner@x.com=U1,(916) 270-1857=U2' };
  assert.equal(await m.resolveSlackUserId({ email: 'owner@x.com', line: '' }, null, env), 'U1');
  assert.equal(await m.resolveSlackUserId({ email: '', line: '+19162701857' }, null, env), 'U2');
  const api = { users: { lookupByEmail: async () => ({ user: { id: 'U9' } }) } };
  assert.equal(await m.resolveSlackUserId({ email: 'a@x.com', line: '' }, api, {}), 'U9');
});

test('alert text mentions the person, number and CT time; no buttons', () => {
  const t = m.alertText({ slackUserId: 'U1', line: base.allo_number, number: base.from_number, at: base.start_date });
  assert.equal(t, '<@U1> You missed a call from (512) 555-0142 at Mon, Oct 26, 10:00 AM CT. Can you call them back?');
  const t2 = m.alertText({ slackUserId: null, line: base.allo_number, number: base.from_number, at: base.start_date });
  assert.match(t2, /^Line \(916\) 270-1857 You missed a call/);
});

test('off by default', () => {
  assert.equal(m.enabled({}), false);
  assert.equal(m.enabled({ MISSED_CALL_ALERTS: 'true' }), true);
});
