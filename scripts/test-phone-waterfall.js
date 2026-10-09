#!/usr/bin/env node

const assert = require('assert');
const { enrichProspect } = require('../src/services/prospect-enrich');

async function main() {
  const prevUrl = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test';

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          email: 'person@example.com',
          phone: '+1 555-0100',
          linkedin_url: 'https://linkedin.com/in/test',
          website: 'https://example.com',
          phone_tier: 'prospeo',
          email_tier: 'input',
          sources: { phone: 'prospeo', email: 'input' },
          max_tier: 'fullenrich',
        });
      },
    };
  };

  try {
    delete process.env.EMAIL_WATERFALL_URL;
    const unset = await enrichProspect({ email: 'skip@example.com' });
    process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test';
    assert.strictEqual(unset.phone, null);
    assert.strictEqual(unset.reason, 'waterfall_url_unset');

    const result = await enrichProspect({
      email: 'person@example.com',
      leadName: 'Test Person',
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://waterfall.example.test/enrich-one');
    assert.strictEqual(calls[0].body.need, 'email');
    assert.strictEqual(calls[0].body.max_tier, 'fullenrich');
    assert.strictEqual(calls[0].body.write_supabase, false);
    assert.strictEqual(calls[0].body.client_tag, 'replyhandler');
    assert.strictEqual(result.phone, '+1 555-0100');
    assert.strictEqual(result.sources.phone, 'prospeo');
    assert.strictEqual(result.maxTier, 'fullenrich');
    assert.strictEqual(result.linkedinUrl, 'https://linkedin.com/in/test');
    assert.strictEqual(result.website, 'https://example.com');

    console.log('ok — ReplyHandler calls email-waterfall /enrich-one (need=email, approve_cost_usd, max_tier=fullenrich)');
  } finally {
    global.fetch = originalFetch;
    if (prevUrl == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prevUrl;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
