'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const layout = require('../src/utils/followup-card-layout');
const seq = require('../src/services/followup-sequence');
const { buildDraftApprovalCard, buildThreadModalView, isConfirmedMobile } = require('../src/services/slack');
const events = require('../src/services/followup-card-events');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const flat = (blocks) => JSON.stringify(blocks);

const REPLY = '11111111-1111-4111-8111-111111111111';
const STEP = '22222222-2222-4222-8222-222222222222';

function ids(blocks) {
  return blocks
    .filter((b) => b.type === 'actions' || b.type === 'section')
    .flatMap((b) => (b.elements || []).map((e) => e.action_id || (e.type === 'overflow' ? 'overflow' : '')))
    .filter(Boolean);
}

test('call card headline, buttons, overflow, and no gatekeeper', () => {
  const blocks = layout.buildSequenceCard({
    variant: 'call',
    kind: 'call_day0',
    stepId: STEP,
    sourceReplyId: REPLY,
    campaign: 'Owners (4242)',
    leadName: 'Pat Prospect',
    title: 'CEO',
    company: 'Example Co',
    phone: '+15555550100',
    email: 'pat@example.com',
    localTime: '8:08 AM local',
    enrichmentReceipt: { phoneLabel: 'mobile' },
    icp: { status: 'qualified', reason: 'staffing firm, high-ticket B2B', decision_maker: { status: 'yes', title: 'CEO', reason: 'owner' } },
    theirText: 'Sure thank you!',
    theirAt: '2026-10-27T15:00:00Z',
    tz: 'America/New_York',
    scriptParts: {
      opening: 'Hey Pat, this is (name) with Example Co.',
      ifAnswer: 'How are you getting new clients today?',
      ifVoicemail: "I'll shoot you a quick email.",
    },
    nextHint: 'Next: follow-up email if no answer',
    platform: 'smartlead',
  });
  const text = flat(blocks);
  assert.match(blocks[0].text.text, /📞 \*Call today\* · Day 1 of 5 · went quiet after "Sure thank you!" on Tue/);
  assert.doesNotMatch(text, /gatekeeper/i);
  assert.doesNotMatch(blocks[0].text.text, /Example Co/);
  assert.match(text, /8:08 AM local/);
  assert.match(text, /_\(mobile\)_/);
  assert.match(text, /Fit — staffing firm, high-ticket B2B/);
  assert.match(text, /Decision maker: Yes/);
  assert.match(text, /\*Script:\* Hey Pat, this is \(name\) with Example Co\./);
  assert.match(text, /• Ask: How are you getting new clients today\?/);
  assert.match(text, /I'll shoot you a quick email/);
  assert.equal(text.split('this is (name)').length - 1, 1);
  const actions = blocks.filter((b) => b.type === 'actions');
  assert.deepEqual(actions[0].elements.map((e) => e.action_id), [
    'fseq_booked', 'fseq_no_answer', 'fseq_call_back', 'fseq_snooze', 'fseq_not_interested',
  ]);
  assert.equal(actions[0].elements[1].text.text, '📵 No answer / Left VM');
  assert.equal(actions[1].elements[0].type, 'overflow');
  assert.deepEqual(actions[1].elements[0].options.map((o) => o.value), [
    `wrong_number:${STEP}`,
    `dq:${STEP}`,
  ]);
  assert.ok(ids(blocks).includes('view_thread'));
  assert.equal(blocks[blocks.length - 1].type, 'context');
  assert.ok(actions[0] && blocks.indexOf(actions[0]) < blocks.length - 1);
  const landline = flat(layout.buildSequenceCard({
    variant: 'call', kind: 'call_day0', stepId: STEP, phone: '+15555550199',
    enrichmentReceipt: { phoneLabel: 'landline' }, script: 's',
  }));
  assert.match(landline, /15555550199/);
  assert.doesNotMatch(landline, /_\(mobile\)_/);
  assert.equal(isConfirmedMobile({ phoneType: 'mobile' }), true);
  assert.equal(isConfirmedMobile({ phoneLabel: 'voip' }), false);
});

test('email card shows only the last exchange and the draft', () => {
  const { blocks } = buildDraftApprovalCard({
    replyId: REPLY,
    leadName: 'Pat Prospect',
    leadEmail: 'pat@example.com',
    platform: 'smartlead',
    classification: 'FOLLOW_UP',
    draft: 'Hey Pat, want me to hold Thursday?',
    inboundMessage: 'Sure thank you!',
    lastOutboundMessage: 'Happy to send over a few times, does Thursday work?',
    campaignDisplay: 'Owners (4242)',
    clientName: 'Northwind',
    threadMessages: [
      { role: 'us', body: 'First cold email that must stay off the card' },
      { role: 'them', body: 'An older reply' },
      { role: 'us', body: 'Happy to send over a few times, does Thursday work?' },
      { role: 'them', body: 'Sure thank you!' },
    ],
    followupContext: {
      campaign: 'Owners (4242)',
      lead: { name: 'Pat Prospect', title: 'CEO', company: 'Example Co' },
      sequence: { kind: 'email_proof', stepId: STEP, sourceReplyId: REPLY, priorCallDow: 'Mon' },
    },
  });
  const text = flat(blocks);
  assert.match(blocks[0].text.text, /✉️ \*Send follow-up\* · Day 3 of 5 · no answer to call Mon/);
  assert.doesNotMatch(text, /Northwind/);
  assert.doesNotMatch(text, /First cold email/);
  assert.doesNotMatch(text, /An older reply/);
  assert.match(text, /We said/);
  assert.match(text, /Happy to send over a few times/);
  assert.match(text, /They said/);
  assert.match(text, /Sure thank you!/);
  assert.match(text, /\*Draft\*/);
  assert.match(text, /Hey Pat, want me to hold Thursday\?/);
  assert.doesNotMatch(text, /WILL SEND/);
  assert.ok(ids(blocks).includes('approve_reply'));
  assert.ok(ids(blocks).includes('fseq_snooze'));
  assert.ok(ids(blocks).includes('reject_reply'));
  assert.ok(ids(blocks).includes('view_thread'));
  const actionAt = blocks.findIndex((b) => b.type === 'actions');
  assert.ok(actionAt > blocks.findIndex((b) => /\*Draft\*/.test(b.text?.text || '')));
  assert.equal(blocks[blocks.length - 1].type, 'context');
});

test('no-show card is a rebook with Call instead and no gatekeeper', () => {
  const blocks = layout.buildSequenceCard({
    kind: 'ghost_email',
    stepId: STEP,
    replyId: REPLY,
    sourceReplyId: REPLY,
    leadName: 'Pat',
    draft: 'Hey Pat, looks like we missed each other.',
    meeting: { label: 'No-show', text: 'Tue 2:30 PM ET' },
    platform: 'smartlead',
  });
  const text = flat(blocks);
  assert.match(blocks[0].text.text, /↩️ \*Rebook no-show\* · missed Tue 2:30 PM ET/);
  assert.doesNotMatch(text, /Day \d of 5/);
  assert.doesNotMatch(text, /We said/);
  assert.doesNotMatch(text, /gatekeeper/i);
  assert.ok(ids(blocks).includes('fseq_call_instead'));
  assert.ok(!ids(blocks).includes('fseq_snooze'));
  assert.match(text, /\*Draft\*/);
});

test('snooze is a date picker, validated before it is acknowledged', () => {
  const view = layout.buildSnoozeModal({
    stepId: STEP, replyId: REPLY, channel: 'C1', ts: '1.2', tz: 'America/Chicago',
    now: new Date('2026-10-27T17:00:00Z'),
  });
  assert.equal(view.callback_id, 'fseq_snooze_modal');
  assert.equal(view.blocks.find((b) => b.type === 'input').element.type, 'datepicker');
  assert.equal(view.title.text.length <= 24, true);
  const bad = layout.validateSnoozeSubmission({
    view: {
      private_metadata: JSON.stringify({ tz: 'America/Chicago' }),
      state: { values: { snooze_block: { snooze_date: { selected_date: '2020-01-01' } } } },
    },
  }, { now: new Date('2026-10-27T17:00:00Z') });
  assert.ok(bad && bad.snooze_block);
  const route = read('src/routes/slack.js');
  const i = route.indexOf("callback_id === 'fseq_snooze_modal'");
  assert.ok(i > 0);
  const block = route.slice(i, i + 700);
  assert.ok(block.indexOf('validateSnoozeSubmission') < block.indexOf("response_action: 'clear'"));
});

test('history modal keeps the full thread and a timeline, and old action ids still apply', () => {
  const lines = [
    events.eventLine({ created_at: '2026-10-27T15:00:00Z', event_type: 'posted', kind: 'call_day0' }),
    events.eventLine({ created_at: '2026-10-27T16:00:00Z', event_type: 'outcome', outcome: 'no_answer', slack_user_id: 'U1' }),
    events.eventLine({ created_at: '2026-10-28T16:00:00Z', event_type: 'snooze', outcome: 'snoozed', slack_user_id: 'U2', detail: { until: '2026-10-29T14:00:00Z' } }),
  ];
  const modal = buildThreadModalView({
    replyId: REPLY,
    threadMessages: [{ role: 'them', body: 'Sure thank you!' }, { role: 'us', body: 'Happy to send times.' }],
    historyLines: lines,
  });
  assert.equal(modal.title.text, 'Thread & history');
  const text = flat(modal.blocks);
  assert.match(text, /Sure thank you!/);
  assert.match(text, /Happy to send times/);
  assert.match(text, /\*Lead history\*/);
  assert.match(text, /No answer \/ Left VM/);
  assert.match(text, /<@U1>/);
  assert.match(text, /Snoozed/);
  assert.doesNotMatch(text, /Pat /);
  const plain = buildThreadModalView({ replyId: REPLY, inboundMessage: 'Hi' });
  assert.equal(plain.title.text, 'Full thread');
  assert.equal(seq.OUTCOME_BY_ACTION.fseq_booked, 'booked');
  assert.equal(seq.OUTCOME_BY_ACTION.fseq_no_answer, 'no_answer');
  assert.equal(seq.OUTCOME_BY_ACTION.fseq_not_interested, 'not_interested');
  assert.equal(seq.OUTCOME_BY_ACTION.fseq_call_back, 'call_back');
  assert.equal(seq.OUTCOME_BY_ACTION.fseq_wrong_number, 'wrong_number');
  assert.equal(seq.OUTCOME_BY_ACTION.fseq_dq, 'dq');
});

test('one open card per lead uses the supersede path, and clicks are stored', () => {
  const src = read('src/services/followup-sequence.js');
  assert.match(src, /supersedeEarlierLeadCards/);
  assert.match(src, /supersedeRows/);
  assert.match(src, /outcome = 'superseded'/);
  assert.match(read('src/services/supersede-cards.js'), /COALESCE\(classification, ''\) <> 'FOLLOW_UP'/);
  assert.match(read('scripts/run-migrations.js'), /054_followup_card_events\.sql/);
  assert.match(read('schema.sql'), /CREATE TABLE IF NOT EXISTS followup_card_events/);
  assert.match(read('migrations/054_followup_card_events.sql'), /followup_card_events/);
  assert.match(read('src/services/card-click-guard.js'), /fu_snooze/);
  const decisions = read('DECISIONS.md');
  assert.match(decisions, /Follow-up cards: one open card, call outcomes, and a history modal/);
});
