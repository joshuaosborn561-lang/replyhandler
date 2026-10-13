const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BLOCKED_INBOUND_FORWARD_EMAILS,
  matchInboundForwardRules,
  collectForwardEmails,
  inboundForwardLeadKey,
} = require('../src/utils/inbound-forward-policy');
const {
  maybeForwardInboundReply,
  shouldSkipInboundForwardEvent,
  extractInboundForwardFields,
  handleInboundForwardWebhook,
} = require('../src/services/inbound-forward');
const { buildInboundForwardEmail, buildClientNotifyEmail } = require('../src/services/client-notify-email');

const SEEDED = [
  { campaign_id: '4085158', campaign_name_pattern: null, to_emails: 'gabriel.lopez@rocketbox.mx', active: true },
  { campaign_id: '4085159', campaign_name_pattern: null, to_emails: 'gabriel.lopez@rocketbox.mx', active: true },
  { campaign_id: '4085160', campaign_name_pattern: null, to_emails: 'gabriel.lopez@rocketbox.mx', active: true },
  { campaign_id: null, campaign_name_pattern: 'Gabe Calls%', to_emails: 'gabriel.lopez@rocketbox.mx', active: true },
];

function memoryClaims() {
  const rows = new Map();
  return async function query(sql, params) {
    if (/INSERT INTO inbound_forwards/i.test(sql)) {
      const key = `${params[0]}|${params[1]}|${params[2]}`;
      if (rows.has(key)) return { rows: [] };
      const id = `claim-${rows.size + 1}`;
      rows.set(key, { id, status: 'pending' });
      return { rows: [{ id }] };
    }
    if (/UPDATE inbound_forwards/i.test(sql)) {
      return { rows: [] };
    }
    if (/DELETE FROM inbound_forwards/i.test(sql)) {
      for (const [k, v] of rows.entries()) {
        if (v.id === params[0]) rows.delete(k);
      }
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
}

describe('inbound forward rules', () => {
  it('matches the three seeded campaign ids', () => {
    for (const id of ['4085158', '4085159', '4085160']) {
      const hits = matchInboundForwardRules(SEEDED, { campaignId: id, campaignName: 'Other Name' });
      assert.ok(hits.some((r) => r.campaign_id === id));
    }
  });

  it('matches a future Gabe Calls campaign by name pattern', () => {
    const hits = matchInboundForwardRules(SEEDED, {
      campaignId: '9999999',
      campaignName: 'Gabe Calls | New Client',
    });
    assert.ok(hits.some((r) => r.campaign_name_pattern === 'Gabe Calls%'));
    const { emails } = collectForwardEmails(hits);
    assert.deepEqual(emails, ['gabriel.lopez@rocketbox.mx']);
  });

  it('does not match an unrelated campaign', () => {
    const hits = matchInboundForwardRules(SEEDED, {
      campaignId: '111',
      campaignName: 'SalesGlider Staffing',
    });
    assert.equal(hits.length, 0);
  });

  it('never collects the bounced rocketbox address', () => {
    assert.ok(BLOCKED_INBOUND_FORWARD_EMAILS.has('crecimiento@rocketbox.mx'));
    const { emails, blocked } = collectForwardEmails([
      { to_emails: 'crecimiento@rocketbox.mx, gabriel.lopez@rocketbox.mx' },
    ]);
    assert.deepEqual(emails, ['gabriel.lopez@rocketbox.mx']);
    assert.deepEqual(blocked, ['crecimiento@rocketbox.mx']);
  });

  it('keys dedupe on lead id when present', () => {
    assert.equal(inboundForwardLeadKey({ leadId: '55', leadEmail: 'a@b.com' }), 'id:55');
    assert.equal(inboundForwardLeadKey({ leadEmail: 'A@B.com' }), 'email:a@b.com');
  });
});

describe('maybeForwardInboundReply', () => {
  const loadRules = async () => SEEDED;

  it('sends once and dedupes the same inbound', async () => {
    const sent = [];
    const query = memoryClaims();
    const deps = {
      query,
      loadRules,
      isGmailConfigured: () => true,
      sendMail: async (opts) => { sent.push(opts); return { id: 'msg-1' }; },
    };
    const payload = {
      campaignId: '4085158',
      campaignName: 'Gabe Calls | SalesGlider',
      leadId: '88',
      leadEmail: 'alex@example.com',
      leadName: 'Alex Prospect',
      inboundMessage: 'Can you send times for next week?',
    };
    const first = await maybeForwardInboundReply(payload, deps);
    const second = await maybeForwardInboundReply(payload, deps);
    assert.equal(first.forwarded, true);
    assert.deepEqual(first.to, ['gabriel.lopez@rocketbox.mx']);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'already_forwarded');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to[0], 'gabriel.lopez@rocketbox.mx');
    assert.match(sent[0].subject, /Inbound reply/);
  });

  it('does not send when no rule matches', async () => {
    let sent = 0;
    const result = await maybeForwardInboundReply({
      campaignId: '1',
      campaignName: 'Unrelated',
      inboundMessage: 'hello',
    }, {
      query: memoryClaims(),
      loadRules,
      isGmailConfigured: () => true,
      sendMail: async () => { sent += 1; },
    });
    assert.equal(result.reason, 'no_rule');
    assert.equal(sent, 0);
  });

  it('releases the claim when Gmail fails so a later attempt can retry', async () => {
    const query = memoryClaims();
    const depsFail = {
      query,
      loadRules,
      isGmailConfigured: () => true,
      sendMail: async () => { throw new Error('gmail down'); },
    };
    const payload = {
      campaignId: '4085160',
      inboundMessage: 'Out of office until Monday',
      leadId: '12',
    };
    const failed = await maybeForwardInboundReply(payload, depsFail);
    assert.equal(failed.reason, 'send_failed');

    const sent = [];
    const ok = await maybeForwardInboundReply(payload, {
      ...depsFail,
      sendMail: async (opts) => { sent.push(opts); },
    });
    assert.equal(ok.forwarded, true);
    assert.equal(sent.length, 1);
  });

  it('forwards regardless of classification text (OOO / not interested)', async () => {
    const sent = [];
    await maybeForwardInboundReply({
      campaignId: '4085159',
      inboundMessage: 'please remove me from this list',
      leadId: '9',
    }, {
      query: memoryClaims(),
      loadRules,
      isGmailConfigured: () => true,
      sendMail: async (opts) => { sent.push(opts); },
    });
    assert.equal(sent.length, 1);
  });
});

