/**
 * Casey Laughlin / Beck Coggeshall 2026-10-12: SmartLead stored a REPLY
 * whose Outlook HTML is an empty span / lone <br>. Plain-text history is "".
 * That is not a dropped parse and must not Slack as "Draft generation failed".
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  cleanInboundReply,
  latestInboundFromSmartleadHistory,
  historyHasBlankInboundReply,
} = require('../src/utils/smartlead-webhook-helpers');

const CASEY_HTML =
  '<html><head>\r\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div><span style="font-family:Aptos,Aptos_EmbeddedFont,Aptos_MSFontService,Calibri,Helvetica,sans-serif; font-size:12pt; color:rgb(0,0,0); background-color:rgb(255,255,255)"></span></div></body></html>';

const BECK_HTML =
  '<html><head>\r\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div style="font-family:Inconsolata; font-size:12pt; color:rgb(0,0,0)"><br></div></body></html>';

function hist(replyBody) {
  return {
    history: [
      { type: 'SENT', email_body: 'Casey, the offer still stands.', time: '2026-10-12T14:33:11.199Z' },
      { type: 'REPLY', from: 'casey@texasoutdooroasis.com', email_body: replyBody, time: '2026-10-12T14:33:20.000Z' },
    ],
  };
}

test('empty Outlook HTML is not a usable inbound', () => {
  assert.strictEqual(cleanInboundReply(CASEY_HTML), '');
  assert.strictEqual(cleanInboundReply(BECK_HTML), '');
  assert.strictEqual(cleanInboundReply(''), '');
});

test('blank SmartLead REPLY is detected and not treated as text', () => {
  for (const body of [CASEY_HTML, BECK_HTML, '']) {
    const h = hist(body);
    assert.strictEqual(latestInboundFromSmartleadHistory(h, 'casey@texasoutdooroasis.com'), '');
    assert.strictEqual(historyHasBlankInboundReply(h), true, 'empty Outlook reply must count as blank');
  }
});

test('a real HTML reply is still recovered from message-history', () => {
  const h = hist('<div>Tuesday at 2 works for me.</div>');
  assert.strictEqual(
    latestInboundFromSmartleadHistory(h, 'casey@texasoutdooroasis.com'),
    'Tuesday at 2 works for me.',
  );
  assert.strictEqual(historyHasBlankInboundReply(h), false);
});

test('webhook skips blank inbound instead of paging Slack as a draft failure', () => {
  const webhooks = fs.readFileSync(path.join(__dirname, '../src/routes/webhooks.js'), 'utf8');
  assert.match(
    webhooks,
    /historyHasBlankInboundReply/,
    'empty Outlook replies must be classified before postError',
  );
  assert.match(
    webhooks,
    /reason:\s*'empty_inbound'/,
    'blank inbound must skip with a distinct reason',
  );
  const skipIdx = webhooks.indexOf("reason: 'empty_inbound'");
  const errorIdx = webhooks.indexOf('empty_inbound_after_history');
  assert.ok(skipIdx > 0 && errorIdx > skipIdx, 'blank skip must run before the draft-failed Slack error');
  const skipBlock = webhooks.slice(
    webhooks.indexOf('if (historyHasBlankInboundReply'),
    skipIdx + 40,
  );
  assert.ok(
    /return res\.status\(200\)/.test(skipBlock),
    'blank inbound must return 200 skipped',
  );
  assert.ok(
    !/postError/.test(skipBlock),
    'blank inbound must not post a Draft generation failed card',
  );
});
