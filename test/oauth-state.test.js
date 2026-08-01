const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createOAuthState, verifyOAuthState } = require('../src/utils/oauth-state');

test('OAuth state is signed, provider-bound, and expires', () => {
  process.env.WEBHOOK_TEST_SECRET = 'oauth-test-secret';
  const state = createOAuthState({ provider: 'google', clientId: 'client-123', ttlMs: 10000 });
  assert.equal(verifyOAuthState(state, 'google').clientId, 'client-123');
  assert.equal(verifyOAuthState(state, 'microsoft'), null);
  assert.equal(verifyOAuthState(`${state}x`, 'google'), null);

  const expired = createOAuthState({ provider: 'gmail', ttlMs: -1 });
  assert.equal(verifyOAuthState(expired, 'gmail'), null);
});

test('OAuth callbacks require admin session and signed state', () => {
  const auth = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf8');
  for (const provider of ['google', 'microsoft', 'gmail']) {
    assert.match(
      auth,
      new RegExp(`\\/auth\\/${provider}\\/callback', requireAdminSecret`)
    );
    assert.match(auth, new RegExp(`verifyOAuthState\\(state, '${provider}'\\)`));
  }
  assert.match(auth, /Connect the configured primary mailbox/);
});
