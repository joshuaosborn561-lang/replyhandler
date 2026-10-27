const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  looksLikeBounceNotice,
  looksLikeAutomatedNotice,
  slackSuppressionReason,
} = require('../src/utils/smartlead-webhook-helpers');
const {
  slackChannelSuppressionReason,
  shouldPostToSlackChannel,
} = require('../src/utils/slack-channel-policy');
const { shouldAlertOther, postOtherAlert } = require('../src/services/other-alert');
const { classifyOtherSecondOpinion } = require('../src/services/classifier');
const db = require('../src/db');
const { recordSuppressedReply } = require('../src/services/suppressed-replies');

// Josh, Oct 27 2026: only a real INTERESTED reply or a real QUESTION reaches a
// client channel. Bounces, "Message blocked" notices, auto-replies, OTHER and
// "Unclassified" lines are recorded as suppressed rows and never posted.
const MESSAGE_BLOCKED = '** Message blocked ** Your message to someone@example-co.test has been blocked. '
  + 'See technical details below for more information. Learn more here: https://aka.ms/EXOSmtpErrors '
  + 'The response from the remote server was: 550 5.7.1 Service unavailable, Client host blocked';

const BOUNCES = [
  MESSAGE_BLOCKED,
  'Mail Delivery Subsystem <mailer-daemon@googlemail.com>\nDelivery Status Notification (Failure)\nAddress not found',
  'Undeliverable: Quick question\nYour message to pat@example-co.test could not be delivered because the recipient mailbox is full.',
  'postmaster@example-co.test: Delivery has failed to these recipients or groups.',
  'Your message wasn\'t delivered to pat@example-co.test because the address couldn\'t be found.',
  '550 5.1.1 <pat@example-co.test>: Recipient address rejected: User unknown in virtual mailbox table',
];

const REAL_REPLIES = [
  'Yes, send me more info. Is this blocked off for the whole season?',
  'Sounds interesting. Can you call me tomorrow afternoon?',
  'How much does it cost?',
  'Tuesday at 2pm works for me, please send an invite.',
  'Thanks, but my spam filter blocked your first message. What is this about?',
];

describe('bounces and "Message blocked" notices are never a person', () => {
  for (const body of BOUNCES) {
    it(body.slice(0, 50), () => {
      assert.equal(looksLikeBounceNotice(body), true);
      assert.equal(looksLikeAutomatedNotice(body), true);
      assert.equal(slackSuppressionReason(body), 'bounce');
      // Whatever label the classifier or SmartLead gave it.
      for (const c of ['INTERESTED', 'QUESTION', 'MEETING_PROPOSED', 'OTHER', 'AUTOMATED_NOTICE']) {
        assert.equal(slackChannelSuppressionReason({ classification: c, inboundMessage: body }), 'bounce', c);
        assert.equal(shouldPostToSlackChannel({ classification: c, inboundMessage: body }), false, c);
      }
    });
  }

  for (const body of REAL_REPLIES) {
    it(`a real reply is not a bounce: ${body.slice(0, 40)}`, () => {
      assert.equal(looksLikeBounceNotice(body), false);
      assert.equal(slackChannelSuppressionReason({ classification: 'INTERESTED', inboundMessage: body }), null);
    });
  }
});

