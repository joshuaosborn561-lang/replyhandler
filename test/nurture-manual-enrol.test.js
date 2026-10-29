/**
 * Manual nurture enrolment: leads added by hand with their own copy, no pending_replies row,
 * and no HubSpot contact. PGlite (in memory) with mocked HubSpot, Slack and Smartlead; nothing
 * touches the network. Skips when PGlite is not installed (NODE_PATH=<dir with @electric-sql/pglite>).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { /* skip below */ }
const skip = PGlite ? false : 'PGlite not installed (dev-only integration test)';

for (const k of ['BOOKING_BRIDGE_URL', 'CAMPAIGN_INTELLIGENCE_URL', 'HUBSPOT_ACCESS_TOKEN']) delete process.env[k];

// The services capture src/db when first required, so the mock goes in before any of them load.
let shared = null;
require.cache[require.resolve('../src/db')] = {
  id: 'db', filename: 'db', loaded: true,
  exports: {
    async query(sql, params) {
      const r = await shared.pg.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  },
};

const t = require('../src/utils/nurture-day30-text');
const { normalizeLead } = require('../src/services/nurture-manual-enrol');

const DAY = 24 * 60 * 60000;
const NOW = new Date('2026-11-30T17:00:00Z'); // Mon 11:00 CT, inside the send window
const APPROVER = 'U0AAX2XFJE7';

function copy(first = 'Pat', extra = '') {
  return {
    subject: 'Acme follow up',
    body: `Hey ${first}, circling back on the call we had booked.${extra}\n\nAcross our clients, we have generated $1.2M in projected LTV.\n\n${t.GUARANTEE}\n\nJosh Osborn`,
  };
}
function lead(over = {}) {
  return { email: 'pat@acme.co', name: 'Pat Smith', ...copy('Pat'), ...over };
}

// ─── Pure ─────────────────────────────────────────────────────────────────────

test('normalizeLead: a good lead has no errors and keeps its own copy', () => {
  const r = normalizeLead(lead({ email: ' Pat@Acme.co ', company: 'Acme', phone: '555', flag: 'check the lane' }), { now: NOW });
  assert.deepEqual(r.errors, []);
  assert.equal(r.lead.email, 'pat@acme.co');
  assert.equal(r.lead.note, 'check the lane'); // `flag` is a synonym for `note`
  assert.equal(r.lead.hubspotSkip, false);
});

test('normalizeLead: missing pieces are errors', () => {
  assert.deepEqual(normalizeLead({}, { now: NOW }).errors.sort(), ['missing_body', 'missing_email', 'missing_subject']);
  assert.ok(normalizeLead(lead({ email: 'nope' }), { now: NOW }).errors.includes('bad_email'));
  assert.ok(normalizeLead(lead({ subject: '' }), { now: NOW }).errors.includes('missing_subject'));
});

test('normalizeLead: the same copy rules as the card apply', () => {
  const bad = (body) => normalizeLead(lead({ body }), { now: NOW }).errors;
  assert.ok(bad('Hey Pat, hi\n\nJosh Osborn').includes('copy_no_guarantee'));
  assert.ok(bad(`Hey Pat, a \u2014 dash\n\n${t.GUARANTEE}\n\nJosh Osborn`).includes('copy_dash'));
  assert.ok(bad(`Hey Pat, {{x}}\n\n${t.GUARANTEE}\n\nJosh Osborn`).includes('copy_placeholder'));
  assert.ok(bad(`Hey Pat, hi\n\n${t.GUARANTEE}\n\nThanks`).includes('copy_no_signature'));
  assert.ok(bad(`Hey Pat, ${'word '.repeat(120)}\n\n${t.GUARANTEE}\n\nJosh Osborn`).includes('copy_too_long'));
});

test('normalizeLead: a greeting name that is not the lead is a warning, not an error', () => {
  const r = normalizeLead(lead({ ...copy('Shaun and Renee'), name: 'Shaun Beck' }), { now: NOW });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []); // "Shaun and Renee" starts with a name in the lead's name
  const w = normalizeLead(lead({ ...copy('Kim'), name: 'Pat Smith' }), { now: NOW });
  assert.ok(w.warnings.includes('greeting_name_differs_from_name'));
  assert.deepEqual(w.errors, []);
});

