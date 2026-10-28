/**
 * Day-30 nurture: pure helpers plus the HubSpot and Smartlead clients with a
 * mocked fetch. No database, no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const t = require('../src/utils/nurture-day30-text');
const hs = require('../src/services/hubspot-nurture');
const sl = require('../src/services/smartlead-nurture');

// ─── Flags ────────────────────────────────────────────────────────────────────

test('every flag is off with an empty environment', () => {
  assert.equal(t.enabled({}), false);
  assert.equal(t.hubspotSyncEnabled({}), false);
  assert.equal(t.postEnabled({}), false);
  assert.equal(t.sendEnabled({}), false);
  assert.deepEqual(t.nurtureClientIds({}), []);
  assert.equal(t.enrollStart({}), null);
  for (const v of ['true', '1', 'on', 'YES']) assert.equal(t.enabled({ NURTURE_ENABLED: v }), true);
  for (const v of ['false', '0', 'off', '']) assert.equal(t.enabled({ NURTURE_ENABLED: v }), false);
});

test('defaults: #nurture channel, Josh and Cayden approve, campaign 3122546, 5 cards a day', () => {
  assert.equal(t.nurtureChannel({}), 'C0BHBDTMRFY');
  assert.deepEqual(t.approverIds({}), ['U0AAX2XFJE7', 'U0BL8JT75KN']);
  assert.equal(t.isApprover('U0BL8JT75KN', {}), true);
  assert.equal(t.isApprover('UNOBODY', {}), false);
  assert.equal(t.isApprover('', {}), false);
  assert.equal(t.smartleadCampaignId({}), '3122546');
  assert.equal(t.maxCardsPerDay({}), 5);
  assert.equal(t.day30DelayDays({}), 30);
});

test('only day30 has copy; day90 and quarterly are disabled', () => {
  assert.deepEqual([...t.TOUCH_KINDS_ENABLED], ['day30']);
  assert.deepEqual([...t.TOUCH_KINDS_DISABLED], ['day90', 'quarterly']);
});

// ─── Copy ─────────────────────────────────────────────────────────────────────

test('the Day 30 draft passes its own checks and carries the approved lines', () => {
  const d = t.composeDay30Draft({ leadName: 'Pat Smith', repliedAt: new Date('2026-10-27T17:00:00Z') });
  assert.equal(d.subject, 'Pat?');
  assert.match(d.body, /^Hey Pat, circling back on your reply from Oct 27\./);
  assert.ok(d.body.includes(t.GENERAL_PROOF));
  assert.ok(d.body.includes(t.GUARANTEE));
  assert.ok(d.body.endsWith('Josh Osborn'));
  assert.deepEqual(t.validateDay30Draft({ ...d, leadName: 'Pat Smith' }), { ok: true, errors: [] });
});

test('validation rejects dashes, free offers, AirPods, placeholders, long copy, missing sign-off', () => {
  const ok = t.composeDay30Draft({ leadName: 'Pat' });
  const bad = (over) => t.validateDay30Draft({ ...ok, ...over, leadName: 'Pat' }).errors;
  assert.ok(bad({ body: `${ok.body.replace('Worth', 'Worth \u2014')}` }).includes('dash'));
  assert.ok(bad({ body: ok.body.replace('Worth a look?', 'Free proof of concept?') }).includes('free_poc'));
  assert.ok(bad({ body: ok.body.replace('Worth a look?', 'Want AirPods?') }).includes('airpods_or_tickets'));
  assert.ok(bad({ body: ok.body.replace('Pat', '{first}') }).includes('placeholder'));
  assert.ok(bad({ body: `${'word '.repeat(120)}\n\n${ok.body}` }).includes('too_long'));
  assert.ok(bad({ body: ok.body.replace('Josh Osborn', 'Josh') }).includes('no_signature'));
  assert.ok(bad({ body: ok.body.replace(t.GUARANTEE, 'We are great.') }).includes('no_guarantee'));
  assert.ok(bad({ subject: '' }).includes('no_subject'));
});

test('a draft without a usable first name says "there" and is refused when the name is known', () => {
  const d = t.composeDay30Draft({ leadName: '' });
  assert.match(d.body, /^Hey there,/);
  assert.ok(t.validateDay30Draft({ ...d, leadName: 'Pat Smith' }).errors.includes('no_first_name'));
});

// ─── HubSpot ──────────────────────────────────────────────────────────────────

test('the four HubSpot properties match the spec', () => {
  const names = t.HUBSPOT_PROPERTIES.map((p) => p.name);
  assert.deepEqual(names, ['nurture_stage', 'nurture_next_touch_date', 'last_outreach_date', 'nurture_exit_reason']);
  const stage = t.HUBSPOT_PROPERTIES.find((p) => p.name === 'nurture_stage');
  assert.deepEqual(stage.options.map((o) => o.value), ['none', 'day30', 'day90', 'quarterly', 'paused', 'exited']);
  assert.equal(t.HUBSPOT_PROPERTIES.find((p) => p.name === 'nurture_next_touch_date').type, 'date');
});

test('property values for a lead: dates are YYYY-MM-DD, empties clear the field', () => {
  const lead = { stage: 'day30', next_touch_at: new Date('2026-11-27T15:00:00Z'), last_outreach_at: new Date('2026-10-28T15:00:00Z'), exit_reason: null };
  assert.deepEqual(t.hubspotPropsFor(lead), {
    nurture_stage: 'day30', nurture_next_touch_date: '2026-11-27', last_outreach_date: '2026-10-28', nurture_exit_reason: '',
  });
  assert.deepEqual(t.hubspotPropsFor({ stage: 'exited', exit_reason: 'unsubscribed' }), {
    nurture_stage: 'exited', nurture_next_touch_date: '', last_outreach_date: '', nurture_exit_reason: 'unsubscribed',
  });
  assert.equal(t.hubspotContactUrl('123', { HUBSPOT_PORTAL_ID: '999' }), 'https://app-na2.hubspot.com/contacts/999/record/0-1/123');
  assert.equal(t.hubspotContactUrl('', {}), null);
});

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = responses.shift() || { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  fn.calls = calls;
  return fn;
}

test('HubSpot client: finds a contact by email and PATCHes only the four properties', async () => {
  const fetchImpl = mockFetch([
    { status: 200, body: { results: [{ id: '77', properties: { company: 'Acme', mobilephone: '+1555' } }] } },
    { status: 200, body: {} },
  ]);
  const env = { HUBSPOT_ACCESS_TOKEN: 'test-token-not-real' };
  const c = await hs.findContactByEmail(' Pat@Acme.co ', { env, fetchImpl });
  assert.deepEqual(c, { id: '77', company: 'Acme', phone: '+1555' });
  assert.equal(fetchImpl.calls[0].body.filterGroups[0].filters[0].value, 'pat@acme.co');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer test-token-not-real');
  await hs.updateNurtureProperties('77', { stage: 'paused', exit_reason: 'positive_reply' }, { env, fetchImpl });
  const patch = fetchImpl.calls[1];
  assert.equal(patch.method, 'PATCH');
  assert.match(patch.url, /\/crm\/v3\/objects\/contacts\/77$/);
  assert.deepEqual(Object.keys(patch.body.properties).sort(),
    ['last_outreach_date', 'nurture_exit_reason', 'nurture_next_touch_date', 'nurture_stage']);
});

test('HubSpot client: no token fails closed, no contact returns null, errors carry status only', async () => {
  await assert.rejects(() => hs.findContactByEmail('a@b.co', { env: {}, fetchImpl: mockFetch([]) }), /HUBSPOT_ACCESS_TOKEN/);
  assert.equal(await hs.findContactByEmail('a@b.co', { env: { HUBSPOT_ACCESS_TOKEN: 'x' }, fetchImpl: mockFetch([{ status: 200, body: { results: [] } }]) }), null);
  await assert.rejects(
    () => hs.updateNurtureProperties('1', { stage: 'day30' }, { env: { HUBSPOT_ACCESS_TOKEN: 'secret-xyz' }, fetchImpl: mockFetch([{ status: 401, body: { message: 'nope' } }]) }),
    (err) => err.status === 401 && !/secret-xyz/.test(err.message));
});

test('property creation treats "already exists" as success and never runs without --apply', async () => {
  const r = await hs.createPropertyDefinition(hs.propertyDefinitions()[0], {
    env: { HUBSPOT_ACCESS_TOKEN: 'x' }, fetchImpl: mockFetch([{ status: 409, body: {} }]),
  });
  assert.equal(r, 'exists');
  const out = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'hubspot-nurture-properties.js')], {
    env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.match(out, /DRY RUN: nothing was created/);
  assert.match(out, /nurture_stage/);
});

// ─── Smartlead ────────────────────────────────────────────────────────────────

test('Smartlead: a sequence must render both approved fields in every step', async () => {
  const getSequence = async () => [{ subject: '{{nurture_subject}}', body: '<p>{{nurture_body}}</p>' }];
  assert.equal(await sl.sequenceUsesNurtureFields('k', 1, { getSequence }), true);
  assert.equal(await sl.sequenceUsesNurtureFields('k', 1, { getSequence: async () => [] }), false);
  assert.equal(await sl.sequenceUsesNurtureFields('k', 1, { getSequence: async () => [{ subject: 'Hi', body: 'generic' }] }), false);
  assert.equal(await sl.sequenceUsesNurtureFields('k', 1, {
    getSequence: async () => [{ subject: '{{nurture_subject}}', body: '{{nurture_body}}' }, { subject: 'Step 2', body: 'generic' }],
  }), false, 'a generic second step would send unapproved copy');
});

test('Smartlead pre-check: unsubscribed, already queued and active elsewhere block; errors fail closed', async () => {
  const lookup = (lead) => async () => ({ leadId: '9', lead });
  assert.deepEqual(await sl.checkLeadBeforeImport('k', 'a@b.co', 3122546, { lookup: async () => null }), { ok: true, leadId: null });
  assert.equal((await sl.checkLeadBeforeImport('k', 'a@b.co', 3122546, { lookup: lookup({ is_unsubscribed: true }) })).reason, 'unsubscribed');
  assert.equal((await sl.checkLeadBeforeImport('k', 'a@b.co', 3122546, {
    lookup: lookup({ lead_campaign_data: [{ campaign_id: 3122546, status: 'COMPLETED' }] }) })).reason, 'already_in_campaign');
  assert.equal((await sl.checkLeadBeforeImport('k', 'a@b.co', 3122546, {
    lookup: lookup({ lead_campaign_data: [{ campaign_id: 555, status: 'STARTED' }] }) })).reason, 'in_other_campaign');
  assert.equal((await sl.checkLeadBeforeImport('k', 'a@b.co', 3122546, {
    lookup: lookup({ lead_campaign_data: [{ campaign_id: 555, status: 'STOPPED' }] }) })).ok, true, 'a lead who replied and stopped elsewhere is fine');
  assert.equal((await sl.checkLeadBeforeImport('k', 'a@b.co', 3122546, { lookup: async () => { throw new Error('down'); } })).reason, 'lookup_failed');
});

test('Smartlead import: approved text goes in custom fields, blocklist and unsubscribe lists are honoured', async () => {
  const fetchImpl = mockFetch([{ status: 200, body: { ok: true, upload_count: 1 } }]);
  const r = await sl.importNurtureLead('test-key-not-real', 3122546, {
    email: 'Pat@Acme.co', name: 'Pat Q Smith', company: 'Acme', subject: 'Pat?', body: 'Line 1 <b>\n\nJosh Osborn', touchId: 'tid-1', hubspotContactId: '77',
  }, { fetchImpl });
  assert.deepEqual(r, { ok: true, uploaded: 1 });
  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/campaigns\/3122546\/leads\?api_key=/);
  const lead = call.body.lead_list[0];
  assert.equal(lead.email, 'pat@acme.co');
  assert.equal(lead.first_name, 'Pat');
  assert.equal(lead.last_name, 'Q Smith');
  assert.equal(lead.custom_fields.nurture_subject, 'Pat?');
  assert.equal(lead.custom_fields.nurture_body, 'Line 1 &lt;b&gt;<br><br>Josh Osborn');
  assert.deepEqual(call.body.settings, {
    ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false,
  });
});

test('Smartlead import: blocklisted, duplicate and unsubscribed leads are reported, not forced', async () => {
  const run = async (body) => sl.importNurtureLead('k', 1, { email: 'a@b.co', name: 'A' }, { fetchImpl: mockFetch([{ status: 200, body }]) });
  assert.equal((await run({ upload_count: 0, block_count: 1 })).reason, 'blocklisted');
  assert.equal((await run({ upload_count: 0, duplicate_count: 1 })).reason, 'already_in_campaign');
  assert.equal((await run({ upload_count: 0, unsubscribed_leads: ['a@b.co'] })).reason, 'unsubscribed');
  assert.equal((await run({ upload_count: 0 })).reason, 'not_imported');
  await assert.rejects(() => sl.importNurtureLead('k', 1, { email: 'a@b.co' }, { fetchImpl: mockFetch([{ status: 500, body: {} }]) }), /failed \(500\)/);
});

// ─── Card ─────────────────────────────────────────────────────────────────────

test('the card is tagged NURTURE and has an action row only while open', () => {
  const card = {
    name: 'Pat Smith', company: 'Acme', lastOutreach: 'Oct 28', phone: '+15555550100', summary: 'Replied Oct 27: "send times"',
    hubspotUrl: 'https://app-na2.hubspot.com/contacts/999/record/0-1/77', email: 'pat@acme.co', subject: 'Pat?', body: 'Hey Pat',
  };
  const open = t.buildNurtureCardBlocks(card, 'tid');
  assert.match(open[0].text.text, /NURTURE/);
  const actions = open.find((b) => b.type === 'actions');
  assert.deepEqual(actions.elements.map((e) => e.action_id), ['nurture_d30_approve', 'nurture_d30_edit', 'nurture_d30_skip']);
  const closed = t.buildNurtureCardBlocks(card, 'tid', { label: 'Queued in Smartlead', by: 'U1' });
  assert.equal(closed.find((b) => b.type === 'actions'), undefined);
  assert.match(JSON.stringify(closed), /Queued in Smartlead by <@U1>/);
  const noPhone = t.buildNurtureCardBlocks({ ...card, phone: null, phoneNote: 'lookup ran: not found', hubspotUrl: null }, 'tid');
  assert.match(JSON.stringify(noPhone), /none found \(lookup ran: not found\)/);
  assert.match(JSON.stringify(noPhone), /no contact found/);
});

// ─── Wiring and guards ────────────────────────────────────────────────────────

test('wiring: Slack routes, cron and the migration list know about nurture', () => {
  const root = path.join(__dirname, '..');
  const slack = fs.readFileSync(path.join(root, 'src/routes/slack.js'), 'utf8');
  assert.ok(slack.includes("startsWith('nurture_d30_')"));
  assert.ok(slack.includes("'nurture_d30_edit_modal'"));
  const cron = fs.readFileSync(path.join(root, 'src/cron.js'), 'utf8');
  assert.ok(/nurture\.enabled\(\)\) return/.test(cron), 'the cron tick returns at once unless NURTURE_ENABLED');
  assert.ok(fs.readFileSync(path.join(root, 'scripts/run-migrations.js'), 'utf8').includes('048_nurture_day30.sql'));
  assert.ok(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8').includes('CREATE TABLE IF NOT EXISTS nurture_leads'));
});

test('guard: the nurture code never calls a send path of its own', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['src/services/nurture-day30.js', 'src/services/smartlead-nurture.js', 'src/services/hubspot-nurture.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/sendReply|gmail-send|sendEmail|reply-send/.test(src), `${f} must not send mail directly`);
  }
});
