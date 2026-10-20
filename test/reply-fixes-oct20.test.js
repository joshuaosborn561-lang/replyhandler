const test = require('node:test');
const assert = require('node:assert');
const { positiveIntentFromText, applyPositiveIntentGuard } = require('../src/utils/positive-intent');
const { extractLeadPhone } = require('../src/utils/lead-phone');
const { shouldAlertOther, compactOtherAlertText } = require('../src/services/other-alert');
const { pickLeadCampaign } = require('../src/services/smartlead');
const h = require('../src/utils/smartlead-webhook-helpers');

const OUTLOOK = '<html><head><meta charset="utf-8"><style><!-- @font-face {font-family:Aptos} p.MsoNormal {margin:0in; font-size:12.0pt} --></style></head><body><div class="WordSection1"><p class="MsoNormal">Hi Josh,</p><p class="MsoNormal">This does sounds it could be worthwhile and I’d be interested in hearing more.</p><p class="MsoNormal">Let me know a couple days/times this week or next that work to have a call.</p></div></body></html>';

test('Outlook HTML reply strips to plain text with no CSS', () => {
  const t = h.cleanInboundReply(OUTLOOK);
  assert.match(t, /interested in hearing more/);
  assert.doesNotMatch(t, /font-family|MsoNormal|@font-face|margin/);
});

test('CSS-polluted text part falls back to html', () => {
  const t = h.parseInboundFromPayload({ text: 'p.MsoNormal {font-family:Aptos} mso-style', html: OUTLOOK }, {});
  assert.match(h.cleanInboundReply(t), /couple days\/times/);
});

test('positive-intent guard upgrades OTHER / NOT_INTERESTED, never downgrades', () => {
  const txt = h.cleanInboundReply(OUTLOOK);
  assert.strictEqual(positiveIntentFromText(txt), 'INTERESTED');
  assert.strictEqual(applyPositiveIntentGuard('OTHER', txt).classification, 'INTERESTED');
  assert.strictEqual(applyPositiveIntentGuard('NOT_INTERESTED', txt).classification, 'INTERESTED');
  assert.strictEqual(applyPositiveIntentGuard('OOO', txt).classification, 'OOO');
  assert.strictEqual(applyPositiveIntentGuard('MEETING_PROPOSED', txt).classification, 'MEETING_PROPOSED');
  assert.strictEqual(positiveIntentFromText('Not interested, please remove me'), null);
  assert.strictEqual(positiveIntentFromText('Thanks, got it.'), null);
  assert.strictEqual(positiveIntentFromText("Sure, let's set up a call"), 'INTERESTED');
});

test('OTHER gets a compact alert, other suppressions do not', () => {
  assert.ok(shouldAlertOther('not_interested_channel', 'OTHER'));
  assert.ok(!shouldAlertOther('ooo', 'OOO'));
  assert.ok(!shouldAlertOther('not_interested', 'NOT_INTERESTED'));
  const t = compactOtherAlertText({ leadName: 'A B', platform: 'smartlead', inboundMessage: 'x'.repeat(500) });
  assert.ok(t.length < 450);
  assert.doesNotMatch(t, /📱/);
});

test('lead map id is never used as lead id', () => {
  assert.strictEqual(h.normalizeSmartleadLeadId({ sl_email_lead_id: null, sl_email_lead_map_id: 3875094441 }), null);
  assert.strictEqual(h.normalizeSmartleadLeadId({ sl_email_lead_id: '42' }), '42');
});

test('campaign comes from Smartlead lead membership when payload disagrees', () => {
  assert.strictEqual(pickLeadCampaign('111', ['222']), '222');
  assert.strictEqual(pickLeadCampaign('111', ['111', '222']), '111');
  assert.strictEqual(pickLeadCampaign(null, ['5', '6']), '6');
  assert.strictEqual(pickLeadCampaign('7', []), '7');
});

test('lead phone comes from Smartlead phone_number / custom fields', () => {
  assert.strictEqual(extractLeadPhone({ phone_number: '+1 555 010 0199' }), '+1 555 010 0199');
  assert.strictEqual(extractLeadPhone({}, { custom_fields: { 'Mobile Phone': '555-010-0123' } }), '555-010-0123');
  assert.strictEqual(extractLeadPhone({ phone_number: '' }, null, { phone: 'n/a' }), '');
});
