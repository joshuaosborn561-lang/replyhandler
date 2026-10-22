const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  smartleadCategoryResult, promoteReferral, SMARTLEAD_DRAFT_ALWAYS,
} = require('../src/routes/webhooks');
const { classifyFromSmartlead } = require('../src/services/smartlead-category');
const { looksLikeReferral, buildReplyAll } = require('../src/utils/reply-all');
const slack = require('../src/services/slack');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('SmartLead category is the source of truth', () => {
  const cases = [
    [{ category: 1 }, 'INTERESTED'],
    [{ category: 2 }, 'MEETING_PROPOSED'],
    [{ lead_category: 'Information Request' }, 'QUESTION'],
    [{ category: 6 }, 'OOO'],
    [{ category: 3 }, 'NOT_INTERESTED'],
    [{ category: 4 }, 'REMOVE_ME'],
  ];
  for (const [payload, want] of cases) {
    it(`maps ${JSON.stringify(payload)} to ${want} without an LLM call`, () => {
      const r = smartleadCategoryResult(classifyFromSmartlead(payload), 'Thanks for reaching out.');
      assert.equal(r.classification, want);
      assert.equal(r.source, 'smartlead_category');
    });
  }

  it('webhook only calls classifyAndDraft when SmartLead gave no category', () => {
    const src = read('src/routes/webhooks.js');
    assert.match(src, /if \(slCategory\) \{\s*result = smartleadCategoryResult/);
  });

  it('positive categories are always drafted', () => {
    for (const c of ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION']) assert.ok(SMARTLEAD_DRAFT_ALWAYS.has(c));
  });
});

describe('referrals', () => {
  it('detects common referral phrasing', () => {
    assert.ok(looksLikeReferral("I've cc'd our maintenance manager, he can help."));
    assert.ok(looksLikeReferral('You should talk to Pat about this.'));
    assert.ok(looksLikeReferral('Our facilities lead handles this, copying him here.'));
    assert.ok(!looksLikeReferral('Sounds good, what times work?'));
  });

  it('promotes a live referral and leaves declines and wrong-person labels alone', () => {
    assert.equal(promoteReferral('OTHER', "I've CC'd our ops manager").classification, 'INTERESTED');
    assert.equal(promoteReferral('WRONG_PERSON', 'Please talk to Sam instead').promoted, false);
    assert.equal(promoteReferral('NOT_INTERESTED', "I've CC'd our ops manager").promoted, false);
    assert.equal(promoteReferral('REMOVE_ME', "I've cc'd legal, stop emailing").promoted, false);
    assert.equal(promoteReferral('QUESTION', "I've cc'd X").promoted, false);
    assert.equal(promoteReferral('OTHER', 'I am out of the office until Monday. I\'ve cc\'d our ops manager').promoted, false);
  });

  it('reply-all keeps people on the To line', () => {
    const r = buildReplyAll({
      history: { history: [
        { type: 'SENT', from: 'rep@ourco.com', to: 'lead@prospect.com', time: '1' },
        { type: 'REPLY', from: 'lead@prospect.com', to: 'rep@ourco.com, mgr@prospect.com', cc: 'ops@prospect.com', time: '2' },
      ] },
      originalLeadEmail: 'lead@prospect.com',
    });
    assert.equal(r.recipient, 'lead@prospect.com');
    assert.deepEqual(r.cc.sort(), ['mgr@prospect.com', 'ops@prospect.com']);
  });
});

describe('card CC line', () => {
  it('counts extra To/CC addresses instead of saying no CC', () => {
    const { blocks } = slack.buildDraftApprovalCard({
      replyId: 'r1', leadName: 'Lead', platform: 'smartlead', classification: 'INTERESTED',
      draft: 'Hi', inboundMessage: 'cc my manager', replyAllCc: ['mgr@prospect.com', 'ops@prospect.com'],
    });
    const text = JSON.stringify(blocks);
    assert.match(text, /Reply-all: CC 2 other people/);
    assert.doesNotMatch(text, /has no CC/);
  });

  it('shows the Approve & Send + CC client button when Always-forward is set', () => {
    const { blocks } = slack.buildDraftApprovalCard({
      replyId: 'r1', leadName: 'Lead', platform: 'smartlead', classification: 'INTERESTED',
      draft: 'Hi', inboundMessage: 'yes', ccEmails: 'mmcantosh@emcor.net',
    });
    assert.match(JSON.stringify(blocks), /approve_reply_cc_client/);
    const { blocks: flagged } = slack.buildDraftApprovalCard({
      replyId: 'r1', leadName: 'Lead', platform: 'smartlead', classification: 'INTERESTED',
      draft: 'Hi', inboundMessage: 'yes', showCcClientButton: true,
    });
    assert.match(JSON.stringify(flagged), /approve_reply_cc_client/);
    const { blocks: plain } = slack.buildDraftApprovalCard({
      replyId: 'r1', leadName: 'Lead', platform: 'smartlead', classification: 'INTERESTED',
      draft: 'Hi', inboundMessage: 'yes',
    });
    assert.doesNotMatch(JSON.stringify(plain), /approve_reply_cc_client/);
  });
});

describe('/admin/post-approval-card', () => {
  it('accepts thread_ts and cc_client', () => {
    const src = read('src/routes/admin.js');
    assert.match(src, /thread_ts: threadTsRaw/);
    assert.match(src, /cc_client: ccClientRaw/);
    assert.match(src, /showCcClientButton: ccClient/);
    assert.match(read('src/services/slack-reply-post.js'), /explicitThreadTs \|\|/);
  });
});

describe('Slack approve click', () => {
  const src = read('src/routes/slack.js');
  it('acks before work, shows Sending..., and Already sent on a repeat click', () => {
    assert.ok(src.indexOf('res.status(200).send();') < src.indexOf("action.action_id === 'approve_reply'"));
    assert.match(src, /setCardStatus\(client\.slack_bot_token, interaction, '⏳ Sending\.\.\.'\)/);
    assert.match(src, /'✅ Already sent'/);
  });
  it('a failed notify copy does not fail the send', () => {
    const rs = read('src/services/reply-send.js');
    assert.match(rs, /catch \(notifyErr\)/);
    assert.match(rs, /clientNotifyError: clientNotifyError/);
    assert.match(src, /client notify copy failed/);
  });
});