describe('what posts and what stays out of the client channel', () => {
  const body = 'Sounds good, tell me more.';
  it('posts only INTERESTED, QUESTION and MEETING_PROPOSED', () => {
    for (const c of ['INTERESTED', 'QUESTION', 'MEETING_PROPOSED']) {
      assert.equal(slackChannelSuppressionReason({ classification: c, inboundMessage: body }), null, c);
    }
  });

  it('suppresses everything else with a reason', () => {
    const expected = {
      OTHER: 'not_interested_channel',
      OBJECTION: 'not_interested_channel',
      NOT_INTERESTED: 'not_interested',
      REMOVE_ME: 'unsubscribe',
      OOO: 'ooo',
      AUTOMATED_NOTICE: 'automated_notice',
      WRONG_PERSON: 'wrong_person',
    };
    for (const [c, reason] of Object.entries(expected)) {
      assert.equal(slackChannelSuppressionReason({ classification: c, inboundMessage: body }), reason, c);
    }
  });

  it('never posts an "Unclassified reply" alert for OTHER', () => {
    assert.equal(shouldAlertOther('not_interested_channel', 'OTHER'), false);
    assert.equal(shouldAlertOther('not_interested_channel', undefined), false);
    assert.equal(shouldAlertOther('bounce', 'OTHER'), false);
  });

  it('live paths do not call postOtherAlert unless shouldAlertOther allows it', () => {
    for (const f of ['src/routes/webhooks.js', 'src/services/suppressed-replies.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const calls = src.match(/postOtherAlert\(/g) || [];
      const gated = src.match(/if \(shouldAlertOther\(/g) || [];
      assert.equal(calls.length, gated.length, f);
    }
  });
});

describe('a suppressed reply is recorded in the DB and never posted', () => {
  const realQuery = db.query;
  afterEach(() => { db.query = realQuery; });

  it('records the row with its suppression reason and posts nothing', async () => {
    const calls = [];
    db.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
    const origLog = console.log; console.log = () => {};
    try {
      await recordSuppressedReply({
        clientId: 'c1', platform: 'smartlead', campaignId: 1, leadId: 2, leadName: 'Pat Example',
        leadEmail: 'pat@example-co.test', inboundMessage: MESSAGE_BLOCKED,
        classification: 'OTHER', reason: 'bounce',
      });
    } finally { console.log = origLog; }
    // One INSERT and nothing else: no clients lookup, no Slack token fetch.
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO pending_replies/);
    assert.match(calls[0].sql, /'suppressed'/);
    assert.ok(calls[0].params.includes('bounce'));
  });

  it('OTHER is recorded with its reason and also posts nothing', async () => {
    const calls = [];
    db.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
    const origLog = console.log; console.log = () => {};
    try {
      await recordSuppressedReply({
        clientId: 'c1', platform: 'smartlead', campaignId: 1, leadId: 2, leadName: 'Pat Example',
        inboundMessage: 'ok', classification: 'OTHER', reason: 'not_interested_channel',
      });
    } finally { console.log = origLog; }
    assert.equal(calls.length, 1);
    assert.ok(calls[0].params.includes('not_interested_channel'));
  });

  it('postOtherAlert is no longer wired to any suppression path', async () => {
    assert.equal(typeof postOtherAlert, 'function');
  });
});

describe('Sonnet second opinion on an OTHER label', () => {
  function fakeFetch(answer, ok = true) {
    const seen = [];
    const f = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return { ok, status: ok ? 200 : 500, json: async () => ({ content: [{ type: 'text', text: answer }] }) };
    };
    f.seen = seen;
    return f;
  }
  const quiet = (fn) => async (...a) => {
    const e = console.error; console.error = () => {};
    try { return await fn(...a); } finally { console.error = e; }
  };

  it('upgrades a real interest or question, and asks Sonnet to default to JUNK', async () => {
    for (const word of ['INTERESTED', 'QUESTION', 'MEETING_PROPOSED']) {
      const f = fakeFetch(word);
      assert.equal(await classifyOtherSecondOpinion([], 'Can you send pricing?', { fetch: f }), word);
      assert.match(f.seen[0].body.system, /When unsure, answer JUNK/);
      assert.match(f.seen[0].body.model, /sonnet/i);
    }
  });

  it('keeps junk as OTHER (suppressed)', async () => {
    for (const word of ['JUNK', 'OTHER', 'NOT_INTERESTED', '', 'gibberish']) {
      assert.equal(await classifyOtherSecondOpinion([], 'x', { fetch: fakeFetch(word) }), null, word);
    }
  });

  it('stays OTHER when Anthropic errors', quiet(async () => {
    assert.equal(await classifyOtherSecondOpinion([], 'x', { fetch: fakeFetch('INTERESTED', false) }), null);
    const boom = async () => { throw new Error('network'); };
    assert.equal(await classifyOtherSecondOpinion([], 'x', { fetch: boom }), null);
  }));

  it('is wired into classifyAndDraft for OTHER only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/classifier.js'), 'utf8');
    assert.match(src, /if \(classification === 'OTHER'\) \{\s*const second = await classifyOtherSecondOpinion/);
  });
});
