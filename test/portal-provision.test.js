const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeContactEmail,
  portalContactEmail,
  buildProvisionPayload,
  extractLoginLink,
  extractWarning,
  provisionClientToPortal,
} = require('../src/services/portal-provision');

const sample = {
  id: 'client-uuid-1',
  name: 'Acme',
  contact_email: 'Owner@Acme.com',
  smartlead_api_key: 'sl_key',
  heyreach_api_key: 'hr_key',
  allo_api_key: 'allo_key',
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

function withInviteEnv(value, fn) {
  const prev = process.env.PORTAL_SKIP_INVITE;
  if (value == null) delete process.env.PORTAL_SKIP_INVITE;
  else process.env.PORTAL_SKIP_INVITE = value;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.PORTAL_SKIP_INVITE;
    else process.env.PORTAL_SKIP_INVITE = prev;
  }
}

describe('portal provision payload', () => {
  it('sends only the fields the portal stores', () => {
    withInviteEnv('false', () => {
      const withEmail = buildProvisionPayload(sample);
      assert.equal(withEmail.handler_client_id, 'client-uuid-1');
      assert.equal(withEmail.contact_email, 'ae@acme.com');
      assert.equal(withEmail.skip_invite, false);
      assert.equal(withEmail.smartlead_api_key, 'sl_key');
      assert.equal(withEmail.allo_api_key, 'allo_key');
      assert.equal(withEmail.booking_link, 'https://cal.com/acme');
      assert.equal(withEmail.active, true);
      assert.ok(!Object.prototype.hasOwnProperty.call(withEmail, 'slack_bot_token'));
      assert.ok(!Object.prototype.hasOwnProperty.call(withEmail, 'calendly_personal_access_token'));
      assert.ok(!Object.prototype.hasOwnProperty.call(withEmail, 'slack_channel_id'));
      assert.ok(!Object.prototype.hasOwnProperty.call(withEmail, 'voice_prompt'));
      assert.ok(!Object.prototype.hasOwnProperty.call(withEmail, 'digest_timezone'));
      assert.ok(!Object.prototype.hasOwnProperty.call(withEmail, 'cc_email'));
    });

    const noEmail = buildProvisionPayload({
      ...sample, contact_email: 'leftover@old.com', cc_emails: '', cc_email: '',
    });
    assert.equal(noEmail.contact_email, null);
    assert.equal(noEmail.skip_invite, true);
    assert.equal(normalizeContactEmail('not-an-email'), null);
    assert.equal(portalContactEmail(sample), 'ae@acme.com');
  });

  it('sends an invite when the always-notify email is present', () => {
    withInviteEnv(undefined, () => {
      assert.equal(buildProvisionPayload(sample).skip_invite, false);
    });
    withInviteEnv('false', () => {
      assert.equal(buildProvisionPayload(sample).skip_invite, false);
      assert.equal(buildProvisionPayload({
        ...sample, contact_email: '', cc_emails: '', cc_email: '',
      }).skip_invite, true);
    });
    withInviteEnv('true', () => {
      assert.equal(buildProvisionPayload(sample).skip_invite, true);
    });
  });

  it('reads a login link and warning from the portal response', () => {
    assert.equal(
      extractLoginLink({ login_link: 'https://portal.example/invite/abc' }),
      'https://portal.example/invite/abc',
    );
    assert.equal(extractLoginLink({ url: 'not-a-url' }), null);
    assert.equal(extractWarning({ warning: 'email changed; not re-invited' }), 'email changed; not re-invited');
    assert.equal(extractWarning({ warnings: ['one', 'two'] }), 'one; two');
    assert.equal(extractWarning({}), null);
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
