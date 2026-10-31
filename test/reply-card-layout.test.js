const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildDraftApprovalCard,
  buildThreadModalView,
  draftApprovalActionsBlock,
  isBackAndForthThread,
} = require('../src/services/slack');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const REPLY_ID = '11111111-0000-4000-8000-000000000010';
const PHONE = '+15555550123';
const CLIENT = 'Northwind';
const CAMPAIGN = 'Intro owners (4242)';

function flat(blocks) {
  return blocks.map((b) => {
    if (b.type === 'header') return b.text?.text || '';
    if (b.text?.text) return b.text.text;
    if (b.elements) return b.elements.map((e) => e.text || '').join(' ');
    return '';
  }).join('\n');
}

function actionIds(blocks) {
  return blocks
    .filter((b) => b.type === 'actions')
    .flatMap((b) => b.elements.map((e) => e.action_id));
}

function actionValues(blocks) {
  return blocks
    .filter((b) => b.type === 'actions')
    .flatMap((b) => b.elements.filter((e) => e.value != null).map((e) => e.value));
}

const FIRST = {
  replyId: REPLY_ID,
  clientName: CLIENT,
  campaignDisplay: CAMPAIGN,
  leadName: 'Pat Prospect',
  leadTitle: 'Owner',
  leadCompany: 'Example Co',
  leadEmail: 'pat@example.com',
  leadPhone: PHONE,
  enrichmentReceipt: { phoneLabel: 'mobile' },
  leadLinkedinUrl: 'https://www.linkedin.com/in/pat-prospect',
  leadWebsite: 'https://example.com',
  platform: 'smartlead',
  classification: 'INTERESTED',
  leadIcpVerdict: {
    status: 'qualified',
    confidence: 91,
    reason: 'independent shop',
    decision_maker: { status: 'yes', reason: 'matches buyer', title: 'Owner' },
  },
  lastOutboundMessage: 'Worth a quick look at the offer?',
  inboundMessage: 'Yes, send times.',
  draft: 'Hey Pat, Tuesday or Thursday works.',
  ccEmails: 'ops@northwind.example',
  threadMessages: [
    { role: 'us', body: 'Worth a quick look at the offer?' },
    { role: 'them', body: 'Yes, send times.' },
  ],
};

test('the cold email plus their first reply is still the first card', () => {
  assert.equal(isBackAndForthThread(FIRST.threadMessages), false);
  assert.equal(isBackAndForthThread([]), false);
  assert.equal(isBackAndForthThread(undefined), false);
  assert.equal(isBackAndForthThread([
    { role: 'us', body: 'first' },
    { role: 'them', body: '(no new reply from prospect)' },
    { role: 'them', body: 'real reply' },
  ]), false);
});

test('the first interested reply card leads with campaign, contact, and scores', () => {
  const { blocks } = buildDraftApprovalCard(FIRST);
  const text = flat(blocks);
  const campAt = text.indexOf('Intro owners');
  const phoneAt = text.indexOf(PHONE);
  const emailAt = text.indexOf('pat@example.com');
  const liAt = text.indexOf('linkedin.com/in/pat-prospect');
  const siteAt = text.indexOf('<https://example.com|');
  const icpAt = text.indexOf('Fit — independent shop');
  const dmAt = text.indexOf('Decision maker: Yes');
  const youAt = text.indexOf('You said');
  const theyAt = text.indexOf('They replied');
  const draftAt = text.indexOf('Suggested reply');
  assert.equal(blocks.find((b) => b.type === 'header'), undefined, 'no client-name header');
  assert.doesNotMatch(text, /Northwind/);
  assert.ok(campAt === 0 || campAt < phoneAt, 'campaign is above the phone');
  assert.ok(phoneAt < emailAt && emailAt < liAt && liAt < siteAt);
  assert.match(text, /_\(mobile\)_/);
  assert.ok(siteAt < icpAt && icpAt < dmAt, 'scores sit under the contact line');
  assert.ok(dmAt < youAt && youAt < theyAt && theyAt < draftAt);
  assert.equal(text.split(PHONE).length - 1, 1, 'the phone is not repeated');
  assert.equal(text.split('pat@example.com').length - 1, 1, 'the email is not repeated');
  assert.equal((text.match(/🎯/g) || []).length, 1, 'ICP is not repeated');
  assert.match(text, /SMARTLEAD · INTERESTED/);
  const ids = actionIds(blocks);
  assert.deepEqual(ids, [
    'approve_reply',
    'open_edit_modal',
    'reject_reply',
    'dq_prospect',
    'meeting_booked',
    'approve_reply_cc_client',
  ]);
  assert.ok(!ids.includes('view_thread'));
  assert.ok(blocks.findIndex((b) => b.type === 'actions') > text.length || blocks.at(-1).type === 'actions');
  assert.equal(blocks.at(-1).type, 'actions');
  for (const value of actionValues(blocks)) assert.equal(value, REPLY_ID);
});

