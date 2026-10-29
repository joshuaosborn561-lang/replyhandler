const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ctxUtil = require('../src/utils/followup-card-context');
const { loadFollowupContext } = require('../src/services/followup-card-context');
const text = require('../src/utils/followup-sequence-text');
const ghostText = require('../src/utils/ghosted-meeting-text');
const seq = require('../src/services/followup-sequence');
const { buildDraftApprovalCard } = require('../src/services/slack');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const flat = (blocks) => JSON.stringify(blocks);

const LONG_SENT = `Hi Pat, quick question about your IT costs. ${'We help firms like yours cut spend without switching vendors. '.repeat(6)}Worth a look?`;
const LONG_REPLY = `Sure, send over some times. ${'We are looking at this for next quarter and our team is stretched thin right now. '.repeat(5)}`;

const ICP_OK = {
  status: 'qualified', confidence: 91, reason: 'IT services firm, fits the ICP',
  decision_maker: { status: 'yes', title: 'Owner', reason: 'owner/executive' },
};

function ctx(over = {}) {
  return ctxUtil.buildFollowupContext({
    clientName: 'Acme Co',
    lead: { name: 'Pat Prospect', title: 'Owner', company: 'Prospect IT', phone: '+15555550100', email: 'pat@prospect.example' },
    replyText: LONG_REPLY,
    lastSentText: LONG_SENT,
    campaign: 'Q4 IT Owners (4242)',
    offer: 'lowering IT spend for small firms',
    meeting: null,
    links: { replyCard: 'https://slack.example/archives/C1/p1', smartlead: 'https://app.smartlead.ai/app/master-inbox?campaign_lead_map_id=99' },
    icp: ICP_OK,
    ...over,
  });
}

test('offer: manual row, then client ICP, then campaign copy; none means no offer', () => {
  const icpProfile = { offer: ['outbound for HVAC shops.'] };
  assert.deepEqual(ctxUtil.pickOffer({ manualOffer: 'a manual offer', icpProfile, copyOffer: 'from copy' }), { text: 'a manual offer', source: 'manual' });
  assert.deepEqual(ctxUtil.pickOffer({ icpProfile, copyOffer: 'from copy' }), { text: 'outbound for HVAC shops', source: 'client_icp' });
  assert.deepEqual(ctxUtil.pickOffer({ icpProfile: JSON.stringify(icpProfile) }), { text: 'outbound for HVAC shops', source: 'client_icp' });
  assert.deepEqual(ctxUtil.pickOffer({ icpProfile: { offer: [] }, copyOffer: 'from copy.' }), { text: 'from copy', source: 'campaign_copy' });
  assert.deepEqual(ctxUtil.pickOffer({ icpProfile: null, copyOffer: null }), { text: '', source: 'none' });
});

