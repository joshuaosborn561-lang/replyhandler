const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SMARTLEAD_429_RETRIES = '0';
const smartlead = require('../src/services/smartlead');

const realFetch = global.fetch;
const realWarn = console.warn;

function respond(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => '' },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

describe('verifyCampaignAccess', () => {
  beforeEach(() => { console.warn = () => {}; });
  afterEach(() => { global.fetch = realFetch; console.warn = realWarn; });

  it('accepts a campaign the key can read', async () => {
    global.fetch = respond(200, { id: 4242292, name: 'x' });
    assert.equal(await smartlead.verifyCampaignAccess('k', 4242292), true);
  });

  for (const status of [401, 403, 404]) {
    it(`rejects a definite no-access answer (${status})`, async () => {
      global.fetch = respond(status, 'nope');
      assert.equal(await smartlead.verifyCampaignAccess('k', 4242292), false);
    });
  }

  for (const status of [429, 500, 502, 503]) {
    it(`does not drop the reply on a transient ${status}`, async () => {
      global.fetch = respond(status, 'busy');
      assert.equal(await smartlead.verifyCampaignAccess('k', 4242292), true);
    });
  }

  it('does not drop the reply on a network error', async () => {
    global.fetch = async () => { throw new Error('socket hang up'); };
    assert.equal(await smartlead.verifyCampaignAccess('k', 4242292), true);
  });

  it('still rejects a missing key or campaign id', async () => {
    assert.equal(await smartlead.verifyCampaignAccess('', 4242292), false);
    assert.equal(await smartlead.verifyCampaignAccess('k', ''), false);
  });
});
