const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildReplyAll,
  firstNameFromSender,
  isAutoReplyAddress,
  mergeCcLists,
} = require('../src/utils/reply-all');

const ROOT = path.join(__dirname, '..');
const sendSrc = fs.readFileSync(path.join(ROOT, 'src/services/smartlead.js'), 'utf8');

describe('reply to the actual sender, reply-all', () => {
  it('sends to the colleague who replied and CCs the original lead', () => {
    const history = {
      history: [
        {
          type: 'SENT',
          from: 'ae@ourfirm.example',
          to: 'alex@lead.example',
          time: '2026-10-01T16:00:00.000Z',
          email_body: 'Intro',
        },
        {
          type: 'REPLY',
          from: 'Jordan Colleague <jordan@lead.example>',
          to: 'ae@ourfirm.example',
          cc: 'alex@lead.example',
          message_id: '<inbound-2@lead.example>',
          time: '2026-10-01T17:00:00.000Z',
          email_body: 'I handle this — looping Alex.',
        },
      ],
    };
    const result = buildReplyAll({
      history,
      accountEmails: ['ae@ourfirm.example', 'sdr@ourfirm.example'],
      originalLeadEmail: 'alex@lead.example',
      fallbackName: 'Alex Lead',
    });
    assert.equal(result.recipient, 'jordan@lead.example');
    assert.deepEqual(result.cc, ['alex@lead.example']);
    assert.equal(result.replyMessageId, '<inbound-2@lead.example>');
    assert.equal(result.senderFirstName, 'Jordan');
  });

  it('drops our mailboxes, our domains, duplicates, and auto-reply addresses', () => {
    const history = {
      history: [
        {
          type: 'SENT',
          from: 'ae@ourfirm.example',
          to: 'alex@lead.example',
          time: '2026-10-01T16:00:00.000Z',
        },
        {
          type: 'REPLY',
          from: 'alex@lead.example',
          to: 'ae@ourfirm.example, sdr@ourfirm.example',
          cc: 'noreply@lead.example, alex@lead.example, ops@ourfirm.example',
          time: '2026-10-01T17:00:00.000Z',
        },
      ],
    };
    const result = buildReplyAll({
      history,
      accountEmails: ['ae@ourfirm.example'],
      originalLeadEmail: 'alex@lead.example',
    });
    assert.equal(result.recipient, 'alex@lead.example');
    assert.ok(!result.cc.includes('ae@ourfirm.example'));
    assert.ok(!result.cc.includes('sdr@ourfirm.example'));
    assert.ok(!result.cc.includes('ops@ourfirm.example'));
    assert.ok(!result.cc.includes('noreply@lead.example'));
    assert.ok(!result.cc.includes('alex@lead.example'));
  });

  it('firstNameFromSender prefers the From display name', () => {
    assert.equal(firstNameFromSender({ fromName: 'Jordan Colleague', from: 'j@x.example' }), 'Jordan');
    assert.equal(isAutoReplyAddress('noreply@vendor.example'), true);
    assert.equal(isAutoReplyAddress('jordan@lead.example'), false);
  });

  it('merges loop-in client CC onto the reply-all list', () => {
    const merged = mergeCcLists(['alex@lead.example'], 'owner@client.example, alex@lead.example');
    assert.deepEqual(merged, ['alex@lead.example', 'owner@client.example']);
  });

  it('SmartLead sendReply uses to_email, not recipient', () => {
    assert.match(sendSrc, /payload\.to_email/);
    assert.match(sendSrc, /payload\.to_first_name/);
    assert.match(sendSrc, /payload\.reply_message_id/);
    assert.match(sendSrc, /payload\.reply_email_body/);
    assert.doesNotMatch(sendSrc, /payload\.recipient/);
  });

  it('passes the inbound body as reply_email_body so the quote matches the TO', () => {
    const history = {
      history: [
        {
          type: 'REPLY',
          from: 'Jordan Colleague <jordan@lead.example>',
          to: 'ae@ourfirm.example',
          cc: 'alex@lead.example',
          message_id: '<inbound-2@lead.example>',
          time: '2026-10-01T17:00:00.000Z',
          email_body: 'I handle this — looping Alex.',
        },
      ],
    };
    const result = buildReplyAll({
      history,
      accountEmails: ['ae@ourfirm.example'],
      originalLeadEmail: 'alex@lead.example',
    });
    assert.equal(result.replyEmailBody, 'I handle this — looping Alex.');
    assert.equal(result.senderFirstName, 'Jordan');
  });
});