test('the offer line is omitted when no offer exists, and no placeholder ever shows', () => {
  const none = flat(ctxUtil.followupContextBlocks(ctx({ offer: '' })));
  assert.doesNotMatch(none, /Offer/);
  assert.doesNotMatch(none, /offer not found/i);
  assert.match(flat(ctxUtil.followupContextBlocks(ctx())), /\*Offer:\* lowering IT spend/);
  for (const f of ['src/utils/followup-sequence-text.js', 'src/services/followup-sequence.js', 'src/utils/followup-card-context.js']) {
    assert.doesNotMatch(read(f).replace(/\/\/.*$/gm, ''), /offer not found in campaign copy/i, f);
  }
  const call = text.callCardScript('call_day0', { firstName: 'Pat', callerName: '(name)', clientName: 'Acme Co', offerLine: null });
  assert.equal(call.opening, 'Hey Pat, this is (name) with Acme Co. We emailed you recently.');
  assert.doesNotMatch(JSON.stringify(call), /offer not found|\[/);
});

test('top block: bold client, lead name/title/company/phone/email, quoted reply, short last send, campaign, links', () => {
  const [top] = ctxUtil.followupContextBlocks(ctx());
  const t = top.text.text;
  assert.ok(t.startsWith('*Acme Co*'), 'client name bold, first');
  assert.match(t, /\*Pat Prospect\* · Owner · Prospect IT/);
  assert.match(t, /📞 \+15555550100 · ✉️ pat@prospect\.example/);
  assert.match(t, /\*Campaign:\* Q4 IT Owners \(4242\)/);
  assert.match(t, /💬 \*They replied:\*\n>Sure, send over some times\./);
  assert.match(t, /📤 \*We last sent:\*\n>Hi Pat, quick question/);
  assert.match(t, /<https:\/\/slack\.example\/archives\/C1\/p1\|Original reply card>/);
  assert.match(t, /<https:\/\/app\.smartlead\.ai\/app\/master-inbox\?campaign_lead_map_id=99\|Smartlead thread>/);
  const c = ctx();
  assert.ok(c.lastSentExcerpt.length <= ctxUtil.SENT_EXCERPT_MAX && c.lastSentExcerpt.endsWith('…'), 'last send is a short excerpt');
  assert.ok(c.replyExcerpt.length <= ctxUtil.REPLY_EXCERPT_MAX);
  assert.ok(top.text.text.length < 3000);
});

test('meeting or no-show time shows only when there is one', () => {
  const when = ctxUtil.formatMeetingTime('2026-10-27T19:00:00Z', 'America/Chicago');
  assert.match(when, /Tue, Oct 27, 2:00 PM CDT/);
  const withMeeting = flat(ctxUtil.followupContextBlocks(ctx({ meeting: { label: 'No-show', text: when } })));
  assert.match(withMeeting, /🗓️ \*No-show:\* Tue, Oct 27, 2:00 PM CDT/);
  assert.doesNotMatch(flat(ctxUtil.followupContextBlocks(ctx())), /🗓️/);
});

test('ICP fit and decision maker come from the stored verdict, same wording as reply cards', () => {
  const [, verdict] = ctxUtil.followupContextBlocks(ctx());
  assert.equal(verdict.text.text, '🎯 91% qualified: IT services firm, fits the ICP\n👤 Decision maker: Yes, owner/executive (Owner)');
  const notDm = ctxUtil.followupContextBlocks(ctx({
    icp: { status: 'qualified', confidence: 88, reason: 'fits', decision_maker: { status: 'no', title: 'Account Executive', reason: 'sales role' } },
  }))[1].text.text;
  assert.match(notDm, /Not a fit: company fits \(88% fits\) but the person replying is not a decision maker/);
  assert.match(notDm, /Decision maker: No, sales role \(Account Executive\)/);
  const none = ctxUtil.followupContextBlocks(ctx({ icp: null }))[1].text.text;
  assert.match(none, /🎯 ICP: not graded on the original card/);
  assert.match(none, /👤 Decision maker: unknown \(title not found\)/);
});

test('no model calls: the context code never imports a grader or LLM', () => {
  for (const f of ['src/utils/followup-card-context.js', 'src/services/followup-card-context.js']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /generative-ai|gemini|resolveReplyIcp|evaluateIcp|gradeWithGemini|anthropic/i, f);
  }
});

test('company falls back to the work-email or website domain, never free mail', () => {
  assert.equal(ctxUtil.companyFor({ company: 'Prospect IT' }), 'Prospect IT');
  assert.equal(ctxUtil.companyFor({ email: 'pat@prospect.example' }), 'prospect.example');
  assert.equal(ctxUtil.companyFor({ email: 'pat@gmail.com', website: 'https://www.site.example/about' }), 'site.example');
  assert.equal(ctxUtil.companyFor({ email: 'pat@gmail.com' }), '');
});

test('Smartlead link: master inbox deep link with the map id, else the campaign page, else none', () => {
  assert.equal(ctxUtil.smartleadThreadUrl({ campaignId: '4242', mapId: '99' }), 'https://app.smartlead.ai/app/master-inbox?campaign_lead_map_id=99');
  assert.equal(ctxUtil.smartleadThreadUrl({ campaignId: '4242' }), 'https://app.smartlead.ai/app/email-campaign/4242/analytics');
  assert.equal(ctxUtil.smartleadThreadUrl({ campaignId: 'test-campaign' }), null);
});