test('a later reply in the thread shows only the last exchange, the draft, and the full thread', () => {
  const threadMessages = [
    { role: 'us', body: 'Worth a quick look at the offer?' },
    { role: 'them', body: 'Yes, send times.' },
    { role: 'us', body: 'Our last note.' },
    { role: 'them', body: 'His last note.' },
  ];
  assert.equal(isBackAndForthThread(threadMessages), true);
  const { blocks } = buildDraftApprovalCard({
    ...FIRST,
    lastOutboundMessage: 'Our last note.',
    inboundMessage: 'His last note.',
    draft: 'Hey Pat, Thursday at 2 still works.',
    threadMessages,
    ccEmails: null,
  });
  const text = flat(blocks);
  assert.match(text, /You said/);
  assert.match(text, /Our last note/);
  assert.match(text, /They replied/);
  assert.match(text, /His last note/);
  assert.match(text, /Suggested reply/);
  assert.match(text, /Thursday at 2 still works/);
  assert.doesNotMatch(text, /Northwind/);
  assert.doesNotMatch(text, /Intro owners/);
  assert.doesNotMatch(text, /15555550123/);
  assert.doesNotMatch(text, /pat@example.com/);
  assert.doesNotMatch(text, /Fit — independent shop/);
  assert.doesNotMatch(text, /Worth a quick look/);
  assert.doesNotMatch(text, /Yes, send times/);
  const ids = actionIds(blocks);
  assert.ok(ids.includes('approve_reply'));
  assert.ok(ids.includes('open_edit_modal'));
  assert.ok(ids.includes('reject_reply'));
  assert.ok(ids.includes('dq_prospect'));
  assert.ok(ids.includes('meeting_booked'));
  assert.ok(ids.includes('view_thread'));
  assert.equal(blocks.at(-1).type, 'actions');
  const view = blocks.flatMap((b) => b.elements || []).find((e) => e.action_id === 'view_thread');
  assert.equal(view.value, REPLY_ID);

  const modal = buildThreadModalView({
    replyId: REPLY_ID,
    clientName: CLIENT,
    campaignDisplay: CAMPAIGN,
    leadName: 'Pat Prospect',
    leadEmail: 'pat@example.com',
    leadPhone: PHONE,
    enrichmentReceipt: { phoneLabel: 'mobile' },
    leadLinkedinUrl: 'https://www.linkedin.com/in/pat-prospect',
    leadWebsite: 'https://example.com',
    leadIcpVerdict: FIRST.leadIcpVerdict,
    threadMessages,
  });
  assert.equal(modal.callback_id, 'card_thread_modal');
  assert.equal(modal.title.text, 'Full thread');
  const modalText = flat(modal.blocks);
  assert.match(modalText, /Northwind/);
  assert.match(modalText, /Intro owners/);
  assert.match(modalText, new RegExp(PHONE.replace('+', '\\+')));
  assert.match(modalText, /_\(mobile\)_/);
  assert.match(modalText, /Fit — independent shop/);
  assert.match(modalText, /Decision maker: Yes/);
  assert.match(modalText, /Worth a quick look/);
  assert.match(modalText, /Yes, send times/);
  assert.match(modalText, /Our last note/);
  assert.match(modalText, /His last note/);
  assert.equal(JSON.parse(modal.private_metadata).replyId, REPLY_ID);
});

