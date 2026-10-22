const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { promoteReferral, automatedNoticeResult } = require('../src/routes/webhooks');
const { classifyFromSmartlead, applySmartleadCategory } = require('../src/services/smartlead-category');
const { classifyDuringOutage } = require('../src/utils/classifier-outage');
const { DRAFT_CLASSIFICATIONS } = require('../src/services/classifier');
const { slackChannelSuppressionReason } = require('../src/utils/slack-channel-policy');
const {
  looksLikeAutomatedNotice,
  looksLikeWrongPerson,
  slackSuppressionReason,
} = require('../src/utils/smartlead-webhook-helpers');
const { looksLikeReferral } = require('../src/utils/reply-all');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const FRANK = 'We have moved to a new server, please use the new email... Please contact our office';
const LINDSEY = 'No longer with Encore... please reach out to Jay Baskowski';
const HARRY = 'No longer employed... reach out directly to me at aedwards@...';
const GENUINE = "I'm not the right person, but talk to my colleague Jay, he handles this";

const OUTBOUND_THREAD = {
  history: [
    { type: 'SENT', email_body: 'Can I send the video over?' },
  ],
};

function notDrafted(body) {
  const label = classifyDuringOutage(OUTBOUND_THREAD, body);
  assert.equal(label, 'AUTOMATED_NOTICE', body);
  assert.equal(DRAFT_CLASSIFICATIONS.includes(label), false);
  assert.equal(looksLikeAutomatedNotice(body), true);
  assert.equal(slackSuppressionReason(body), 'automated_notice');
  assert.equal(
    slackChannelSuppressionReason({ classification: 'INTERESTED', inboundMessage: body }),
    'automated_notice',
  );
  assert.equal(
    slackChannelSuppressionReason({ classification: 'AUTOMATED_NOTICE', inboundMessage: body }),
    'automated_notice',
  );
  assert.equal(promoteReferral('OTHER', body).promoted, false);
  assert.equal(promoteReferral('NOT_INTERESTED', body).promoted, false);
  assert.equal(promoteReferral('WRONG_PERSON', body).promoted, false);
  assert.equal(promoteReferral('INTERESTED', body).promoted, false);
}

describe('automated notices are not interested drafts', () => {
  it('Frank Madrigal server move (SmartLead category 3) is suppressed before the category', () => {
    notDrafted(FRANK);
    assert.equal(looksLikeReferral(FRANK), false);
    const sl = classifyFromSmartlead({ category: 3 });
    assert.equal(sl.classification, 'NOT_INTERESTED');
    const gated = automatedNoticeResult(FRANK);
    assert.equal(gated.classification, 'AUTOMATED_NOTICE');
    assert.equal(gated.source, 'automated_notice');
    const applied = applySmartleadCategory({
      slCategory: sl,
      classification: 'NOT_INTERESTED',
      inboundMessage: FRANK,
    });
    assert.equal(applied.classification, 'AUTOMATED_NOTICE');
    assert.equal(applied.source, 'automated_notice');
    const interested = applySmartleadCategory({
      slCategory: classifyFromSmartlead({ category: 1 }),
      classification: 'INTERESTED',
      inboundMessage: FRANK,
    });
    assert.equal(interested.classification, 'AUTOMATED_NOTICE');
  });

  it('Lindsey Lukas departure handoff is suppressed', () => {
    notDrafted(LINDSEY);
    assert.equal(looksLikeReferral(LINDSEY), true);
  });

  it('Harry Buchman departure handoff is suppressed', () => {
    notDrafted(HARRY);
  });

  it('covers the other automated-notice phrases', () => {
    for (const body of [
      'This mailbox is no longer monitored.',
      'This is an automated message. Please do not reply.',
      'We have received your request and opened ticket #4412.',
      'Your ticket #4412 was created.',
    ]) {
      notDrafted(body);
    }
  });

  it('a genuine referral from someone still in the seat still promotes', () => {
    assert.equal(looksLikeAutomatedNotice(GENUINE), false);
    assert.equal(looksLikeWrongPerson(GENUINE), false);
    assert.equal(slackSuppressionReason(GENUINE), null);
    assert.equal(looksLikeReferral(GENUINE), true);
    const promoted = promoteReferral('OTHER', GENUINE);
    assert.equal(promoted.promoted, true);
    assert.equal(promoted.classification, 'INTERESTED');
    assert.equal(
      slackChannelSuppressionReason({ classification: 'INTERESTED', inboundMessage: GENUINE }),
      null,
    );
    assert.equal(promoteReferral('WRONG_PERSON', GENUINE).promoted, false);
    assert.equal(promoteReferral('NOT_INTERESTED', GENUINE).promoted, false);
    assert.equal(looksLikeWrongPerson('I am not the right person'), true);
    assert.equal(slackSuppressionReason('I am not the right person'), 'wrong_person');
  });

  it('runs before SmartLead category, referral promotion, and the outage fallback', () => {
    const webhooks = read('src/routes/webhooks.js');
    const gate = webhooks.indexOf('automatedNoticeResult(inboundEffective)');
    const category = webhooks.indexOf('else if (slCategory)');
    const referral = webhooks.indexOf('promoteReferral(classification, inboundEffective)');
    assert.ok(gate !== -1 && gate < category && category < referral);
    assert.doesNotMatch(webhooks, /referralPromoted && suppressedReason === 'wrong_person'/);

    const outage = read('src/utils/classifier-outage.js');
    const fn = outage.slice(outage.indexOf('function classifyDuringOutage'), outage.indexOf('module.exports'));
    assert.ok(fn.indexOf('looksLikeAutomatedNotice') < fn.indexOf('looksLikeOutOfOffice'));
    assert.ok(fn.indexOf('looksLikeAutomatedNotice') < fn.indexOf("return 'INTERESTED'"));

    const classifier = read('src/services/classifier.js');
    const preStart = classifier.indexOf('Deterministic pre-classification');
    const pre = classifier.slice(preStart, classifier.indexOf('await classifyReply(', preStart));
    assert.ok(pre.indexOf('looksLikeAutomatedNotice') !== -1);
    assert.ok(pre.indexOf('looksLikeAutomatedNotice') < pre.indexOf('looksLikeOutOfOffice'));
  });
});