// ─── call card ───────────────────────────────────────────────────────────────

function callCard(over = {}) {
  const args = { firstName: 'Pat', callerName: text.callerName(), clientName: 'Acme Co', offerLine: 'lowering IT spend for small firms' };
  return {
    label: 'Day 0 call', leadName: 'Pat Prospect', phone: '+15555550100', clientName: 'Acme Co',
    script: text.callScript(args), voicemail: text.voicemailScript('call_day0', args),
    scriptParts: text.callCardScript('call_day0', args), context: ctx(), ...over,
  };
}

test('call and voicemail are one block: the shared opening line appears once', () => {
  const blocks = seq.buildCallCardBlocks(callCard(), 'step-1');
  const script = blocks.filter((b) => b.type === 'section' && /Say this/.test(b.text.text));
  assert.equal(script.length, 1);
  const t = script[0].text.text;
  assert.match(t, /\*Say this:\*\n>Hey Pat, this is \(name\) with Acme Co\. We emailed you about lowering IT spend for small firms\./);
  assert.match(t, /\*If they answer, then say:\*\n>Did you still want to take a peek/);
  assert.match(t, /\*If it goes to voicemail, then say:\*\n>I'll follow up by email with a couple of times/);
  assert.equal(t.split('We emailed you about').length - 1, 1, 'opening is not repeated for the voicemail');
  assert.ok(!blocks.some((b) => b.type === 'section' && /If it goes to voicemail, say:/.test(b.text?.text || '')));
});

test('a call with no voicemail says so, and the ghost call merges too', () => {
  const day1 = text.callCardScript('call_day1', { firstName: 'Pat', callerName: '(name)', clientName: 'Acme Co', offerLine: 'x' });
  assert.equal(day1.ifVoicemail, null);
  const t = flat(seq.buildCallCardBlocks(callCard({ scriptParts: day1 }), 's'));
  assert.match(t, /No voicemail on this call/);
  const ghost = ghostText.ghostCallCardScript({ firstName: 'Pat', callerName: '(name)', clientName: 'Acme Co' });
  assert.match(ghost.opening, /missed each other\.$/);
  assert.match(ghost.ifVoicemail, /email with a couple of new times/);
  const day6 = text.callCardScript('call_day6', { firstName: 'Pat', callerName: '(name)', clientName: 'Acme Co', offerLine: 'x', proofPoint: 'We cut costs 40%' });
  assert.match(day6.ifVoicemail, /^Last call from me\. We cut costs 40%\./);
});

test('the full email we sent and their full reply sit directly under the script, before the buttons', () => {
  const blocks = seq.buildCallCardBlocks(callCard(), 'step-1');
  const idx = (re) => blocks.findIndex((b) => re.test(b.text?.text || ''));
  const say = idx(/Say this/);
  const sent = idx(/Full email we sent/);
  const reply = idx(/Their full reply/);
  assert.ok(say >= 0 && sent === say + 1, 'sent email is right under the script');
  assert.ok(reply > sent);
  assert.ok(blocks.findIndex((b) => b.type === 'actions') > reply, 'buttons come after');
  assert.ok(flat(blocks).includes('We are looking at this for next quarter'), 'reply is in full');
  assert.equal((flat(blocks).match(/Worth a look\?/g) || []).length, 1, 'the top is only an excerpt, the full email appears once');
});

test('short texts are still shown in full under the script', () => {
  const short = ctx({ replyText: 'Yes, call me tomorrow.', lastSentText: 'Hi Pat, worth a quick look?' });
  const t = flat(seq.buildCallCardBlocks(callCard({ context: short }), 's'));
  assert.match(t, /Full email we sent/);
  assert.match(t, /Their full reply/);
});

test('call card: context is at the top, under the header, and the buttons still work', () => {
  const blocks = seq.buildCallCardBlocks(callCard(), 'step-1');
  assert.equal(blocks[0].type, 'header');
  assert.ok(blocks[1].text.text.startsWith('*Acme Co*'));
  assert.match(blocks[2].text.text, /🎯 91% qualified/);
  const actions = blocks.find((b) => b.type === 'actions').elements;
  assert.equal(actions.length, 5);
  const done = seq.buildCallCardBlocks(callCard(), 'step-1', { outcome: 'booked', outcomeBy: 'U1' });
  assert.ok(!done.some((b) => b.type === 'actions'));
  assert.ok(flat(done).includes('*Acme Co*'), 'context survives the outcome re-render');
});

test('a call card stored before this change still renders', () => {
  const old = { label: 'Day 0 call', leadName: 'Pat', phone: '+1555', clientName: 'Acme', script: 's', voicemail: 'v', campaignDisplay: 'C (1)', permalink: 'https://x.example/p' };
  const t = flat(seq.buildCallCardBlocks(old, 'step-1'));
  assert.match(t, /Say this/);
  assert.match(t, /If it goes to voicemail, say:/);
  assert.match(t, /Original reply card/);
});

// ─── email / follow-up / rebook cards ────────────────────────────────────────

test('follow-up email card: context under the header, ICP shown once, WILL SEND and buttons intact', () => {
  const card = buildDraftApprovalCard({
    replyId: 'r1', leadName: 'Pat Prospect', leadEmail: 'pat@prospect.example', platform: 'smartlead',
    classification: 'FOLLOW_UP', draft: 'Hey Pat, any thoughts?', reasoning: 'Sequence · Day 3 email: any thoughts',
    inboundMessage: LONG_REPLY, campaignDisplay: 'Q4 IT Owners (4242)', leadIcpVerdict: { status: 'unknown', reason: 'checking' },
    followupContext: ctx(),
  });
  const b = card.blocks;
  assert.equal(b[0].type, 'header');
  // Josh, Oct 29 2026: one-line header, then contact, message, draft, context, and the buttons stay at the bottom.
  assert.match(b[0].text.text, /Pat Prospect/);
  assert.match(b[0].text.text, /Acme Co/);
  assert.equal(b[b.length - 1].type, 'actions', 'buttons stay at the bottom');
  assert.equal(b[b.length - 2].type, 'context', 'context line sits right above the buttons');
  const all = flat(b);
  assert.match(all, /Decision maker: Yes/);
  assert.equal((all.match(/🎯/g) || []).length, 1, 'ICP appears once');
  assert.match(all, /WILL SEND/);
  assert.match(all, /approve_reply/);
});

test('rebook / no-show card carries the no-show time', () => {
  const noShow = ctxUtil.formatMeetingTime('2026-10-27T19:00:00Z', 'America/Chicago');
  const card = buildDraftApprovalCard({
    replyId: 'r2', leadName: 'Pat Prospect', platform: 'smartlead', classification: 'FOLLOW_UP',
    draft: 'Hey Pat, looks like we missed each other.', inboundMessage: 'x',
    followupContext: ctx({ meeting: { label: 'No-show', text: noShow } }),
  });
  assert.match(flat(card.blocks), /🗓️ No-show: Tue, Oct 27, 2:00 PM CDT/);
});

test('a FOLLOW_UP card without context is unchanged', () => {
  const card = buildDraftApprovalCard({
    replyId: 'r3', leadName: 'Pat', platform: 'smartlead', classification: 'FOLLOW_UP', draft: 'd', inboundMessage: 'x',
    leadIcpVerdict: ICP_OK,
  });
  assert.match(flat(card.blocks), /91% qualified/);
});

// ─── loading the stored facts ────────────────────────────────────────────────

const SOURCE = {
  platform: 'smartlead', campaign_id: '4242', campaign_name: 'Q4 IT Owners', lead_name: 'Pat', lead_full_name: 'Pat Prospect',
  lead_email: 'pat@prospect.example', lead_website: 'https://prospect.example', inbound_message: LONG_REPLY,
  sent_reply: LONG_SENT, icp_verdict: { ...ICP_OK }, slack_message_ts: '1.2',
};

test('loadFollowupContext reads stored fields: title from the decision-maker verdict, sent_reply, no-show time', async () => {
  const c = await loadFollowupContext({
    client: { name: 'Acme Co', smartlead_api_key: 'k', digest_timezone: 'America/Chicago' },
    source: SOURCE, phone: '+15555550100', offer: 'lowering IT spend', permalink: 'https://slack.example/p1',
    ghost: { meetingStart: '2026-10-27T19:00:00Z', reason: 'no_transcript' },
    deps: { smartlead: { lookupLeadByEmail: async () => ({ lead: { lead_campaign_data: [{ campaign_id: 4242, campaign_lead_map_id: 777 }] } }) } },
  });
  assert.equal(c.lead.title, 'Owner');
  assert.equal(c.lead.company, 'prospect.example');
  assert.equal(c.lead.name, 'Pat Prospect');
  assert.equal(c.campaign, 'Q4 IT Owners (4242)');
  assert.equal(c.lastSent, LONG_SENT.trim());
  assert.equal(c.meeting.label, 'No-show');
  assert.match(c.meeting.text, /Oct 27/);
  assert.equal(c.links.replyCard, 'https://slack.example/p1');
  assert.equal(c.links.smartlead, 'https://app.smartlead.ai/app/master-inbox?campaign_lead_map_id=777');
  assert.equal(c.icp.decision_maker.title, 'Owner');
});

test('stored lead_title and lead_company win; a failed Smartlead lookup falls back to the campaign link; placeholder replies are dropped', async () => {
  const c = await loadFollowupContext({
    client: { name: 'Acme Co', smartlead_api_key: 'k' },
    source: { ...SOURCE, lead_title: 'Managing Partner', lead_company: 'Prospect IT LLC', inbound_message: '(no new reply from prospect)', sent_reply: null, thread_context: { history: [
      { type: 'SENT', email_body: 'First email we sent', time: '2026-10-20T10:00:00Z', stats_id: 's1', message_id: 'm1' },
    ] } },
    phone: '', permalink: null,
    deps: { smartlead: { lookupLeadByEmail: async () => { throw new Error('boom'); } } },
  });
  assert.equal(c.lead.title, 'Managing Partner');
  assert.equal(c.lead.company, 'Prospect IT LLC');
  assert.equal(c.reply, '');
  assert.equal(c.links.smartlead, 'https://app.smartlead.ai/app/email-campaign/4242/analytics');
  assert.equal(c.links.replyCard, null);
  const t = flat(ctxUtil.followupContextBlocks(c));
  assert.doesNotMatch(t, /They replied/);
  assert.match(t, /📞 no phone/);
});

// ─── wiring ──────────────────────────────────────────────────────────────────

test('wiring: sequence call + email cards and the follow-up runner pass the context; title/company are stored', () => {
  const s = read('src/services/followup-sequence.js');
  assert.match(s, /context,\n\s+mention: mentionIds/);
  assert.match(s, /followupContext: followupContext \|\| undefined/);
  assert.match(read('src/services/follow-up-runner.js'), /followupContext: followupContext \|\| undefined/);
  assert.match(read('src/services/slack-reply-post.js'), /persistLeadTitleCompany\(dbClient, replyId/);
  assert.match(read('scripts/run-migrations.js'), /050_lead_title_company\.sql/);
  assert.match(read('migrations/050_lead_title_company.sql'), /lead_title TEXT/);
  assert.match(read('schema.sql'), /lead_company TEXT/);
});

test('the offer used by the scripts and the card is config first, copy last, empty when none', async () => {
  const src = { campaign_id: '1', platform: 'smartlead', thread_context: null };
  const copy = (r) => ({ resolveCopy: async () => r });
  const withIcp = { icp_profile: { offer: ['outbound for HVAC shops'] } };
  assert.equal((await seq.offerFor(withIcp, src, copy({ offerLine: 'from the copy', source: 'campaign_copy' }))).offerLine, 'outbound for HVAC shops');
  assert.equal((await seq.offerFor(withIcp, src, copy({ offerLine: 'hand entered', source: 'manual' }))).offerLine, 'hand entered');
  assert.equal((await seq.offerFor({}, src, copy({ offerLine: 'from the copy', source: 'campaign_copy' }))).offerLine, 'from the copy');
  assert.equal((await seq.offerFor({}, src, copy({ offerLine: null, source: 'none' }))).offerLine, null);
});