test('a second message from them is a back-and-forth even before we answer again', () => {
  const threadMessages = [
    { role: 'us', body: 'Opening note.' },
    { role: 'them', body: 'First reply.' },
    { role: 'them', body: 'Second reply.' },
  ];
  assert.equal(isBackAndForthThread(threadMessages), true);
  const { blocks } = buildDraftApprovalCard({
    ...FIRST,
    ccEmails: null,
    lastOutboundMessage: 'Opening note.',
    inboundMessage: 'Second reply.',
    threadMessages,
  });
  assert.ok(actionIds(blocks).includes('view_thread'));
  assert.doesNotMatch(flat(blocks), /Northwind/);
});

test('posted cards keep the old Approve, Reject, DQ, and Meeting booked action ids', () => {
  const block = draftApprovalActionsBlock(REPLY_ID);
  assert.deepEqual(block.elements.map((e) => e.action_id), [
    'approve_reply',
    'open_edit_modal',
    'reject_reply',
    'dq_prospect',
    'meeting_booked',
  ]);
  for (const el of block.elements) assert.equal(el.value, REPLY_ID);
  assert.doesNotMatch(JSON.stringify(block), /meeting_booked:|dq_prospect:/);

  const route = read('src/routes/slack.js');
  const slack = read('src/services/slack.js');
  for (const id of [
    'approve_reply',
    'approve_reply_cc_client',
    'approve_reply_cc_referral',
    'open_edit_modal',
    'reject_reply',
    'dq_prospect',
    'meeting_booked',
  ]) {
    assert.match(route, new RegExp(`action\\.action_id === '${id}'`));
  }
  assert.ok(route.indexOf("action.action_id === 'view_thread'") < route.indexOf('noticeIfClosed(action'));
  assert.match(route, /openThreadModal/);
  assert.match(slack, /action_id: 'view_thread'/);
  assert.doesNotMatch(slack, /meeting_booked:\$\{/);
});

test('a phone is labeled mobile only when the line type is confirmed mobile', () => {
  const confirmed = flat(buildDraftApprovalCard(FIRST).blocks);
  assert.match(confirmed, /_\(mobile\)_/);

  const sourcePhone = flat(buildDraftApprovalCard({
    ...FIRST,
    enrichmentReceipt: null,
    ccEmails: null,
  }).blocks);
  assert.match(sourcePhone, new RegExp(PHONE.replace('+', '\\+')));
  assert.doesNotMatch(sourcePhone, /_\(mobile\)_/);
  assert.doesNotMatch(sourcePhone, /not a confirmed mobile/);

  const landline = flat(buildDraftApprovalCard({
    ...FIRST,
    leadPhone: null,
    leadPhoneAlt: '+15555550199',
    enrichmentReceipt: { phoneLabel: 'landline' },
    ccEmails: null,
  }).blocks);
  assert.match(landline, /15555550199/);
  assert.doesNotMatch(landline, /_\(mobile\)_|_\(landline\)_|not a confirmed mobile/);

  const { leadFieldText } = require('../src/services/slack');
  const alt = leadFieldText({
    leadName: 'Pat',
    leadPhoneAlt: '+15555550199',
    enrichmentReceipt: { phoneLabel: 'voip' },
  });
  assert.match(alt, /15555550199/);
  assert.doesNotMatch(alt, /_\(|not a confirmed mobile|VoIP|voip/);
});

test('follow-up cards keep their own layout', () => {
  const { blocks } = buildDraftApprovalCard({
    replyId: REPLY_ID,
    leadName: 'Pat Prospect',
    platform: 'smartlead',
    classification: 'FOLLOW_UP',
    draft: 'Hey Pat, circling back.',
    inboundMessage: 'Still looking.',
    clientName: CLIENT,
    campaignDisplay: CAMPAIGN,
    threadMessages: [
      { role: 'us', body: 'First' },
      { role: 'them', body: 'Reply' },
      { role: 'us', body: 'Second' },
      { role: 'them', body: 'Still looking.' },
    ],
  });
  const text = flat(blocks);
  assert.match(text, /WILL SEND/);
  assert.match(text, /Pat Prospect/);
  assert.ok(!actionIds(blocks).includes('view_thread'));
  assert.equal(blocks[0].type, 'header');
});
