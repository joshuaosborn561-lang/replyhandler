const test = require('node:test');
const assert = require('node:assert');
const { callNowDraft, firstNameOf } = require('../src/utils/call-now-variant');

const env = { CALL_NOW_TEST: 'true', CALL_NOW_TEST_START: '2026-10-22T00:00:00Z' };
const base = { mobilePhone: '+15555550100', classification: 'INTERESTED', draft: 'long draft', status: 'pending', leadName: 'pat smith', createdAt: '2026-10-23T00:00:00Z' };

test('mobile + positive + in window -> call-now text', () => {
  assert.strictEqual(callNowDraft(base, env), 'Hey Pat, calling you now.');
  assert.strictEqual(callNowDraft({ ...base, classification: 'MEETING_PROPOSED' }, env), 'Hey Pat, calling you now.');
});
test('off unless flag + start set', () => {
  assert.strictEqual(callNowDraft(base, {}), null);
  assert.strictEqual(callNowDraft(base, { CALL_NOW_TEST: 'true' }), null);
});
test('no mobile, no draft, non-positive, not pending, or outside window -> null', () => {
  assert.strictEqual(callNowDraft({ ...base, mobilePhone: null }, env), null);
  assert.strictEqual(callNowDraft({ ...base, draft: null }, env), null);
  assert.strictEqual(callNowDraft({ ...base, classification: 'QUESTION' }, env), null);
  assert.strictEqual(callNowDraft({ ...base, status: 'sent' }, env), null);
  assert.strictEqual(callNowDraft({ ...base, createdAt: '2026-10-21T00:00:00Z' }, env), null);
  assert.strictEqual(callNowDraft({ ...base, createdAt: '2026-10-30T00:00:00Z' }, env), null);
  assert.strictEqual(callNowDraft({ ...base, leadName: '' }, env), null);
});
test('firstNameOf', () => { assert.strictEqual(firstNameOf('  jo-ann  x'), 'Jo-ann'); });
