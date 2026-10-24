const test = require('node:test');
const assert = require('node:assert');
const m = require('../src/services/follow-up-call-reminder');

function fakeDb({ source = null, fallback = null } = {}) {
  const claimed = new Set();
  return {
    async query(sql, params = []) {
      if (/CREATE TABLE/.test(sql)) return { rows: [] };
      if (/WHERE id = \$1/.test(sql)) return { rows: source ? [source] : [] };
      if (/FROM pending_replies/.test(sql)) return { rows: fallback ? [fallback] : [] };
      if (/INSERT INTO follow_up_call_reminders/.test(sql)) {
        const k = `${params[0]}|${params[1]}`;
        if (claimed.has(k)) return { rows: [] };
        claimed.add(k); return { rows: [{ lead_key: params[0] }] };
      }
      throw new Error(`unexpected sql ${sql}`);
    },
  };
}

test('phone comes from the source reply first, then any row for the lead', async () => {
  let r = await m.phoneForFollowUp(fakeDb({ source: { lead_phone: '+15555550100', lead_phone_provider: 'fullenrich' } }), { clientId: 1, sourceReplyId: 9 });
  assert.deepEqual(r, { phone: '+15555550100', provider: 'fullenrich' });
  r = await m.phoneForFollowUp(fakeDb({ source: {}, fallback: { lead_phone_alt: '+15555550101' } }), { clientId: 1, sourceReplyId: 9, leadEmail: 'a@b.co' });
  assert.equal(r.phone, '+15555550101');
  r = await m.phoneForFollowUp(fakeDb(), { clientId: 1 });
  assert.equal(r.phone, null);
});

test('reminder fires at most once per lead per Central day', async () => {
  m._resetForTests();
  const db = fakeDb();
  const key = m.leadKey({ clientId: 1, leadEmail: 'A@B.co' });
  const day1 = new Date('2026-10-26T15:00:00Z');
  assert.equal(await m.claimDailyCallReminder(db, { key, phone: '+1', now: day1 }), true);
  assert.equal(await m.claimDailyCallReminder(db, { key, phone: '+1', now: new Date('2026-10-27T03:00:00Z') }), false, 'same Central day (10pm CT)');
  assert.equal(await m.claimDailyCallReminder(db, { key, phone: '+1', now: new Date('2026-10-27T15:00:00Z') }), true);
  assert.equal(await m.claimDailyCallReminder(db, { key: m.leadKey({ clientId: 1, leadEmail: 'x@y.co' }), phone: '+1', now: day1 }), true);
});

test('no phone or no lead key means no reminder', async () => {
  m._resetForTests();
  assert.equal(await m.claimDailyCallReminder(fakeDb(), { key: 'k', phone: null }), false);
  assert.equal(await m.claimDailyCallReminder(fakeDb(), { key: '', phone: '+1' }), false);
  assert.equal(m.reminderLine('+15555550100'), '📞 Call +15555550100 before sending');
});