describe('inbound forward webhook', () => {
  it('leaves Allo category updates alone', () => {
    assert.equal(
      shouldSkipInboundForwardEvent({ event_type: 'LEAD_CATEGORY_UPDATED' }),
      'leave_allo_hook',
    );
  });

  it('extracts campaign and inbound from a SmartLead EMAIL_REPLY payload', () => {
    const fields = extractInboundForwardFields({
      event_type: 'EMAIL_REPLY',
      email_campaign_id: 4085158,
      email_campaign_name: 'Gabe Calls | SalesGlider',
      email_lead_id: 44,
      lead_email: 'alex@example.com',
      lead_first_name: 'Alex',
      lead_last_name: 'Prospect',
      reply_message: { text: 'Thursday works for me.' },
    });
    assert.equal(fields.campaignId, '4085158');
    assert.equal(fields.leadId, '44');
    assert.match(fields.inboundMessage, /Thursday works/);
  });

  it('rejects a configured secret mismatch', async () => {
    const prev = process.env.INBOUND_FORWARD_WEBHOOK_SECRET;
    process.env.INBOUND_FORWARD_WEBHOOK_SECRET = 'set-in-test';
    try {
      const result = await handleInboundForwardWebhook({
        query: {},
        headers: {},
        body: { event_type: 'EMAIL_REPLY', email_campaign_id: 4085158 },
      });
      assert.equal(result.status, 401);
    } finally {
      if (prev == null) delete process.env.INBOUND_FORWARD_WEBHOOK_SECRET;
      else process.env.INBOUND_FORWARD_WEBHOOK_SECRET = prev;
    }
  });
});

describe('inbound forward email copy', () => {
  it('uses the inbox thread cards and does not say we just replied', () => {
    const inbound = buildInboundForwardEmail({
      leadName: 'Alex Prospect',
      leadEmail: 'alex@example.com',
      campaignName: 'Gabe Calls | SalesGlider',
      inboundMessage: 'Can we talk Thursday?',
    });
    const onSend = buildClientNotifyEmail({
      leadName: 'Alex Prospect',
      leadEmail: 'alex@example.com',
      clientName: 'SalesGlider',
      inboundMessage: 'Can we talk Thursday?',
      sentText: 'Thursday at 2 works.',
    });
    assert.match(inbound.subject, /Inbound reply/);
    assert.match(inbound.htmlBody, /A new reply came in/);
    assert.doesNotMatch(inbound.htmlBody, /we just replied/);
    assert.match(inbound.htmlBody, /From:/);
    assert.match(onSend.htmlBody, /we just replied/);
  });
});