test('normalizeLead: dates and HubSpot flags are checked', () => {
  assert.ok(normalizeLead(lead({ last_outreach_at: 'nonsense' }), { now: NOW }).errors.includes('bad_last_outreach_at'));
  assert.ok(normalizeLead(lead({ last_outreach_at: '2027-01-01' }), { now: NOW }).errors.includes('last_outreach_in_future'));
  assert.ok(normalizeLead(lead({ due: 'x' }), { now: NOW }).errors.includes('bad_due'));
  assert.ok(normalizeLead(lead({ hubspot: false, hubspot_contact_id: '123' }), { now: NOW }).errors.includes('hubspot_false_but_contact_id_given'));
  assert.equal(normalizeLead(lead({ hubspot: false }), { now: NOW }).lead.hubspotSkip, true);
});

// ─── Database ─────────────────────────────────────────────────────────────────

async function setup() {
  if (!shared) {
    const pg = new PGlite();
    shared = { pg };
    const root = path.join(__dirname, '..');
    await pg.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8').replace(/CREATE EXTENSION[^;]*;/gi, ''));
    shared.svc = require('../src/services/nurture-day30');
    shared.man = require('../src/services/nurture-manual-enrol');
    const { rows: [client] } = await pg.query(
      `INSERT INTO clients (name, slack_bot_token, slack_channel_id, smartlead_api_key)
       VALUES ('SG Test', 'xoxb-test', 'C1', 'sl-test') RETURNING id`);
    shared.clientId = client.id;
  }
  const { pg } = shared;
  await pg.exec(`TRUNCATE nurture_touches, nurture_leads, followup_sequence_steps, followup_sequences,
                          pending_replies, disqualified_prospects, meetings, client_claimed_leads RESTART IDENTITY CASCADE`);
  const env = {
    NURTURE_ENABLED: 'true', NURTURE_ENROLL_START: '2026-10-01T00:00:00Z', NURTURE_SLACK_CHANNEL: 'CNURTURE',
    SMARTLEAD_NURTURE_CAMPAIGN_ID: '4256543', NURTURE_SMARTLEAD_API_KEY: 'test-key-not-real', HUBSPOT_PORTAL_ID: '999',
    NURTURE_CLIENT_IDS: shared.clientId,
  };
  return { ...shared, env };
}

function fakes({ contact = null, booked = null } = {}) {
  const calls = { hsFind: [], hsUpdate: [], posts: [], updates: [], ephemerals: [], enrich: [], imports: [], modals: [] };
  const deps = {
    hubspot: {
      findContactByEmail: async (email) => { calls.hsFind.push(email); return contact; },
      updateNurtureProperties: async (id, l) => { calls.hsUpdate.push({ id, stage: l.stage }); },
    },
    slackApi: {
      updateMessage: async (...a) => { calls.updates.push(['updateMessage', ...a]); },
      getClient: () => ({
        chat: {
          postMessage: async (a) => { calls.posts.push(a); return { ts: `5000.${calls.posts.length}` }; },
          update: async (a) => { calls.updates.push(['chat.update', a]); },
          postEphemeral: async (a) => { calls.ephemerals.push(a); },
        },
        views: { open: async (a) => { calls.modals.push(a); } },
      }),
    },
    smartleadNurture: {
      sequenceUsesNurtureFields: async () => true,
      checkLeadBeforeImport: async () => ({ ok: true, leadId: null }),
      importNurtureLead: async (...a) => { calls.imports.push(a); return { ok: true, uploaded: 1 }; },
    },
    looksAlreadyBooked: async () => booked,
    hasUpcomingMeeting: async () => false,
    enrichPhone: async (id) => { calls.enrich.push(id); return { status: 'found', phone: '+15555550123' }; },
  };
  return { deps, calls };
}

