const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Slack cards post before phone enrichment runs', () => {
  const source = read('src/services/slack-reply-post.js');
  const postStart = source.indexOf('async function postProspectSlackCard');
  const backgroundStart = source.indexOf('setImmediate(async () =>', postStart);
  const synchronousPath = source.slice(postStart, backgroundStart);
  assert.doesNotMatch(
    synchronousPath,
    /enrichPendingReplyPhone\(replyId\)/
  );
  assert.match(source, /setImmediate\(async \(\) =>/);
  assert.match(source, /updateTs:\s*result\.ts/);
});

test('approve/send uses the claimed enrichment path, never a direct waterfall', () => {
  const source = read('src/services/reply-send.js');
  assert.match(source, /getOrAwaitReplyEnrichment/);
  assert.doesNotMatch(source, /enrichProspect/);
});

test('provider fetches are bounded by a timeout', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  try {
    const { fetchWithTimeout } = require('../src/utils/fetch-with-timeout');
    await assert.rejects(
      () => fetchWithTimeout('https://example.invalid', {}, 5),
      (err) => err.name === 'TimeoutError'
    );
  } finally {
    global.fetch = originalFetch;
  }
});
