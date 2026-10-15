const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  FYI_NOTES_LINE,
  DEFAULT_FYI_CC_EMAILS,
  DEFAULT_FYI_REPLY_TO,
  fyiCcEmails,
  fyiReplyTo,
  mergeEmailLists,
} = require('../src/utils/fyi-notify');
const { buildClientNotifyEmail } = require('../src/services/client-notify-email');
const { buildRawMime } = require('../src/services/gmail-send');

describe('FYI CC and Reply-To', () => {
  it('defaults CC when FYI_CC_EMAILS is unset and honors an override', () => {
    assert.deepEqual(fyiCcEmails({}), [DEFAULT_FYI_CC_EMAILS]);
    assert.deepEqual(fyiCcEmails({ FYI_CC_EMAILS: 'ops@example.test, ae@example.test' }), [
      'ops@example.test',
      'ae@example.test',
    ]);
    assert.deepEqual(fyiCcEmails({ FYI_CC_EMAILS: '' }), []);
  });

  it('Reply-To is FYI_REPLY_TO, else PRIMARY_GMAIL_FROM, else the default mailbox', () => {
    assert.equal(fyiReplyTo({}), DEFAULT_FYI_REPLY_TO);
    assert.equal(fyiReplyTo({ PRIMARY_GMAIL_FROM: 'ops@example.test' }), 'ops@example.test');
    assert.equal(fyiReplyTo({
      PRIMARY_GMAIL_FROM: 'ops@example.test',
      FYI_REPLY_TO: 'notes@example.test',
    }), 'notes@example.test');
  });

  it('mergeEmailLists dedupes To + CC', () => {
    assert.deepEqual(
      mergeEmailLists('client@example.test, ops@example.test', ['ops@example.test', 'ae@example.test']),
      ['client@example.test', 'ops@example.test', 'ae@example.test'],
    );
  });
});

describe('FYI body', () => {
  it('includes the ops reply line on HTML and text', () => {
    const { htmlBody, textBody } = buildClientNotifyEmail({
      leadName: 'Pat',
      leadEmail: 'pat@example.test',
      clientName: 'Example Co',
      campaignName: 'Test campaign',
      enrichment: { email: 'pat@example.test' },
      threadContext: { history: [] },
      inboundMessage: 'Sure, send times',
      sentText: 'Tue or Wed work.',
    });
    assert.match(FYI_NOTES_LINE, /just hit reply all/);
    assert.match(htmlBody, /FYI — we just replied/);
    assert.match(htmlBody, new RegExp(FYI_NOTES_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(textBody, new RegExp(FYI_NOTES_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(htmlBody, /do not reply-all/);
  });
});

describe('Gmail MIME for FYI', () => {
  it('writes Cc and Reply-To headers', () => {
    const raw = buildRawMime({
      from: 'ops@example.test',
      to: ['client@example.test'],
      cc: ['ae@example.test'],
      replyTo: 'ops@example.test',
      subject: 'Prospect reply: Pat',
      htmlBody: '<p>FYI</p>',
      textBody: 'FYI',
    });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.match(decoded, /To: client@example\.test/);
    assert.match(decoded, /Cc: ae@example\.test/);
    assert.match(decoded, /Reply-To: ops@example\.test/);
  });
});