const count = async (pg, table) => (await pg.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

test('dry run reports every lead and writes nothing', { skip }, async () => {
  const { pg, man, clientId, env } = await setup();
  const out = await man.enrolManual({
    clientId, env, now: NOW, deps: fakes().deps,
    leads: [lead(), lead({ email: 'sam@beta.co', name: 'Sam Lee', ...copy('Sam'), hubspot: false }), lead({ email: 'x@y.co', hubspot_contact_id: '77' })],
  });
  assert.equal(out.ok, true);
  assert.equal(out.applied, false);
  assert.equal(out.summary.total, 3);
  assert.equal(out.summary.ok, 3);
  assert.equal(out.summary.hubspotSkipped, 1);
  assert.equal(out.summary.hubspotContactKnown, 1);
  assert.equal(out.summary.hubspotUnknown, 1);
  assert.equal(await count(pg, 'nurture_leads'), 0);
});

test('apply enrols hand-made rows: no pending_replies, own copy, day30, due now', { skip }, async () => {
  const { pg, man, clientId, env } = await setup();
  const out = await man.enrolManual({
    clientId, env, now: NOW, apply: true, deps: fakes().deps,
    leads: [lead({ company: 'Acme', phone: '+15550001111', summary: 'Booked a call, it never happened', flag: 'lane not verified', last_outreach_at: '2026-08-04T15:00:00Z' })],
  });
  assert.equal(out.ok, true);
  assert.equal(out.applied, true);
  assert.equal(out.summary.enrolled, 1);
  assert.equal(await count(pg, 'pending_replies'), 0);
  assert.equal(await count(pg, 'followup_sequences'), 0);
  const { rows: [row] } = await pg.query('SELECT * FROM nurture_leads');
  assert.equal(row.origin, 'manual');
  assert.equal(row.source_sequence_id, null);
  assert.equal(row.source_reply_id, null);
  assert.equal(row.stage, 'day30');
  assert.equal(row.lead_key, `${clientId}|pat@acme.co`);
  assert.equal(row.custom_subject, 'Acme follow up');
  assert.match(row.custom_body, /Hey Pat/);
  assert.equal(row.hubspot_skip, false);
  assert.equal(row.phone, '+15550001111');
  assert.equal(row.card_note, 'lane not verified');
  assert.ok(new Date(row.next_touch_at).getTime() >= NOW.getTime());
  assert.ok(new Date(row.next_touch_at).getTime() < NOW.getTime() + 3 * DAY);
  assert.equal(new Date(row.last_outreach_at).toISOString(), '2026-08-04T15:00:00.000Z');
});

test('apply is refused for a client that is not in NURTURE_CLIENT_IDS; a dry run only warns', { skip }, async () => {
  const { pg, man, clientId, env } = await setup();
  const off = { ...env, NURTURE_CLIENT_IDS: '' };
  const dry = await man.enrolManual({ clientId, env: off, now: NOW, deps: fakes().deps, leads: [lead()] });
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.batchWarnings, ['client_not_in_NURTURE_CLIENT_IDS']);
  const real = await man.enrolManual({ clientId, env: off, now: NOW, apply: true, deps: fakes().deps, leads: [lead()] });
  assert.equal(real.ok, false);
  assert.equal(real.error, 'client_not_in_NURTURE_CLIENT_IDS');
  assert.equal(await count(pg, 'nurture_leads'), 0);
});

test('input problems are reported and a bad batch writes nothing', { skip }, async () => {
  const { pg, man, clientId, env } = await setup();
  assert.equal((await man.enrolManual({ clientId: null, leads: [lead()] })).error, 'clientId_required');
  assert.equal((await man.enrolManual({ clientId, leads: [] })).error, 'leads_required');
  assert.equal((await man.enrolManual({ clientId: '00000000-0000-0000-0000-000000000000', leads: [lead()], env })).error, 'client_not_found');
  const leads = [lead(), lead({ email: 'sam@beta.co', body: 'short' }), lead({ email: 'PAT@acme.co' })];
  const out = await man.enrolManual({ clientId, env, now: NOW, apply: true, deps: fakes().deps, leads });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'batch_has_problems_nothing_written');
  assert.deepEqual(out.results.map((r) => r.status), ['ok', 'invalid', 'duplicate_in_batch']);
  assert.ok(out.results[1].errors.includes('copy_no_guarantee'));
  assert.equal(await count(pg, 'nurture_leads'), 0);
  const partial = await man.enrolManual({ clientId, env, now: NOW, apply: true, allowPartial: true, deps: fakes().deps, leads });
  assert.equal(partial.ok, true);
  assert.equal(partial.summary.enrolled, 1);
  assert.equal(await count(pg, 'nurture_leads'), 1);
});

test('running the same load twice enrols each lead once', { skip }, async () => {
  const { pg, man, clientId, env } = await setup();
  const args = { clientId, env, now: NOW, apply: true, deps: fakes().deps, leads: [lead()] };
  assert.equal((await man.enrolManual(args)).summary.enrolled, 1);
  const again = await man.enrolManual(args);
  assert.equal(again.ok, true);
  assert.equal(again.summary.enrolled, 0);
  assert.equal(again.results[0].status, 'already_in_nurture');
  assert.equal(await count(pg, 'nurture_leads'), 1);
});

