const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { enrichTimeoutMs, DEFAULT_ENRICH_TIMEOUT_MS, enrichProspect } = require('../src/services/prospect-enrich');

describe('waterfall lookup timeout', () => {
  const realFetch = global.fetch;
  const realUrl = process.env.EMAIL_WATERFALL_URL;
  afterEach(() => {
    global.fetch = realFetch;
    if (realUrl === undefined) delete process.env.EMAIL_WATERFALL_URL;
    else process.env.EMAIL_WATERFALL_URL = realUrl;
  });

  it('default is long enough for a loaded waterfall (> 140s)', () => {
    assert.ok(DEFAULT_ENRICH_TIMEOUT_MS > 140_000);
    assert.equal(enrichTimeoutMs({}), DEFAULT_ENRICH_TIMEOUT_MS);
  });

  it('env override is honored, junk and too-small values are ignored', () => {
    assert.equal(enrichTimeoutMs({ EMAIL_WATERFALL_TIMEOUT_MS: '200000' }), 200000);
    assert.equal(enrichTimeoutMs({ EMAIL_WATERFALL_TIMEOUT_MS: 'abc' }), DEFAULT_ENRICH_TIMEOUT_MS);
    assert.equal(enrichTimeoutMs({ EMAIL_WATERFALL_TIMEOUT_MS: '1000' }), DEFAULT_ENRICH_TIMEOUT_MS);
  });

  it('enrichProspect passes an abort signal to the waterfall call', async () => {
    process.env.EMAIL_WATERFALL_URL = 'https://waterfall.test';
    let seen;
    global.fetch = async (url, opts) => {
      seen = opts;
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, email: 'a@b.co', phone: '' }) };
    };
    await enrichProspect({ email: 'a@b.co', leadName: 'A B', need: 'phone' });
    assert.ok(seen.signal instanceof AbortSignal);
    assert.equal(seen.signal.aborted, false);
  });
});
