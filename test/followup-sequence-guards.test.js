const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('OFF by default: flag unset or false means disabled and the tick does nothing', async () => {
  const seq = require('../src/services/followup-sequence');
  assert.equal(seq.enabled({}), false);
  assert.equal(seq.enabled({ FOLLOWUP_SEQUENCE_ENABLED: 'false' }), false);
  assert.equal(seq.enabled({ FOLLOWUP_SEQUENCE_ENABLED: '' }), false);
  assert.equal(seq.enabled({ FOLLOWUP_SEQUENCE_ENABLED: 'true' }), true);
  const boom = { query: async () => { throw new Error('must not touch the database when disabled'); } };
  const out = await seq.runSequenceTick({ dbClient: boom, env: {} });
  assert.equal(out.disabled, true);
});

test('cron only schedules the sequence tick behind the flag', () => {
  const cron = src('src/cron.js');
  const i = cron.indexOf('Follow-up card sequence for positive replies');
  assert.ok(i > 0);
  assert.match(cron.slice(i, i + 400), /if \(sequenceEnabled\(\)\)/);
});

test('the sequence never sends to a lead: no send path is imported', () => {
  const s = src('src/services/followup-sequence.js');
  assert.ok(!/sendReplyToPlatform|sendReply\(|gmail-send|heyreach\.send/i.test(s));
  // isSlackTestFixtureReply is the only thing taken from reply-send.
  assert.match(s, /const \{ isSlackTestFixtureReply \} = require\('\.\/reply-send'\)/);
  assert.equal((s.match(/require\('\.\/reply-send'\)/g) || []).length, 1);
});

test('email steps are ordinary FOLLOW_UP approval cards (a human clicks Approve)', () => {
  const s = src('src/services/followup-sequence.js');
  assert.match(s, /'FOLLOW_UP', \$11, 'pending'/);
  assert.match(s, /isDraft: true/);
});

test('call card has one button per outcome and nothing that sends', () => {
  const { buildCallCardBlocks } = require('../src/services/followup-sequence');
  const blocks = buildCallCardBlocks({
    label: 'Day 0 call', leadName: 'Pat', phone: '+15555550100', clientName: 'Acme', script: 's', voicemail: null,
  }, 'step-1');
  const actions = blocks.find((b) => b.type === 'actions').elements;
  assert.deepEqual(actions.map((a) => a.action_id), [
    'fseq_booked', 'fseq_no_answer', 'fseq_not_interested', 'fseq_call_back', 'fseq_wrong_number']);
  assert.ok(actions.every((a) => a.value === 'step-1'));
  assert.ok(!actions.some((a) => /connected$/i.test(a.text.text.trim())), 'no bare Connected button');
  assert.deepEqual(actions.map((a) => a.text.text), [
    '📅 Meeting booked', '📵 No answer / left voicemail', '🚫 Spoke to them: not interested',
    '🔁 Spoke to them: call back later', '❌ Wrong number']);
  assert.ok(actions.every((a) => a.text.text.length <= 75), 'Slack button text limit');
  const done = buildCallCardBlocks({
    label: 'Day 0 call', leadName: 'Pat', phone: '+15555550100', clientName: 'Acme', script: 's', voicemail: 'v',
  }, 'step-1', { outcome: 'no_answer', outcomeBy: 'U1' });
  assert.ok(!done.some((b) => b.type === 'actions'), 'buttons are gone once an outcome is recorded');
});

test('the old cadence yields to the sequence for positive replies only when the flag is on', () => {
  const s = src('src/services/outbound-follow-up.js');
  assert.match(s, /require\('\.\/followup-sequence'\)\.enabled\(\) && isPositiveFollowUpClassification/);
});

test('migration is listed and creates the three tables', () => {
  assert.match(src('scripts/run-migrations.js'), /045_followup_sequences\.sql/);
  const m = src('migrations/045_followup_sequences.sql');
  for (const t of ['followup_sequences', 'followup_sequence_steps', 'followup_sequence_copy']) {
    assert.match(m, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
    assert.match(src('schema.sql'), new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
  }
});

test('admin copy override exists and, like every admin route, takes no key', () => {
  const admin = src('src/routes/admin.js');
  assert.match(admin, /'\/admin\/followup-sequence\/copy', async/);
  assert.doesNotMatch(admin, /requireAdminApiKey/);
});

test('the Slack route validates the callback modal before acknowledging it', () => {
  const r = src('src/routes/slack.js');
  const i = r.indexOf("callback_id === 'fseq_callback_modal'");
  assert.ok(i > 0);
  const block = r.slice(i, i + 700);
  assert.ok(block.indexOf('validateCallbackSubmission') < block.indexOf("response_action: 'clear'"));
  assert.match(block, /response_action: 'errors'/);
});