test('leads that must not be nurtured are blocked: DQ, earlier no, a meeting still ahead', { skip }, async () => {
  const { pg, man, clientId, env } = await setup();
  await pg.query(`INSERT INTO disqualified_prospects (client_id, platform, lead_email) VALUES ($1,'smartlead','dq@acme.co')`, [clientId]);
  await pg.query(
    `INSERT INTO pending_replies (client_id, classification, status, slack_message_ts, lead_email, inbound_message, platform)
     VALUES ($1,'NOT_INTERESTED','pending','1.1','no@acme.co','no thanks','smartlead')`, [clientId]);
  const leads = [lead({ email: 'dq@acme.co' }), lead({ email: 'no@acme.co' }), lead({ email: 'booked@acme.co' }), lead({ email: 'fine@acme.co' })];
  const f = fakes();
  f.deps.hasUpcomingMeeting = async (_c, o) => o.leadEmail === 'booked@acme.co';
  const out = await man.enrolManual({ clientId, env, now: NOW, deps: f.deps, leads });
  assert.deepEqual(out.results.map((r) => r.status), ['blocked', 'blocked', 'blocked', 'ok']);
  assert.deepEqual(out.results[0].errors, ['disqualified']);
  assert.deepEqual(out.results[1].errors, ['prior_not_interested_reply']);
  assert.deepEqual(out.results[2].errors, ['would_pause_booked_meeting']);
});

test('a meeting that was booked but never held does not exclude a manual lead', { skip }, async () => {
  const { pg, man, clientId, env } = await setup();
  const f = fakes();
  // Every "already booked" signal says yes (a meeting row, a bridge booking, a past calendar event...),
  // but nothing is still ahead on the calendar: the lead is a no-show and must be loadable.
  f.deps.looksAlreadyBooked = async () => 'meeting_row_exists';
  f.deps.hasUpcomingMeeting = async () => false;
  await pg.query(
    `INSERT INTO meetings (client_id, lead_email, lead_name, status) VALUES ($1,'noshow@acme.co','No Show','booked')`, [clientId]);
  const dry = await man.enrolManual({ clientId, env, now: NOW, deps: f.deps, leads: [lead({ email: 'noshow@acme.co' })] });
  assert.equal(dry.results[0].status, 'ok', JSON.stringify(dry.results[0]));
  const out = await man.enrolManual({ clientId, env, now: NOW, apply: true, deps: f.deps, leads: [lead({ email: 'noshow@acme.co' })] });
  assert.equal(out.results[0].status, 'enrolled');
  // The next exit check (the 10 minute tick) leaves it alone too.
  const { rows: [row] } = await pg.query('SELECT * FROM nurture_leads WHERE lead_email = $1', ['noshow@acme.co']);
  const verdict = await require('../src/services/nurture-day30').evaluateManual(row, { deps: f.deps });
  assert.equal(verdict.action, 'ok');
  // A booking made after enrolment (a reply marked meeting_booked) still pauses it.
  await pg.query(
    `INSERT INTO pending_replies (client_id, classification, status, slack_message_ts, lead_email, inbound_message, platform, created_at)
     VALUES ($1,'MEETING_PROPOSED','meeting_booked','1.2','noshow@acme.co','Tuesday works','smartlead', $2)`, [clientId, new Date(NOW.getTime() + 3600000)]);
  const later = await require('../src/services/nurture-day30').evaluateManual(row, { deps: f.deps });
  assert.equal(later.action, 'pause');
});

test('a hand-made row cannot be a sequence row without its source (CHECK)', { skip }, async () => {
  const { pg, clientId } = await setup();
  await assert.rejects(
    pg.query(`INSERT INTO nurture_leads (client_id, lead_key, lead_email) VALUES ($1,'k','a@b.co')`, [clientId]),
    /nurture_leads_source_check/);
});

async function manualLead(setupResult, over = {}, flags = {}) {
  const { man, clientId, env } = setupResult;
  const e = { ...env, ...flags };
  const f = fakes(flags.fake || {});
  const out = await man.enrolManual({ clientId, env: e, now: NOW, apply: true, deps: f.deps, leads: [lead(over)] });
  assert.equal(out.ok, true, JSON.stringify(out));
  const { rows: [row] } = await setupResult.pg.query('SELECT * FROM nurture_leads WHERE lead_email = $1', [String(over.email || 'pat@acme.co').toLowerCase()]);
  return { row, env: e, f };
}

