const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  sanitizeOauthValue,
  isGmailQuotaError,
  postGmailSend,
} = require('../src/services/gmail-send');

describe('Gmail OAuth + send resilience', () => {
  it('strips wrapping quotes and whitespace from OAuth client values', () => {
    assert.equal(sanitizeOauthValue('  GOCSPX-abc  '), 'GOCSPX-abc');
    assert.equal(sanitizeOauthValue('"GOCSPX-abc"'), 'GOCSPX-abc');
    assert.equal(sanitizeOauthValue("'GOCSPX-abc'"), 'GOCSPX-abc');
  });

  it('treats Gmail 403 quota as retryable and other 403s as fatal', () => {
    assert.equal(
      isGmailQuotaError(403, 'Quota exceeded for quota metric \'Total Query Cost\''),
      true,
    );
    assert.equal(isGmailQuotaError(403, 'The caller does not have permission'), false);
    assert.equal(isGmailQuotaError(401, 'Quota exceeded'), false);
  });

  it('retries a quota 403 then succeeds without treating it as a failed send', async () => {
    const calls = [];
    const sleepMs = [];
    const res = await postGmailSend('raw', 'token', {
      retries: 2,
      waitMs: 10,
      sleep: async (ms) => { sleepMs.push(ms); },
      fetchImpl: async () => {
        calls.push(1);
        if (calls.length === 1) {
          return {
            ok: false,
            status: 403,
            text: async () => JSON.stringify({
              error: { message: "Quota exceeded for quota metric 'Total Query Cost'" },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 'msg-ok' }),
        };
      },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(sleepMs, [10]);
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(res.body).id, 'msg-ok');
  });

  it('sendMail posts through the quota-retry helper', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/gmail-send.js'), 'utf8');
    assert.match(src, /async function postGmailSend/);
    assert.match(src, /const sent = await postGmailSend\(raw, token\)/);
  });
});
