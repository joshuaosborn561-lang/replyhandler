const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAdminAuth, readAdminHeader } = require('../src/utils/admin-auth');

test('missing ADMIN_API_KEY fails closed', () => {
  const r = evaluateAdminAuth({}, 'any-token');
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.error, 'admin auth not configured');
});

test('blank ADMIN_API_KEY fails closed', () => {
  const r = evaluateAdminAuth({ ADMIN_API_KEY: '   ' }, '   ');
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('wrong header is 401', () => {
  const r = evaluateAdminAuth({ ADMIN_API_KEY: 'correct-key' }, 'wrong-key');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('missing header is 401 when env is set', () => {
  const r = evaluateAdminAuth({ ADMIN_API_KEY: 'correct-key' }, '');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('matching ADMIN_API_KEY header is ok', () => {
  const r = evaluateAdminAuth({ ADMIN_API_KEY: 'correct-key' }, 'correct-key');
  assert.equal(r.ok, true);
});

test('readAdminHeader prefers ADMIN_API_KEY then x-admin-api-key', () => {
  const req = {
    get(name) {
      const n = String(name).toLowerCase();
      if (n === 'admin_api_key') return 'from-canonical';
      if (n === 'x-admin-api-key') return 'from-alias';
      return '';
    },
  };
  assert.equal(readAdminHeader(req), 'from-canonical');

  const aliasOnly = {
    get(name) {
      return String(name).toLowerCase() === 'x-admin-api-key' ? 'alias-only' : '';
    },
  };
  assert.equal(readAdminHeader(aliasOnly), 'alias-only');
});
