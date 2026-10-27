/**
 * Outlook sometimes sends a reply that is only an empty HTML shell (an
 * auto-response or a "report phishing" click, seconds after our send).
 * SmartLead stores the REPLY with no prospect text. That is not a dropped
 * parse: nothing can be drafted, and it must not page Slack as
 * "Draft generation failed". The raw tags must also never be treated as the
 * reply text (they used to show up as an "Unclassified reply").
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  cleanInboundReply,
  cleanInboundOrRaw,
  latestInboundReplyIsBlank,
  latestInboundFromSmartleadHistory,
} = require('../src/utils/smartlead-webhook-helpers');

const SHELL =
  '<html>\n<head>\n<meta http-equiv="Content-Type" content="text/html; charset=us-ascii">\n</head>\n<body>\n'
  + '<div style="font-family:Aptos,Aptos_EmbeddedFont,Aptos_MSFontService,Calibri,Helvetica,sans-serif; font-size:12pt; color:rgb(0,0,0)">\n<br>\n</div>\n</body>\n</html>\n';

function hist(replyBody, extra = []) {
  return {
    history: [
      ...extra,
      { type: 'SENT', email_body: 'Quick question for you.', time: '2026-10-27T13:05:16.794Z' },
      { type: 'REPLY', from: 'lead@example.org', email_body: replyBody, time: '2026-10-27T13:05:28.000Z' },
    ],
  };
}

test('an empty HTML shell cleans to blank, never to its own tags', () => {
  assert.strictEqual(cleanInboundReply(SHELL), '');
  assert.strictEqual(cleanInboundOrRaw(SHELL), '');
  assert.strictEqual(cleanInboundOrRaw(''), '');
  assert.strictEqual(cleanInboundOrRaw('<div><br></div>'), '');
});

test('plain text and real HTML replies are unchanged', () => {
  assert.strictEqual(cleanInboundOrRaw('Yes, send it over.'), 'Yes, send it over.');
  assert.strictEqual(cleanInboundOrRaw('<div>Tuesday at 2 works.</div>'), 'Tuesday at 2 works.');
});

test('a blank newest REPLY is detected, whether SmartLead gives "" or the shell', () => {
  assert.strictEqual(latestInboundReplyIsBlank(hist('')), true);
  assert.strictEqual(latestInboundReplyIsBlank(hist(SHELL)), true);
  assert.strictEqual(latestInboundFromSmartleadHistory(hist(SHELL), 'lead@example.org'), '');
});

test('a real reply is not blank, and an older real reply does not hide a blank newest one', () => {
  assert.strictEqual(latestInboundReplyIsBlank(hist('<div>Interested, call me.</div>')), false);
  const older = [{ type: 'REPLY', from: 'lead@example.org', email_body: 'Not now.', time: '2026-10-20T10:00:00.000Z' }];
  assert.strictEqual(latestInboundReplyIsBlank(hist('', older)), true);
});

test('no history, or history with no replies, is not "blank" (keep the real failure alert)', () => {
  assert.strictEqual(latestInboundReplyIsBlank(null), false);
  assert.strictEqual(latestInboundReplyIsBlank({ history: [] }), false);
  assert.strictEqual(latestInboundReplyIsBlank({ history: [{ type: 'SENT', email_body: 'hi', time: 't' }] }), false);
});

test('webhook skips a blank newest reply before history expansion and before postError', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/webhooks.js'), 'utf8');
  const skip = src.indexOf('latestInboundReplyIsBlank(threadContext)');
  const expand = src.indexOf('latestInboundFromSmartleadHistory(threadContext, leadEmail)');
  const err = src.indexOf('No usable reply body from webhook or message-history');
  assert.ok(skip > 0 && expand > skip && err > skip, 'blank check must run first');
  const block = src.slice(skip, src.indexOf('return;', skip) + 10);
  assert.match(block, /empty_inbound/);
  assert.ok(!/postError/.test(block), 'blank reply must not post a Draft generation failed card');
});
