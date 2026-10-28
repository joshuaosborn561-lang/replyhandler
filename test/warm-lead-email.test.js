'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../src/services/warm-lead-email');

const SUMMARY = '# EV charging discussion and callback ## Last dialed Oct 28, 2026, 8:25 AM, Gabe Lopez. ## Outcome Meeting booked ## Summary Pat said his organization has no electric cars, but may have a building interested in EV charging; he asked about rebates and whether charging can connect to an apartment’s unit meter, and you confirmed both rebates and that setup are available. You agreed to call him at 11:00 today, and he gave you pat@example.com so you can send information.';
const body = (o = {}) => ({
  event: 'warm_lead_email', kind: 'callback', allo_call_id: 'cll-1', caller: 'Gabe Lopez',
  client: 'Vector Energy Group', client_slug: 'vector', call_at: '2026-10-28T15:23:00Z', summary: SUMMARY,
  prospect: { name: 'Pat Doe', company: 'Acme PM', email: 'pat@example.com', phone: '(555) 111-2222' }, ...o,
});
const noCc = async () => ({ always: [] });
const deps = (o = {}) => ({ env: {}, resolveCc: noCc, linkedinFn: async () => '', now: 1, ...o });

test.beforeEach(() => w._resetSeenForTests());

test('splitAlloSummary drops Last dialed and Outcome, keeps title and summary', () => {
  const { title, body: b } = w.splitAlloSummary(SUMMARY);
  assert.equal(title, 'EV charging discussion and callback');
  assert.ok(!/Outcome|Meeting booked|Last dialed/i.test(b));
  assert.ok(/^Pat said/.test(b));
});

test('splitAlloSummary handles real markdown lines', () => {
  const { title, body: b } = w.splitAlloSummary('# T\n\n## Last dialed\nOct 1\n\n## Outcome\nMeeting booked\n\n## Summary\nHe is interested.');
  assert.equal(title, 'T');
  assert.equal(b, 'He is interested.');
});

test('caller claims are cut, the prospect words stay, you becomes the caller', () => {
  const s = w.clientSafeSummary('He asked about rebates and whether it fits, and you confirmed both are available. You said it saves 40%.', 'Gabe');
  assert.ok(/asked about rebates/.test(s));
  assert.ok(!/confirmed|saves 40/.test(s));
  const t = w.clientSafeSummary('You agreed to call him at 3pm.', 'Gabe');
  assert.equal(t, 'Gabe agreed to call him at 3pm.');
});

test('agreed time: callback clause only, today anchored to the call day', () => {
  const a = w.agreedTimeFrom(w.splitAlloSummary(SUMMARY).body, 'Gabe', { today: 'Wednesday, Oct 28' });
  assert.equal(a, 'Gabe agreed to call him at 11:00 on Wednesday, Oct 28');
});

test('callback with no agreed time is skipped', async () => {
  const r = await w.handleWarmLeadEmail(body({ summary: '# Call ## Summary He asked us to call back sometime.' }), deps({ env: { WARM_LEAD_EMAIL_ENABLED: 'true' } }));
  assert.equal(r.body.skipped, 'no_agreed_time');
});

test('off by default: nothing sent', async () => {
  let sent = 0;
  const r = await w.handleWarmLeadEmail(body(), deps({ send: async () => { sent++; } }));
  assert.equal(r.body.skipped, 'disabled');
  assert.equal(sent, 0);
});

test('dry_run renders without sending even when the flag is off', async () => {
  let sent = 0;
  const r = await w.handleWarmLeadEmail({ ...body(), dry_run: true }, deps({ send: async () => { sent++; } }));
  assert.equal(r.body.dry_run, true);
  assert.equal(sent, 0);
  assert.deepEqual(r.body.to, ['agancman@vectorenergygroup.com']);
  assert.deepEqual(r.body.cc, ['cayden@salesglidergrowth.com', 'gabe@salesglidergrowth.com']);
  assert.ok(!/booked a meeting|Meeting booked/i.test(r.body.textBody));
  assert.ok(/No meeting is booked yet/.test(r.body.textBody));
  assert.ok(!r.body.to.concat(r.body.cc).includes('joshua@salesglidergrowth.com'));
});

test('enabled: sends once, to the client always-CC, never to Josh', async () => {
  const sent = [];
  const d = deps({ env: { WARM_LEAD_EMAIL_ENABLED: 'true' }, resolveCc: async () => ({ always: ['boss@client.com'] }), send: async (m) => { sent.push(m); } });
  const r1 = await w.handleWarmLeadEmail(body(), d);
  const r2 = await w.handleWarmLeadEmail(body(), d);
  assert.equal(r1.body.sent, true);
  assert.equal(r2.body.deduped, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['boss@client.com']);
  assert.ok(!sent[0].cc.includes('joshua@salesglidergrowth.com'));
});

test('interested wording is a warm lead, not a booking', async () => {
  const r = await w.handleWarmLeadEmail({ ...body({ kind: 'interested', summary: '# Interest ## Outcome Meeting booked ## Summary He wants pricing.' }), dry_run: true }, deps());
  assert.match(r.body.subject, /^Warm lead: Pat Doe/);
  assert.ok(/warm lead, not a booked meeting/.test(r.body.textBody));
  assert.ok(!/Meeting booked/.test(r.body.textBody));
});

