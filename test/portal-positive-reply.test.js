const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isPositivePortalClassification,
  channelFromPlatform,
  snippetFromInbound,
  companyFromEmail,
  buildPositiveReplyPayload,
  notifyPortalPositiveReply,
} = require('../src/services/portal-positive-reply');

describe('portal positive-reply payload', () => {
  it('maps platform to channel and keeps the portal field set', () => {
    assert.equal(channelFromPlatform('smartlead'), 'email');
    assert.equal(channelFromPlatform('heyreach'), 'linkedin');
    assert.equal(channelFromPlatform('call'), 'call');
    assert.equal(isPositivePortalClassification('INTERESTED'), true);
    assert.equal(isPositivePortalClassification('FOLLOW_UP'), false);
    assert.equal(isPositivePortalClassification('NOT_INTERESTED'), false);

    const payload = buildPositiveReplyPayload({
      clientId: 'client-1',
      platform: 'smartlead',
      email: 'Pat@AcmeRoofing.com',
      name: 'Pat',
      company: 'Acme Roofing',
      campaignId: 99,
      leadId: 'lead-1',
      snippet: '  Sounds good, Thursday works.  ',
      repliedAt: '2026-10-02T15:00:00.000Z',
    });
    assert.deepEqual(payload, {
      handler_client_id: 'client-1',
      email: 'pat@acmeroofing.com',
      name: 'Pat',
      company: 'Acme Roofing',
      campaign_id: '99',
      lead_id: 'lead-1',
      snippet: 'Sounds good, Thursday works.',
      replied_at: '2026-10-02T15:00:00.000Z',
      channel: 'email',
    });
  });

  it('falls back to the email domain when company is missing', () => {
    assert.equal(companyFromEmail('pat@acmeroofing.com'), 'acmeroofing.com');
    assert.equal(companyFromEmail('pat@gmail.com'), null);
    const payload = buildPositiveReplyPayload({
      clientId: 'c',
      platform: 'heyreach',
      email: 'jane@petersonroof.com',
      name: 'Jane',
      snippet: 'yes',
      repliedAt: '2026-10-02T12:00:00.000Z',
    });
    assert.equal(payload.company, 'petersonroof.com');
    assert.equal(payload.channel, 'linkedin');
    assert.equal(payload.email, 'jane@petersonroof.com');
  });

  it('truncates a long snippet', () => {
    const long = 'x'.repeat(600);
    const snip = snippetFromInbound(long);
    assert.equal(snip.length, 500);
    assert.ok(snip.endsWith('...'));
  });
});

describe('portal positive-reply transport', () => {
  it('skips FOLLOW_UP and non-positives without fetching', async () => {
    const result = await notifyPortalPositiveReply(
      { classification: 'FOLLOW_UP', clientId: 'c' },
      { fetchFn: async () => { throw new Error('should not fetch'); } }
    );
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not_positive');
  });

  it('does not throw when the portal is down; retries once', async () => {
    const prevUrl = process.env.PORTAL_URL;
    const prevSecret = process.env.PORTAL_WEBHOOK_SECRET;
    process.env.PORTAL_URL = 'https://portal.example';
    process.env.PORTAL_WEBHOOK_SECRET = 'portal-secret';
    let calls = 0;
    try {
      const result = await notifyPortalPositiveReply({
        classification: 'INTERESTED',
        clientId: 'client-1',
        platform: 'smartlead',
        email: 'pat@acme.com',
        name: 'Pat',
        snippet: 'interested',
        repliedAt: '2026-10-02T15:00:00.000Z',
      }, {
        fetchFn: async () => { calls += 1; throw new Error('network down'); },
        sleepFn: async () => {},
        retryWaitMs: 0,
      });
      assert.equal(result.ok, false);
      assert.equal(calls, 2);
    } finally {
      if (prevUrl == null) delete process.env.PORTAL_URL;
      else process.env.PORTAL_URL = prevUrl;
      if (prevSecret == null) delete process.env.PORTAL_WEBHOOK_SECRET;
      else process.env.PORTAL_WEBHOOK_SECRET = prevSecret;
    }
  });

  it('POSTs the slim payload to new-positive-reply', async () => {
    const prevUrl = process.env.PORTAL_URL;
    const prevSecret = process.env.PORTAL_WEBHOOK_SECRET;
    process.env.PORTAL_URL = 'https://portal.example';
    process.env.PORTAL_WEBHOOK_SECRET = 'portal-secret';
    const fetchFn = async (url, opts) => {
      assert.match(url, /\/functions\/v1\/new-positive-reply$/);
      assert.equal(opts.headers['x-portal-secret'], 'portal-secret');
      const body = JSON.parse(opts.body);
      assert.equal(body.handler_client_id, 'client-1');
      assert.equal(body.channel, 'email');
      assert.equal(body.email, 'pat@acme.com');
      assert.equal(body.replied_at, '2026-10-02T15:00:00.000Z');
      return { ok: true, status: 200, text: async () => '{}' };
    };
    try {
      const result = await notifyPortalPositiveReply({
        classification: 'QUESTION',
        clientId: 'client-1',
        platform: 'smartlead',
        email: 'pat@acme.com',
        name: 'Pat',
        snippet: 'when can we talk?',
        repliedAt: '2026-10-02T15:00:00.000Z',
      }, { fetchFn, sleepFn: async () => {} });
      assert.equal(result.ok, true);
    } finally {
      if (prevUrl == null) delete process.env.PORTAL_URL;
      else process.env.PORTAL_URL = prevUrl;
      if (prevSecret == null) delete process.env.PORTAL_WEBHOOK_SECRET;
      else process.env.PORTAL_WEBHOOK_SECRET = prevSecret;
    }
  });
});
