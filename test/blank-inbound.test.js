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
  payloadInboundIsBlank,
} = require('../src/utils/smartlead-webhook-helpers');
const { latestInboundFromHistory } = require('../src/services/smartlead-poller');
const { latestInbound } = require('../src/services/heyreach-poller');
const { compactOtherAlertText, postOtherAlert } = require('../src/services/other-alert');
const { buildConversationBlocks } = require('../src/services/slack');

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

// Richard Owen, richard@newbraunfelselectric.com, SG Subs Owners Tickets 1019,
// #salesglider-insight-ai-replies 11:07:01 AM ET Oct 27 2026. SmartLead stored
// reply_message.text "" and preview_text "" with this HTML. The webhook
// skipped it; the inbox poller posted the tags as an Unclassified reply.
const RICHARD_OWEN_HTML =
  '<html><head> <meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div style="font-family:Calibri,Arial,Helvetica,sans-serif; font-size:12pt; color:rgb(0,0,0)"><br></div></body></html>';

// Allyson Bennett, #bcp-ai-replies, 9:07 AM ET Oct 27 2026.
const US_ASCII_HTML =
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=us-ascii"></head><body>'
  + '<div style="font-family:Calibri,Arial,Helvetica,sans-serif; font-size:12pt; color:rgb(0,0,0)"><br></div>'
  + '</body></html>';

// Junie Z Baratti, #bcp-ai-replies, 9:46 AM ET Oct 27 2026.
const APTOS_HTML =
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>'
  + '<div style="font-family:Aptos,Aptos_EmbeddedFont,Aptos_MSFontService,Calibri,Helvetica,sans-serif; font-size:12pt; color:rgb(0,0,0)">'
  + '<br></div></body></html>';

const OP_NBSP_HTML =
  '<html><body><p class="MsoNormal"><o:p>&nbsp;</o:p></p></body></html>';

const REAL_HTML_TEXT =
  'Yes, Tuesday at 2pm works. Please send the one-pager before the call so I can review the numbers with my partner and confirm we should book it.';

const REAL_HTML =
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>'
  + `<div style="font-family:Calibri,Arial,Helvetica,sans-serif; font-size:12pt; color:rgb(0,0,0)">${REAL_HTML_TEXT}</div>`
  + '</body></html>';

function pollerHistory(replyBody, extra = []) {
  return {
    history: [
      { type: 'SENT', email_body: 'Quick note on the tickets.', time: '2026-10-27T15:06:00.000Z' },
      ...extra,
      {
        type: 'REPLY',
        from: 'richard@newbraunfelselectric.com',
        email_body: replyBody,
        time: '2026-10-27T15:07:01.000Z',
      },
    ],
  };
}

test('poller does not turn an empty Outlook shell into the reply text', () => {
  for (const html of [RICHARD_OWEN_HTML, US_ASCII_HTML, APTOS_HTML, OP_NBSP_HTML, SHELL]) {
    const thread = pollerHistory(html);
    assert.strictEqual(latestInboundFromHistory(thread, 'richard@newbraunfelselectric.com'), '');
    assert.strictEqual(latestInboundReplyIsBlank(thread), true);
    assert.strictEqual(cleanInboundOrRaw(html), '');
  }
});

test('poller still returns an older real reply when the newest message is a blank shell', () => {
  const older = [{
    type: 'REPLY',
    from: 'richard@newbraunfelselectric.com',
    email_body: 'Yes, send the one-pager.',
    time: '2026-10-20T10:00:00.000Z',
  }];
  const thread = pollerHistory(RICHARD_OWEN_HTML, older);
  assert.strictEqual(
    latestInboundFromHistory(thread, 'richard@newbraunfelselectric.com'),
    'Yes, send the one-pager.',
  );
});

test('poller returns the full text of an HTML-only reply', () => {
  const thread = pollerHistory(REAL_HTML);
  const text = latestInboundFromHistory(thread, 'richard@newbraunfelselectric.com');
  assert.strictEqual(text, REAL_HTML_TEXT);
  assert.doesNotMatch(text, /<html|<div|font-family|charset/i);
  assert.strictEqual(latestInboundReplyIsBlank(thread), false);
});

test('Richard Owen payload is a blank inbound on the webhook and category paths', () => {
  const payload = {
    event_type: 'EMAIL_REPLY',
    preview_text: '',
    reply_message: { text: '', preview_text: '', html: RICHARD_OWEN_HTML },
  };
  assert.strictEqual(payloadInboundIsBlank(payload), true);
  assert.strictEqual(payloadInboundIsBlank({
    event_type: 'LEAD_CATEGORY_UPDATED',
    reply_message: { text: '', html: US_ASCII_HTML },
    preview_text: '',
  }), true);
  assert.strictEqual(payloadInboundIsBlank({
    event_type: 'LEAD_CATEGORY_UPDATED',
    reply_message: { text: '', html: APTOS_HTML },
  }), true);
  assert.strictEqual(payloadInboundIsBlank({ event_type: 'LEAD_CATEGORY_UPDATED' }), false);
  assert.strictEqual(payloadInboundIsBlank({
    reply_message: { text: '', html: REAL_HTML },
  }), false);
  const disclaimer = '<html><body><p>Disclaimer The information contained in this communication is confidential and intended solely for the recipient. This email has been scanned for viruses and malware and archived by Mimecast.</p></body></html>';
  assert.strictEqual(payloadInboundIsBlank({ reply_message: { text: '', html: disclaimer } }), false);
  assert.ok(cleanInboundOrRaw(disclaimer).includes('Mimecast'));
});