test('only Vector falls back to the owner contact; others fall to Josh', () => {
  assert.deepEqual(w.warmLeadRecipients({ always: [], clientSlug: 'vector', env: {} }).to, ['agancman@vectorenergygroup.com']);
  assert.deepEqual(w.warmLeadRecipients({ always: [], clientSlug: 'emcor', env: {} }).to, ['joshua@salesglidergrowth.com']);
});

test('bad payloads are rejected', async () => {
  assert.equal((await w.handleWarmLeadEmail({ event: 'x' }, deps({ env: { WARM_LEAD_EMAIL_ENABLED: 'true' } }))).status, 400);
  assert.equal((await w.handleWarmLeadEmail(body({ kind: 'booked' }), deps({ env: { WARM_LEAD_EMAIL_ENABLED: 'true' } }))).status, 400);
});

const PT = 'America/Los_Angeles';
const callAt = Date.parse('2026-10-28T15:23:00Z'); // 8:23 AM PT, 10:23 AM CT

test('localizeTime: prospect zone first, Central in brackets', () => {
  const t = (txt, o = {}) => w.localizeTime(txt, { callAtMs: callAt, zone: PT, ...o });
  assert.equal(t('Gabe agreed to call him at 11:00 today'), 'Gabe agreed to call him at 11:00 AM PT (1:00 PM CT) today');
  assert.equal(t('call at 2 pm'), 'call at 2:00 PM PT (4:00 PM CT)');
  assert.equal(t('call at 2:30'), 'call at 2:30 PM PT (4:30 PM CT)'); // no am/pm: next business-hour occurrence after the call
  assert.equal(t('call at noon'), 'call at 12:00 PM PT (2:00 PM CT)');
  assert.equal(t('call at 9'), 'call at 9:00 AM PT (11:00 AM CT)');
  assert.equal(t('call at 11 AM Eastern'), 'call at 11:00 AM ET (10:00 AM CT)');
});

test('localizeTime: Central or unknown zone shows CT only; no clock time is left alone', () => {
  assert.equal(w.localizeTime('call him at 11:00', { callAtMs: callAt, zone: 'America/Chicago' }), 'call him at 11:00 AM CT');
  assert.equal(w.localizeTime('call him at 11:00', { callAtMs: callAt, zone: '' }), 'call him at 11:00 AM CT');
  assert.equal(w.localizeTime('he has 12 buildings', { callAtMs: callAt, zone: PT }), 'he has 12 buildings');
  assert.equal(w.localizeTime('call him tomorrow at 3 pm', { callAtMs: callAt, zone: PT }), 'call him tomorrow at 3:00 PM PT (5:00 PM CT)');
});

test('title line is dropped when unknown, shown when known', async () => {
  const none = await w.handleWarmLeadEmail({ ...body(), dry_run: true }, deps());
  assert.ok(!/Title/.test(none.body.textBody) && !/Title/.test(none.body.htmlBody));
  assert.ok(!/not found.*Title|Title.*not found/.test(none.body.textBody));
  const has = await w.handleWarmLeadEmail({ ...body({ prospect: { name: 'Pat Doe', company: 'Acme PM', title: 'Director of Operations' } }), dry_run: true }, deps());
  assert.match(has.body.textBody, /Title: Director of Operations/);
});

test('unverified call email is labelled; verified email is plain and fixes the summary spelling', async () => {
  const un = await w.handleWarmLeadEmail({ ...body({ prospect: { name: 'Pat Doe', company: 'Acme PM', email: 'pdoeee@gmail.com', email_verified: false } }), dry_run: true }, deps());
  assert.match(un.body.textBody, /Email: pdoeee@gmail.com \(from call, unverified\)/);
  const sum = '# T ## Summary He gave you pdoeee@gmail.com. You agreed to call him at 11:00 today.';
  const ok = await w.handleWarmLeadEmail({ ...body({ summary: sum, prospect: { name: 'Pat Doe', email: 'pdoe@gmail.com', email_verified: true }, prospect_zone: PT }), dry_run: true }, deps());
  assert.match(ok.body.textBody, /Email: pdoe@gmail.com\n/);
  assert.ok(!/pdoeee/.test(ok.body.textBody));
  assert.ok(!/unverified/.test(ok.body.textBody));
});

test('agreed time in the email uses the prospect zone', async () => {
  const r = await w.handleWarmLeadEmail({ ...body({ prospect_zone: PT }), dry_run: true }, deps());
  assert.match(r.body.textBody, /Gabe agreed to call him at 11:00 AM PT \(1:00 PM CT\) on Wednesday, Oct 28/);
  assert.match(r.body.subject, /Callback set/);
});

test('a lookup title fills an empty title; a lookup failure changes nothing', async () => {
  const sent = [];
  const d = deps({ env: { WARM_LEAD_EMAIL_ENABLED: 'true' }, send: async (m) => { sent.push(m); }, linkedinFn: async () => ({ linkedinUrl: 'https://www.linkedin.com/in/pat', title: 'VP Ops' }) });
  await w.handleWarmLeadEmail(body(), d);
  assert.match(sent[0].textBody, /Title: VP Ops/);
  assert.match(sent[0].textBody, /LinkedIn: https:\/\/www.linkedin.com\/in\/pat/);
});