test('the card shows the lead\'s own copy, phone and note; the preview and the stored touch match', { skip }, async () => {
  const s = await setup();
  const { row, env, f } = await manualLead(s, { company: 'Acme', phone: '+15550001111', summary: 'Booked a call, it never happened', flag: 'lane not verified', hubspot: false });
  const dry = await s.svc.runTouches({ now: NOW, env, deps: f.deps, dryRun: true });
  assert.equal(dry.due, 1);
  assert.deepEqual(dry.wouldPost.map((w) => [w.subject, w.valid]), [['Acme follow up', true]]);

  const env2 = { ...env, NURTURE_POST_ENABLED: 'true' };
  const r = await s.svc.runTouches({ now: NOW, env: env2, deps: f.deps });
  assert.equal(r.posted, 1);
  const text = JSON.stringify(f.calls.posts[0].blocks);
  assert.match(text, /Acme follow up/);
  assert.match(text, /circling back on the call we had booked/);
  assert.doesNotMatch(text, /circling back on your reply/); // not the template
  assert.match(text, /\+15550001111/);
  assert.match(text, /Booked a call, it never happened/);
  assert.match(text, /lane not verified/);
  assert.match(text, /no contact found/);
  assert.equal(f.calls.hsFind.length, 0, 'no HubSpot lookup for a lead with no contact');
  assert.equal(f.calls.enrich.length, 0, 'no reply to look a phone up from');
  const { rows: [touch] } = await s.pg.query('SELECT * FROM nurture_touches WHERE nurture_lead_id = $1', [row.id]);
  assert.equal(touch.subject, 'Acme follow up');
  assert.equal(touch.body, row.custom_body);
  assert.equal(touch.phone, '+15550001111');
  assert.equal(touch.status, 'posted');
});

test('a lead with no phone says so (no reply to look one up from)', { skip }, async () => {
  const s = await setup();
  const { env, f } = await manualLead(s, { hubspot: false });
  await s.svc.runTouches({ now: NOW, env: { ...env, NURTURE_POST_ENABLED: 'true' }, deps: f.deps });
  assert.match(JSON.stringify(f.calls.posts[0].blocks), /none found \(no lookup: no reply record on file\)/);
});

test('the lead with a known HubSpot contact links to it without needing a lookup result', { skip }, async () => {
  const s = await setup();
  const { env, f } = await manualLead(s, { hubspot_contact_id: '555' });
  await s.svc.runTouches({ now: NOW, env: { ...env, NURTURE_POST_ENABLED: 'true', HUBSPOT_ACCESS_TOKEN: 'x' }, deps: f.deps });
  assert.match(JSON.stringify(f.calls.posts[0].blocks), /contacts\/999\/record\/0-1\/555/);
});

test('Edit shows the lead\'s copy, Approve sends the edited copy, HubSpot is skipped throughout', { skip }, async () => {
  const s = await setup();
  const { row, env, f } = await manualLead(s, { hubspot: false });
  const live = { ...env, NURTURE_POST_ENABLED: 'true', NURTURE_SEND_ENABLED: 'true', NURTURE_HUBSPOT_SYNC_ENABLED: 'true', HUBSPOT_ACCESS_TOKEN: 'x' };
  await s.svc.runTouches({ now: NOW, env: live, deps: f.deps });
  const { rows: [touch] } = await s.pg.query('SELECT * FROM nurture_touches WHERE nurture_lead_id = $1', [row.id]);

  await s.svc.handleButton({ action_id: t.ACTION_EDIT, value: touch.id }, { user: { id: APPROVER }, trigger_id: 'trig' }, { env: live, deps: f.deps });
  const modal = JSON.stringify(f.calls.modals[0].view);
  assert.match(modal, /Acme follow up/);
  assert.match(modal, /circling back on the call we had booked/);

  const edited = copy('Pat', ' Edited line.');
  const submit = {
    user: { id: APPROVER },
    view: {
      private_metadata: JSON.stringify({ touchId: touch.id }),
      state: { values: { subject_block: { subject_input: { value: 'Edited subject' } }, body_block: { body_input: { value: edited.body } } } },
    },
  };
  const res = await s.svc.handleEditSubmit(submit, { env: live, deps: f.deps, now: NOW });
  assert.deepEqual(res, { ok: true, outcome: 'queued' });
  assert.equal(f.calls.imports.length, 1);
  assert.equal(f.calls.imports[0][2].subject, 'Edited subject');
  assert.match(f.calls.imports[0][2].body, /Edited line/);
  assert.equal(f.calls.imports[0][1], '4256543');
  const { rows: [after] } = await s.pg.query('SELECT * FROM nurture_leads WHERE id = $1', [row.id]);
  assert.equal(after.stage, 'day90');
  assert.equal(f.calls.hsFind.length, 0);
  assert.equal(f.calls.hsUpdate.length, 0);
});

