const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COOKIE_NAME,
  verifyAdminSecret,
  requireAdminSecret,
  requireAdminSecretOrSetCookie,
} = require('../src/middleware/adminSecret');

function req({ header, query, cookie, accept = 'application/json', url = '/admin/clients' } = {}) {
  return {
    headers: {
      ...(cookie ? { cookie } : {}),
      accept,
    },
    query: query || {},
    originalUrl: url,
    get(name) {
      return name.toLowerCase() === 'x-webhook-test-secret' ? header : undefined;
    },
  };
}

function res() {
  return {
    statusCode: null,
    body: null,
    cookieArgs: null,
    redirectTo: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
    cookie(...args) { this.cookieArgs = args; return this; },
    redirect(path) { this.statusCode = 302; this.redirectTo = path; return this; },
  };
}

test('admin secret accepts header, query, and cookie', () => {
  process.env.WEBHOOK_TEST_SECRET = 'super-secret';
  assert.equal(verifyAdminSecret(req({ header: 'super-secret' })), true);
  assert.equal(verifyAdminSecret(req({ query: { secret: 'super-secret' } })), true);
  assert.equal(verifyAdminSecret(req({ cookie: `${COOKIE_NAME}=super-secret` })), true);
  assert.equal(verifyAdminSecret(req({ header: 'wrong' })), false);
});

test('unset admin secret fails closed with 404', () => {
  delete process.env.WEBHOOK_TEST_SECRET;
  const response = res();
  let nextCalled = false;
  requireAdminSecret(req(), response, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 404);
});

test('wrong configured admin secret returns 401', () => {
  process.env.WEBHOOK_TEST_SECRET = 'super-secret';
  const response = res();
  requireAdminSecret(req({ header: 'wrong' }), response, () => {});
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: 'unauthorized' });
});

test('dashboard query secret sets HttpOnly cookie and cleans URL', () => {
  process.env.WEBHOOK_TEST_SECRET = 'super-secret';
  process.env.RAILWAY_PUBLIC_DOMAIN = 'example.up.railway.app';
  const response = res();
  requireAdminSecretOrSetCookie(
    req({
      query: { secret: 'super-secret' },
      accept: 'text/html',
      url: '/dashboard?secret=super-secret',
    }),
    response,
    () => assert.fail('must redirect after setting cookie')
  );
  assert.equal(response.redirectTo, '/dashboard');
  assert.equal(response.cookieArgs[0], COOKIE_NAME);
  assert.equal(response.cookieArgs[1], 'super-secret');
  assert.equal(response.cookieArgs[2].httpOnly, true);
  assert.equal(response.cookieArgs[2].secure, true);
});

test('dashboard cookie allows subsequent requests', () => {
  process.env.WEBHOOK_TEST_SECRET = 'super-secret';
  const response = res();
  let nextCalled = false;
  requireAdminSecretOrSetCookie(
    req({ cookie: `${COOKIE_NAME}=super-secret`, accept: 'text/html', url: '/dashboard' }),
    response,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
});