test('poller records empty_inbound before it can classify or alert', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/smartlead-poller.js'), 'utf8');
  const skipAt = src.indexOf("return { skipped: 'empty_inbound' }");
  const recordAt = src.indexOf('await recordSuppressedReply');
  const classifyAt = src.indexOf('result = await classifyAndDraft');
  const cardAt = src.indexOf('await postProspectSlackCard');
  assert.ok(skipAt > 0 && recordAt > skipAt && classifyAt > skipAt && cardAt > skipAt);
  const fn = src.slice(src.indexOf('function latestInboundFromHistory'), src.indexOf('function latestInboundFromRow'));
  assert.match(fn, /cleanInboundOrRaw/);
  assert.doesNotMatch(fn, /String\(raw\)\.trim\(\)/);
});

test('category and reply webhooks skip a payload that is only an HTML shell', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/webhooks.js'), 'utf8');
  const err = src.indexOf('No usable reply body from webhook or message-history');
  const gate = src.lastIndexOf('payloadInboundIsBlank(payload)', err);
  const returned = src.indexOf('return;', gate);
  assert.ok(gate > 0 && returned > gate && returned < err);
  const between = src.slice(gate, returned);
  assert.match(between, /empty_inbound/);
  assert.ok(!/postError/.test(between));
  assert.match(src, /reason: 'empty_inbound'/);
  assert.doesNotMatch(src, /stripHtmlToText\(fallbackMsg\) \|\| fallbackMsg/);
});

test('unclassified alert strips HTML and skips a shell that has no text', async () => {
  assert.strictEqual(compactOtherAlertText({
    leadName: 'Richard Owen',
    platform: 'smartlead',
    inboundMessage: RICHARD_OWEN_HTML,
  }), null);
  assert.strictEqual(compactOtherAlertText({
    leadName: 'Allyson Bennett',
    platform: 'smartlead',
    inboundMessage: US_ASCII_HTML,
  }), null);
  assert.strictEqual(compactOtherAlertText({
    leadName: 'Junie Z Baratti',
    platform: 'smartlead',
    inboundMessage: APTOS_HTML,
  }), null);

  let constructed = 0;
  class WebClient {
    constructor() { constructed += 1; }
    chat = { postMessage: async () => { throw new Error('must not post'); } };
  }
  const res = await postOtherAlert({
    clientId: 'salesglider',
    client: { active: true, slack_bot_token: 'xoxb-test', slack_channel_id: 'C-insight' },
    platform: 'smartlead',
    leadName: 'Richard Owen',
    inboundMessage: RICHARD_OWEN_HTML,
  }, { WebClient });
  assert.strictEqual(res, null);
  assert.strictEqual(constructed, 0);
});

test('HTML-only reply with real text is shown in full, with no tags', async () => {
  const alert = compactOtherAlertText({
    leadName: 'Pat Example',
    platform: 'smartlead',
    inboundMessage: REAL_HTML,
  });
  assert.match(alert, new RegExp(REAL_HTML_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(alert, /<html|<div|font-family|charset/i);

  let posted = '';
  class WebClient {
    constructor() {}
    chat = {
      postMessage: async ({ text }) => {
        posted = text;
        return { ok: true };
      },
    };
  }
  await postOtherAlert({
    client: { active: true, slack_bot_token: 'xoxb-test', slack_channel_id: 'C1' },
    platform: 'smartlead',
    leadName: 'Pat Example',
    inboundMessage: REAL_HTML,
  }, { WebClient });
  assert.match(posted, /Tuesday at 2pm works/);
  assert.match(posted, /confirm we should book it/);
  assert.doesNotMatch(posted, /<html|<div|font-family/i);

  const blocks = buildConversationBlocks({
    lastOutboundMessage: 'Want to look at the tickets?',
    inboundMessage: REAL_HTML,
    draft: '',
  });
  const shown = JSON.stringify(blocks);
  assert.match(shown, /Yes, Tuesday at 2pm works\. Please send the one-pager before the call so I can review the numbers with my partner and confirm we should book it\./);
  assert.doesNotMatch(shown, /<html|<div|font-family|charset/i);

  const shellCard = JSON.stringify(buildConversationBlocks({
    lastOutboundMessage: 'Want to look at the tickets?',
    inboundMessage: RICHARD_OWEN_HTML,
    draft: '',
  }));
  assert.doesNotMatch(shellCard, /<html|<div|font-family|charset=|&lt;html/i);
});

test('HeyReach skips an empty HTML shell and keeps a real HTML message', () => {
  const shell = latestInbound([
    { sender: 'ME', body: 'Following up.', createdAt: '2026-10-27T15:00:00.000Z' },
    { isReply: true, body: RICHARD_OWEN_HTML, createdAt: '2026-10-27T15:07:01.000Z' },
  ]);
  assert.strictEqual(shell.blank, true);
  assert.strictEqual(shell.text, '');

  const real = latestInbound([
    { isReply: true, body: REAL_HTML, createdAt: '2026-10-27T15:07:01.000Z' },
  ]);
  assert.strictEqual(real.text, REAL_HTML_TEXT);
  assert.strictEqual(real.blank, undefined);

  const plain = latestInbound([
    { isReply: true, message: 'Tuesday works for me.', createdAt: '2026-10-27T15:07:01.000Z' },
  ]);
  assert.strictEqual(plain.text, 'Tuesday works for me.');

  const src = fs.readFileSync(path.join(__dirname, '../src/services/heyreach-poller.js'), 'utf8');
  const skipAt = src.indexOf("return { skipped: 'empty_inbound' }");
  const recordAt = src.indexOf('await recordSuppressedReply');
  assert.ok(skipAt > 0 && recordAt > skipAt);
});