test('HubSpot sync skips flagged leads and still syncs the others', { skip }, async () => {
  const s = await setup();
  const f = fakes({ contact: { id: 'hs-9', company: 'Beta' } });
  const env = { ...s.env, NURTURE_HUBSPOT_SYNC_ENABLED: 'true' };
  await s.man.enrolManual({
    clientId: s.clientId, env, now: NOW, apply: true, deps: f.deps,
    leads: [lead({ hubspot: false }), lead({ email: 'sam@beta.co', name: 'Sam Lee', ...copy('Sam') })],
  });
  const totals = await s.svc.flushAllHubSpot({ env, deps: f.deps });
  assert.equal(totals.synced, 1);
  assert.equal(totals.skipped, 0, 'flagged rows are not even picked up');
  assert.deepEqual(f.calls.hsFind, ['sam@beta.co']);
  const { rows: [skipped] } = await s.pg.query(`SELECT * FROM nurture_leads WHERE lead_email = 'pat@acme.co'`);
  assert.equal(await s.svc.flushHubSpot(skipped, { env, deps: f.deps }), 'skipped');
});

test('a manual lead with an unknown HubSpot status that has no contact still works', { skip }, async () => {
  const s = await setup();
  const f = fakes({ contact: null });
  const env = { ...s.env, NURTURE_HUBSPOT_SYNC_ENABLED: 'true', NURTURE_POST_ENABLED: 'true' };
  await s.man.enrolManual({ clientId: s.clientId, env, now: NOW, apply: true, deps: f.deps, leads: [lead()] });
  assert.equal((await s.svc.flushAllHubSpot({ env, deps: f.deps })).no_contact, 1);
  assert.equal((await s.svc.runTouches({ now: NOW, env, deps: f.deps })).posted, 1);
  assert.equal(f.calls.hsUpdate.length, 0);
});

test('exit rules judge a hand-made lead by its email, from enrolment on', { skip }, async () => {
  const s = await setup();
  const f = fakes();
  const reply = async (email, classification, at, status = 'pending') => s.pg.query(
    `INSERT INTO pending_replies (client_id, classification, status, slack_message_ts, lead_email, inbound_message, platform, created_at)
     VALUES ($1,$2,$3,$4,$5,'x','smartlead',$6)`, [s.clientId, classification, status, `${Math.random()}`, email, at]);
  await s.man.enrolManual({
    clientId: s.clientId, env: s.env, now: NOW, apply: true, deps: f.deps,
    leads: ['a', 'b', 'c', 'd'].map((n) => lead({ email: `${n}@acme.co`, ...copy('Pat') })),
  });
  // An old positive reply (before enrolment) does not pause anyone: they were enrolled on purpose.
  await reply('a@acme.co', 'INTERESTED', new Date(NOW - 30 * DAY));
  await reply('b@acme.co', 'NOT_INTERESTED', new Date(NOW.getTime() + 1000));
  await reply('c@acme.co', 'QUESTION', new Date(NOW.getTime() + 1000));
  await s.pg.query(`UPDATE nurture_leads SET enrolled_at = $1`, [NOW]);
  const r = await s.svc.syncExits({ env: s.env, deps: f.deps });
  assert.deepEqual(r, { checked: 4, paused: 1, exited: 1 });
  const stage = async (e) => (await s.pg.query('SELECT stage, exit_reason FROM nurture_leads WHERE lead_email = $1', [e])).rows[0];
  assert.deepEqual(await stage('a@acme.co'), { stage: 'day30', exit_reason: null });
  assert.deepEqual(await stage('b@acme.co'), { stage: 'exited', exit_reason: 'not_interested' });
  assert.deepEqual(await stage('c@acme.co'), { stage: 'paused', exit_reason: 'positive_reply' });
  assert.deepEqual(await stage('d@acme.co'), { stage: 'day30', exit_reason: null });
});

