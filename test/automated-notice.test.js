const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { promoteReferral, automatedNoticeResult } = require('../src/routes/webhooks');
const { classifyFromSmartlead, applySmartleadCategory } = require('../src/services/smartlead-category');
const { applyInboundCategory } = require('../src/services/smartlead-inbound');
const { classifyDuringOutage } = require('../src/utils/classifier-outage');
const { DRAFT_CLASSIFICATIONS } = require('../src/services/classifier');
const { slackChannelSuppressionReason, shouldPostToSlackChannel } = require('../src/utils/slack-channel-policy');
const { shouldAlertOther } = require('../src/services/other-alert');
const slack = require('../src/services/slack');
const { applyPositiveIntentGuard } = require('../src/utils/positive-intent');
const {
  looksLikeAutomatedNotice,
  looksLikeWrongPerson,
  slackSuppressionReason,
  humanTextForClassification,
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

// Kayla Debiec, kdebiec@embracepetinsurance.com, Parlay campaign 4161772,
// Oct 27 2026 10:26 AM ET. The whole reply was this disclaimer plus the
// Mimecast footer. "copying" in the legal triplet was read as a referral,
// so Jev's OTHER was rewritten to INTERESTED and an approval card posted.
const KAYLA_DISCLAIMER = [
  'Disclaimer',
  'The information contained in this communication from the sender is confidential. It is intended solely for use by the recipient and others authorized to receive it. If you are not the recipient, you are hereby notified that any disclosure, copying, distribution or taking action in relation of the contents of this information is strictly prohibited and may be unlawful.',
  '',
  'This email has been scanned for viruses and malware, and may have been automatically archived by Mimecast, a leader in email security and cyber resilience. Mimecast integrates email defenses with brand protection, security awareness training, web security, compliance and other essential capabilities. Mimecast helps protect large and small organizations from malicious activity, human error and technology failure; and to lead the movement toward building a more resilient world. To find out more, visit our website.',
].join('\n');

const KAYLA_HUMAN = 'Yes, I want the Cavaliers tickets. What times work next week?';

describe('disclaimer and scanner footers are automated notices', () => {
  it('Kayla disclaimer + Mimecast only does not get an approval card or a draft', () => {
    notDrafted(KAYLA_DISCLAIMER);
    notDrafted(KAYLA_DISCLAIMER.replace(/\s+/g, ' '));
    const html = `<html><body><p>${KAYLA_DISCLAIMER.replace(/\n\n/g, '</p><p>').replace(/\n/g, ' ')}</p></body></html>`;
    notDrafted(html);
    assert.equal(humanTextForClassification(KAYLA_DISCLAIMER), '');
    assert.equal(automatedNoticeResult(KAYLA_DISCLAIMER).classification, 'AUTOMATED_NOTICE');
    assert.equal(automatedNoticeResult(KAYLA_DISCLAIMER).draft, '');
    assert.equal(shouldPostToSlackChannel({
      classification: 'INTERESTED',
      inboundMessage: KAYLA_DISCLAIMER,
    }), false);
    assert.equal(shouldPostToSlackChannel({
      classification: 'AUTOMATED_NOTICE',
      inboundMessage: KAYLA_DISCLAIMER,
    }), false);
    assert.equal(shouldAlertOther('automated_notice', 'AUTOMATED_NOTICE'), false);
    const sl = applySmartleadCategory({
      slCategory: classifyFromSmartlead({ category: 1 }),
      classification: 'OTHER',
      inboundMessage: KAYLA_DISCLAIMER,
      reasoning: 'Classified as OTHER; no draft (jev).',
    });
    assert.equal(sl.classification, 'AUTOMATED_NOTICE');
    assert.equal(sl.source, 'automated_notice');
  });

  it('a signature plus the same footer is still an automated notice', () => {
    const body = [
      'Kayla Debiec',
      'Senior UX/UI Designer',
      'kdebiec@embracepetinsurance.com',
      '216-555-0199',
      '',
      KAYLA_DISCLAIMER,
    ].join('\n');
    notDrafted(body);
  });

  it('human text plus the same footer is classified on the human text and the card keeps the full email', () => {
    const full = `${KAYLA_HUMAN}\n\n${KAYLA_DISCLAIMER}`;
    assert.equal(looksLikeAutomatedNotice(full), false);
    assert.equal(slackSuppressionReason(full), null);
    assert.equal(humanTextForClassification(full), KAYLA_HUMAN);
    assert.equal(looksLikeReferral(full), false);
    assert.equal(promoteReferral('OTHER', full).promoted, false);
    const guard = applyPositiveIntentGuard('OTHER', full);
    assert.equal(guard.classification, 'INTERESTED');
    assert.equal(shouldPostToSlackChannel({
      classification: 'INTERESTED',
      inboundMessage: full,
    }), true);

    const { blocks } = slack.buildDraftApprovalCard({
      replyId: 'kayla-human',
      leadName: 'Kayla Debiec',
      leadEmail: 'kdebiec@embracepetinsurance.com',
      platform: 'smartlead',
      classification: 'INTERESTED',
      draft: 'Hi Kayla, glad the tickets are of interest.',
      reasoning: 'Classified as INTERESTED (jev).',
      inboundMessage: full,
      campaignDisplay: 'Parlay FinServ IT SEG Tickets (4161772)',
    });
    const shown = JSON.stringify(blocks);
    assert.match(shown, /SMARTLEAD · INTERESTED/);
    assert.match(shown, /Yes, I want the Cavaliers tickets/);
    assert.match(shown, /What times work next week/);
    assert.match(shown, /disclosure, copying, distribution/);
    assert.match(shown, /scanned for viruses and malware/);
    // Josh, Oct 29 2026: the card shows about 600 chars of their reply, human text first.
    assert.doesNotMatch(shown, /_\(truncated\)_/);
    assert.equal(shown.includes(KAYLA_HUMAN), true);
  });

  it('a short human reply is not dropped because a disclaimer footer is attached', () => {
    for (const line of ['OK', 'Thanks!', 'Sounds good']) {
      const full = `${line}\n\n${KAYLA_DISCLAIMER}`;
      assert.equal(looksLikeAutomatedNotice(full), false, line);
      assert.match(humanTextForClassification(full), new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(shouldPostToSlackChannel({
        classification: 'INTERESTED',
        inboundMessage: full,
      }), true, line);
    }
    assert.equal(looksLikeAutomatedNotice('Can you send the confidentiality agreement before we talk?'), false);
    assert.match(
      humanTextForClassification('Can you send the confidentiality agreement before we talk?'),
      /confidentiality agreement/,
    );
  });

  it('OTHER is not promoted to INTERESTED when the only "copying" is the disclaimer', () => {
    assert.match(KAYLA_DISCLAIMER, /\bcopying\b/);
    assert.equal(looksLikeReferral(KAYLA_DISCLAIMER), false);
    assert.equal(looksLikeReferral('any disclosure, copying, distribution or taking action'), false);
    const ref = promoteReferral('OTHER', KAYLA_DISCLAIMER);
    assert.equal(ref.promoted, false);
    assert.equal(ref.classification, 'OTHER');
    const jev = 'Classified as OTHER; no draft (jev).';
    const footer = ref.promoted
      ? `Referral reply (prospect looped in a colleague); drafted reply-all. ${jev}`
      : jev;
    assert.equal(footer, jev);
    assert.doesNotMatch(footer, /Referral reply/);
    assert.doesNotMatch(footer, /INTERESTED/);
    assert.equal(promoteReferral('OTHER', `${KAYLA_HUMAN}\n\n${KAYLA_DISCLAIMER}`).promoted, false);

    const live = "I've cc'd our ops manager, he can help.";
    const withFooter = `${live}\n\n${KAYLA_DISCLAIMER}`;
    assert.equal(looksLikeAutomatedNotice(withFooter), false);
    assert.equal(looksLikeReferral(withFooter), true);
    assert.equal(promoteReferral('OTHER', withFooter).classification, 'INTERESTED');
    assert.equal(humanTextForClassification(withFooter), live);
  });

  it('a later SmartLead Interested category does not relabel a disclaimer-only row', async () => {
    let queried = false;
    let patched = false;
    const existing = {
      id: 'kayla-row',
      classification: 'OTHER',
      inbound_message: KAYLA_DISCLAIMER,
      slack_message_ts: '1793111168.530229',
      status: 'suppressed',
    };
    const out = await applyInboundCategory(
      existing,
      { event_type: 'LEAD_CATEGORY_UPDATED', lead_category: { new_name: 'Interested' } },
      { query: async () => { queried = true; return { rows: [] }; } },
      async () => { patched = true; },
    );
    assert.equal(out.classification, 'OTHER');
    assert.equal(queried, false);
    assert.equal(patched, false);
  });

  it('covers other security-gateway footers when they are the whole reply', () => {
    notDrafted('This message was scanned by Proofpoint and found clean.');
    notDrafted('This email has been scanned by Barracuda Networks email security.');
    notDrafted([
      "You don't often get email from kdebiec@embracepetinsurance.com. Learn why this is important.",
      'CAUTION: This email originated from outside of the organization. Do not click links or open attachments unless you recognize the sender and know the content is safe.',
    ].join('\n'));
    const human = `Yes, send the tickets.\n\nCAUTION: This email originated from outside of the organization. Do not click links or open attachments unless you recognize the sender and know the content is safe.`;
    assert.equal(looksLikeAutomatedNotice(human), false);
    assert.equal(humanTextForClassification(human), 'Yes, send the tickets.');
  });

  it('the drafter still receives the full email when a footer is attached', () => {
    const src = read('src/services/classifier.js');
    const start = src.indexOf('async function classifyAndDraft');
    const fn = src.slice(start);
    assert.match(fn, /humanTextForClassification\(inboundMessage\)/);
    assert.match(fn, /await classifyReply\(threadContext, forModel\)/);
    const draftCall = fn.slice(fn.indexOf('await draftOnly('), fn.indexOf('await draftOnly(') + 400);
    assert.match(draftCall, /inboundMessage,/);
    assert.doesNotMatch(draftCall, /forModel/);
  });
});
