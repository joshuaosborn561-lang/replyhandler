const test = require('node:test');
const assert = require('node:assert');
const { enrichProspect, normalizeMaxTier, clientTagFor } = require('../src/services/prospect-enrich');

test('enrichProspect POSTs /enrich-one on the email-waterfall MCP host', async () => {
  const prev = process.env.EMAIL_WATERFALL_URL;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test/';
  const originalFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => {
    seen = { url: String(url), body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          email: 'jane@roofco.com',
          phone: '+12015550100',
          linkedin_url: 'https://linkedin.com/in/jane',
          website: 'https://roofco.com',
          phone_tier: 'fullenrich',
          sources: { phone: 'fullenrich' },
          max_tier: 'fullenrich',
        });
      },
    };
  };
  try {
    const hit = await enrichProspect({
      email: 'jane@roofco.com',
      leadName: 'Jane Smith',
    });
    assert.strictEqual(seen.url, 'https://waterfall.example.test/enrich-one');
    assert.strictEqual(seen.body.need, 'both');
    assert.strictEqual(seen.body.max_tier, 'fullenrich');
    assert.strictEqual(seen.body.write_supabase, false);
    assert.strictEqual(seen.body.client_tag, 'replyhandler');
    assert.strictEqual(seen.body.first_name, 'Jane');
    assert.strictEqual(hit.phone, '+12015550100');
    assert.strictEqual(hit.sources.phone, 'fullenrich');
    assert.strictEqual(hit.linkedinUrl, 'https://linkedin.com/in/jane');
  } finally {
    global.fetch = originalFetch;
    if (prev == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prev;
  }
});

test('enrichProspect skips when EMAIL_WATERFALL_URL is unset', async () => {
  const prev = process.env.EMAIL_WATERFALL_URL;
  delete process.env.EMAIL_WATERFALL_URL;
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('should not fetch');
  };
  try {
    const hit = await enrichProspect({ email: 'jane@roofco.com' });
    assert.strictEqual(called, false);
    assert.strictEqual(hit.phone, null);
    assert.strictEqual(hit.reason, 'waterfall_url_unset');
    assert.strictEqual(hit.email, 'jane@roofco.com');
  } finally {
    global.fetch = originalFetch;
    if (prev == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prev;
  }
});

test('enrichProspect sends Basic auth from EMAIL_WATERFALL_BASIC', async () => {
  const prevUrl = process.env.EMAIL_WATERFALL_URL;
  const prevBasic = process.env.EMAIL_WATERFALL_BASIC;
  process.env.EMAIL_WATERFALL_URL = 'https://waterfall.example.test';
  process.env.EMAIL_WATERFALL_BASIC = 'wfuser:wfpass';
  const originalFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => {
    seen = { url: String(url), headers: opts.headers };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, email: 'jane@roofco.com', linkedin_url: '' });
      },
    };
  };
  try {
    await enrichProspect({ email: 'jane@roofco.com' });
    assert.ok(seen.headers.Authorization);
    assert.match(seen.headers.Authorization, /^Basic /);
    const decoded = Buffer.from(seen.headers.Authorization.replace(/^Basic /, ''), 'base64').toString();
    assert.strictEqual(decoded, 'wfuser:wfpass');
  } finally {
    global.fetch = originalFetch;
    if (prevUrl == null) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = prevUrl;
    if (prevBasic == null) delete process.env.EMAIL_WATERFALL_BASIC;
    else process.env.EMAIL_WATERFALL_BASIC = prevBasic;
  }
});

test('clientTagFor and default max_tier stay fullenrich', () => {
  assert.strictEqual(normalizeMaxTier(''), 'fullenrich');
  assert.strictEqual(clientTagFor('Deep Roots'), 'deep_roots');
  assert.strictEqual(clientTagFor(''), 'replyhandler');
});