test('a card for a lead who is DQ\'d before it is due is never posted', { skip }, async () => {
  const s = await setup();
  const f = fakes();
  await s.man.enrolManual({ clientId: s.clientId, env: s.env, now: NOW, apply: true, deps: f.deps, leads: [lead()] });
  await s.pg.query(`INSERT INTO disqualified_prospects (client_id, platform, lead_email) VALUES ($1,'smartlead','pat@acme.co')`, [s.clientId]);
  const r = await s.svc.runTouches({ now: NOW, env: { ...s.env, NURTURE_POST_ENABLED: 'true' }, deps: f.deps });
  assert.equal(r.stopped, 1);
  assert.equal(f.calls.posts.length, 0);
  assert.equal((await s.pg.query('SELECT exit_reason FROM nurture_leads')).rows[0].exit_reason, 'disqualified');
});

test('sequence-origin leads still behave as before and the sequence scan ignores manual rows', { skip }, async () => {
  const s = await setup();
  const f = fakes();
  await s.man.enrolManual({ clientId: s.clientId, env: s.env, now: NOW, apply: true, deps: f.deps, leads: [lead()] });
  const scan = await s.svc.scanEntries({ now: NOW, env: s.env, deps: f.deps });
  assert.equal(scan.enrolled + scan.paused + scan.exited, 0);
  const st = await s.svc.status({ env: s.env });
  assert.deepEqual(st.byOrigin, [{ origin: 'manual', n: 1 }]);
  assert.equal(st.flags.NURTURE_POST_ENABLED, false);
});

test('nothing is posted or sent while the flags are off', { skip }, async () => {
  const s = await setup();
  const f = fakes();
  await s.man.enrolManual({ clientId: s.clientId, env: s.env, now: NOW, apply: true, deps: f.deps, leads: [lead()] });
  const tick = await s.svc.runNurtureTick({ now: NOW, env: {}, deps: f.deps });
  assert.deepEqual(tick, { disabled: true });
  const dry = await s.svc.runTouches({ now: NOW, env: s.env, deps: f.deps }); // NURTURE_POST_ENABLED off
  assert.equal(dry.posted, 0);
  assert.equal(f.calls.posts.length + f.calls.imports.length, 0);
});

// ─── Admin route ──────────────────────────────────────────────────────────────

test('POST /admin/nurture/enrol is dry by default and answers with codes, not names or emails', { skip }, async () => {
  const s = await setup();
  const express = require('express');
  const router = require('../src/routes/admin');
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => { const sv = app.listen(0, () => resolve(sv)); });
  const url = `http://127.0.0.1:${server.address().port}/admin/nurture/enrol`;
  const post = (body) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const origIds = process.env.NURTURE_CLIENT_IDS;
  try {
    assert.equal((await post({ leads: [lead()] })).status, 400);
    // No NURTURE_CLIENT_IDS: even apply:true refuses to write.
    delete process.env.NURTURE_CLIENT_IDS;
    const refused = await post({ clientId: s.clientId, apply: true, leads: [lead()] });
    assert.equal(refused.status, 409);
    assert.equal(await count(s.pg, 'nurture_leads'), 0);

    const dry = await post({ clientId: s.clientId, leads: [lead(), lead({ email: 'bad', body: 'x' })] });
    const dryBody = await dry.json();
    assert.equal(dryBody.applied, false);
    assert.equal(dryBody.summary.total, 2);
    assert.deepEqual(dryBody.results.map((r) => r.status), ['ok', 'invalid']);
    assert.doesNotMatch(JSON.stringify(dryBody), /pat@acme|Pat Smith/);
    assert.equal(await count(s.pg, 'nurture_leads'), 0);

    process.env.NURTURE_CLIENT_IDS = s.clientId;
    const blocked = await post({ clientId: s.clientId, apply: true, leads: [lead(), lead({ email: 'bad', body: 'x' })] });
    assert.equal(blocked.status, 409);
    assert.equal(await count(s.pg, 'nurture_leads'), 0);
    const done = await post({ clientId: s.clientId, apply: true, leads: [lead()] });
    assert.equal(done.status, 200);
    assert.equal((await done.json()).summary.enrolled, 1);
    assert.equal(await count(s.pg, 'nurture_leads'), 1);
  } finally {
    if (origIds === undefined) delete process.env.NURTURE_CLIENT_IDS; else process.env.NURTURE_CLIENT_IDS = origIds;
    server.close();
  }
});
