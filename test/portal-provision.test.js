const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeContactEmail,
  buildProvisionPayload,
  extractLoginLink,
  provisionClientToPortal,
} = require('../src/services/portal-provision');

const sample = {
  id: 'client-uuid-1',
  name: 'Acme',
  contact_email: 'Owner@Acme.com',
  smartlead_api_key: 'sl_key',
  heyreach_api_key: 'hr_key',
  slack_bot_token: 'xoxb-secret',
  slack_channel_id: 'C123',
  booking_link: 'https://cal.com/acme',
  calendly_personal_access_token: 'pat',
  voice_prompt: 'Be brief.',
  digest_timezone: 'America/Chicago',
  cc_email: 'ae@acme.com',
  cc_emails: 'ae@acme.com',
  cc_round_robin_emails: null,
  active: true,
};

describe('portal provision payload', () => {
  it('sends handler_client_id and skips invite when contact email is empty', () => {
    const withEmail = buildProvisionPayload(sample);
    assert.equal(withEmail.handler_client_id, 'client-uuid-1');
    assert.equal(withEmail.contact_email, 'owner@acme.com');
    assert.equal(withEmail.skip_invite, false);
    assert.equal(withEmail.smartlead_api_key, 'sl_key');
    assert.ok(!Object.prototype.hasOwnProperty.call(withEmail, 'slack_bot_token'));

    const noEmail = buildProvisionPayload({ ...sample, contact_email: '' });
    assert.equal(noEmail.contact_email, null);
    assert.equal(noEmail.skip_invite, true);
    assert.equal(normalizeContactEmail('not-an-email'), null);
  });

  it('reads a login link from the portal response', () => {
    assert.equal(
      extractLoginLink({ login_link: 'https://portal.example/invite/abc' }),
      'https://portal.example/invite/abc',
    );
    assert.equal(extractLoginLink({ url: 'not-a-url' }), null);
  });
});

describe('portal provision transport', () => {
  it('does not throw when the portal is down; retries once', async () => {
    const prevUrl = process.env.PORTAL_URL;
    const prevSecret = process.env.PORTAL_WEBHOOK_SECRET;
    process.env.PORTAL_URL = 'https://portal.example';
    process.env.PORTAL_WEBHOOK_SECRET = 'portal-secret';
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      throw new Error('network down');
    };
    try {
      const result = await provisionClientToPortal(sample, {
        fetchFn,
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

  it('returns the login link on success', async () => {
    const prevUrl = process.env.PORTAL_URL;
    const prevSecret = process.env.PORTAL_WEBHOOK_SECRET;
    process.env.PORTAL_URL = 'https://portal.example';
    process.env.PORTAL_WEBHOOK_SECRET = 'portal-secret';
    const fetchFn = async (url, opts) => {
      assert.match(url, /\/functions\/v1\/provision-client$/);
      assert.equal(opts.headers['x-portal-secret'], 'portal-secret');
      const body = JSON.parse(opts.body);
      assert.equal(body.handler_client_id, 'client-uuid-1');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ login_link: 'https://portal.example/login/xyz' }),
      };
    };
    try {
      const result = await provisionClientToPortal(sample, { fetchFn, sleepFn: async () => {} });
      assert.equal(result.ok, true);
      assert.equal(result.loginLink, 'https://portal.example/login/xyz');
    } finally {
      if (prevUrl == null) delete process.env.PORTAL_URL;
      else process.env.PORTAL_URL = prevUrl;
      if (prevSecret == null) delete process.env.PORTAL_WEBHOOK_SECRET;
      else process.env.PORTAL_WEBHOOK_SECRET = prevSecret;
    }
  });

  it('skips quietly when portal env is missing', async () => {
    const prevUrl = process.env.PORTAL_URL;
    const prevSecret = process.env.PORTAL_WEBHOOK_SECRET;
    delete process.env.PORTAL_URL;
    delete process.env.PORTAL_WEBHOOK_SECRET;
    try {
      const result = await provisionClientToPortal(sample, {
        fetchFn: async () => { throw new Error('should not fetch'); },
      });
      assert.equal(result.skipped, true);
      assert.equal(result.ok, false);
    } finally {
      if (prevUrl == null) delete process.env.PORTAL_URL;
      else process.env.PORTAL_URL = prevUrl;
      if (prevSecret == null) delete process.env.PORTAL_WEBHOOK_SECRET;
      else process.env.PORTAL_WEBHOOK_SECRET = prevSecret;
    }
  });
});
