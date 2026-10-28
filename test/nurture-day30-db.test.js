/**
 * Day-30 nurture, end to end on a real Postgres (PGlite, in memory).
 * HubSpot, Slack and Smartlead are mocks; nothing here touches the network.
 * PGlite is dev-only: the suite skips when it is not installed
 * (NODE_PATH=<dir with @electric-sql/pglite>).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { /* skip below */ }
const skip = PGlite ? false : 'PGlite not installed (dev-only integration test)';

for (const k of ['BOOKING_BRIDGE_URL', 'CAMPAIGN_INTELLIGENCE_URL', 'HUBSPOT_ACCESS_TOKEN']) delete process.env[k];

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const OUTREACH = new Date('2026-10-28T15:00:00Z');
const SOURCE_AT = new Date('2026-10-27T17:00:00Z');
const NOW = new Date('2026-11-30T17:00:00Z'); // Mon 11:00 CT, inside the send window
const APPROVER = 'U0AAX2XFJE7';

const BASE_ENV = {
  NURTURE_ENABLED: 'true',
  NURTURE_ENROLL_START: '2026-10-01T00:00:00Z',
  NURTURE_SLACK_CHANNEL: 'CNURTURE',
  SMARTLEAD_NURTURE_CAMPAIGN_ID: '3122546',
  NURTURE_SMARTLEAD_API_KEY: 'test-key-not-real',
  HUBSPOT_PORTAL_ID: '999',
};

let shared = null;
async function setup() {
  if (!shared) {
    const pg = new PGlite();
    const adapter = {
      async query(sql, params) {
        const r = await pg.query(sql, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
    };
    require.cache[require.resolve('../src/db')] = { id: 'db', filename: 'db', loaded: true, exports: adapter };
    const root = path.join(__dirname, '..');
    await pg.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8').replace(/CREATE EXTENSION[^;]*;/gi, ''));
    shared = { pg, svc: require('../src/services/nurture-day30') };
    const { rows: [client] } = await pg.query(
      `INSERT INTO clients (name, slack_bot_token, slack_channel_id, smartlead_api_key)
       VALUES ('SG Test', 'xoxb-test', 'C1', 'sl-test') RETURNING id`);
    shared.clientId = client.id;
  }
  const { pg, svc } = shared;
  await pg.exec(`TRUNCATE nurture_touches, nurture_leads, followup_sequence_steps, followup_sequences,
                          pending_replies, disqualified_prospects, meetings, client_claimed_leads RESTART IDENTITY CASCADE`);
  return { pg, svc, clientId: shared.clientId };
}

let n = 0;
async function addReply(pg, clientId, over = {}) {
  n += 1;
  const row = {
    classification: 'INTERESTED', status: 'pending', slack_message_ts: `1700.${n}`,
    lead_email: `lead${n}@acme${n}.co`, lead_name: 'Pat Smith', inbound_message: `Sounds good, send times ${n}`,
    lead_phone: null, phone_enrichment_status: null, created_at: SOURCE_AT,
    platform: 'smartlead', campaign_id: '111', lead_id: String(n), ...over,
  };
  const cols = Object.keys(row);
  const { rows: [r] } = await pg.query(
    `INSERT INTO pending_replies (client_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [clientId, ...cols.map((c) => row[c])]);
  return r;
}

/** A follow-up sequence for a source reply. By default it is completed with one sent email. */
async function addSequence(pg, clientId, source, over = {}) {
  const { status = 'completed', origin = 'reply', sentEmail = true, callOutcome = null, updatedAt = OUTREACH } = over;
  const key = `${clientId}|${String(source.lead_email).toLowerCase()}`;
  const { rows: [seq] } = await pg.query(
    `INSERT INTO followup_sequences (client_id, source_reply_id, platform, campaign_id, lead_key, lead_name, lead_email,
                                     status, origin, updated_at, enrolled_at)
     VALUES ($1,$2,'smartlead','111',$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
    [clientId, source.id, key, source.lead_name, source.lead_email, status, origin, updatedAt]);
  if (sentEmail) {
    const fu = await addReply(pg, clientId, {
      classification: 'FOLLOW_UP', status: 'sent', lead_email: source.lead_email, lead_id: source.lead_id,
      inbound_message: 'follow up copy', created_at: new Date(OUTREACH - DAY),
    });
    await pg.query('UPDATE pending_replies SET updated_at = $2 WHERE id = $1', [fu.id, OUTREACH]);
    await pg.query(
      `INSERT INTO followup_sequence_steps (sequence_id, kind, seq_order, status, pending_reply_id, posted_at)
       VALUES ($1,'email_day1',2,'posted',$2,$3)`, [seq.id, fu.id, new Date(OUTREACH - DAY)]);
  }
  if (callOutcome) {
    await pg.query(
      `INSERT INTO followup_sequence_steps (sequence_id, kind, seq_order, status, outcome, outcome_at, posted_at)
       VALUES ($1,'call_day0',1,'posted',$2,$3,$3)`, [seq.id, callOutcome, new Date(OUTREACH - 2 * DAY)]);
  }
  return seq;
}

function fakes({ contact = { id: 'hs-1', company: 'Acme Roofing', phone: null }, sequenceOk = true, lead = null, importResult = { ok: true, uploaded: 1 } } = {}) {
  const calls = { hsFind: [], hsUpdate: [], posts: [], updates: [], ephemerals: [], enrich: [], lookups: [], imports: [], modals: [] };
  const deps = {
    hubspot: {
      findContactByEmail: async (email) => { calls.hsFind.push(email); return contact; },
      updateNurtureProperties: async (id, l) => { calls.hsUpdate.push({ id, stage: l.stage, next: l.next_touch_at, last: l.last_outreach_at, reason: l.exit_reason }); },
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
      sequenceUsesNurtureFields: async () => sequenceOk,
      checkLeadBeforeImport: async (...a) => { calls.lookups.push(a); return lead || { ok: true, leadId: null }; },
      importNurtureLead: async (...a) => { calls.imports.push(a); return importResult; },
    },
    looksAlreadyBooked: async () => null,
    enrichPhone: async (id) => { calls.enrich.push(id); return { status: 'found', phone: '+15555550123' }; },
  };
  return { deps, calls };
}

async function enrolled(pg, svc, clientId, f, env, over = {}, replyOver = {}) {
  const src = await addReply(pg, clientId, replyOver);
  await addSequence(pg, clientId, src, over);
  const e = { ...BASE_ENV, NURTURE_CLIENT_IDS: clientId, ...env };
  await svc.scanEntries({ now: NOW, env: e, deps: f.deps });
  const { rows: [lead] } = await pg.query('SELECT * FROM nurture_leads WHERE source_reply_id = $1', [src.id]);
  return { src, lead, env: e };
}

// ─── Entry ────────────────────────────────────────────────────────────────────

test('everything is off by default: the tick does nothing and writes nothing', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const src = await addReply(pg, clientId);
  await addSequence(pg, clientId, src);
  const r = await svc.runNurtureTick({ now: NOW, env: {}, deps: fakes().deps });
  assert.deepEqual(r, { disabled: true });
  assert.equal((await pg.query('SELECT 1 FROM nurture_leads')).rows.length, 0);
});

test('no clients or no enrol start means nobody enters', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const src = await addReply(pg, clientId);
  await addSequence(pg, clientId, src);
  const noClients = await svc.scanEntries({ now: NOW, env: { ...BASE_ENV }, deps: fakes().deps });
  assert.match(noClients.note, /NURTURE_CLIENT_IDS/);
  const noStart = await svc.scanEntries({ now: NOW, env: { NURTURE_ENABLED: 'true', NURTURE_CLIENT_IDS: clientId }, deps: fakes().deps });
  assert.match(noStart.note, /NURTURE_ENROLL_START/);
  assert.equal((await pg.query('SELECT 1 FROM nurture_leads')).rows.length, 0);
});

test('a finished sequence enters at day30, 30 days after the last follow-up went out', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead } = await enrolled(pg, svc, clientId, f);
  assert.equal(lead.stage, 'day30');
  assert.equal(new Date(lead.last_outreach_at).getTime(), OUTREACH.getTime());
  const due = new Date(lead.next_touch_at).getTime();
  assert.ok(due >= OUTREACH.getTime() + 30 * DAY, 'at least 30 days out');
  assert.ok(due < OUTREACH.getTime() + 33 * DAY, 'snapped forward by a weekend at most');
  assert.equal(lead.exit_reason, null);
});

test('a completed sequence is enrolled once, never twice', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { env } = await enrolled(pg, svc, clientId, f);
  const again = await svc.scanEntries({ now: NOW, env, deps: f.deps });
  assert.equal(again.enrolled, 0);
  assert.equal((await pg.query('SELECT 1 FROM nurture_leads')).rows.length, 1);
});

test('stopped sequences, ghosted-meeting sequences and other clients never enter', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const stopped = await addReply(pg, clientId);
  await addSequence(pg, clientId, stopped, { status: 'stopped' });
  const ghost = await addReply(pg, clientId);
  await addSequence(pg, clientId, ghost, { origin: 'ghosted_meeting' });
  const { rows: [other] } = await pg.query(`INSERT INTO clients (name, slack_bot_token, slack_channel_id) VALUES ('Other', 'x', 'C2') RETURNING id`);
  const otherSrc = await addReply(pg, other.id);
  await addSequence(pg, other.id, otherSrc);
  const old = await addReply(pg, clientId);
  await addSequence(pg, clientId, old, { updatedAt: new Date('2026-09-01T00:00:00Z') });
  const r = await svc.scanEntries({ now: NOW, env: { ...BASE_ENV, NURTURE_CLIENT_IDS: clientId }, deps: f.deps });
  assert.equal(r.enrolled + r.paused + r.exited, 0);
  assert.equal((await pg.query('SELECT 1 FROM nurture_leads')).rows.length, 0);
});

test('no follow-up went out: recorded as exited, not nurtured', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const { lead } = await enrolled(pg, svc, clientId, fakes(), {}, { sentEmail: false });
  assert.equal(lead.stage, 'exited');
  assert.equal(lead.exit_reason, 'no_followup_sent');
});

test('a call attempt counts as outreach and its outcome shows on the card', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead } = await enrolled(pg, svc, clientId, f, {}, { sentEmail: false, callOutcome: 'no_answer' });
  assert.equal(lead.stage, 'day30');
  assert.equal(new Date(lead.last_outreach_at).getTime(), (OUTREACH - 2 * DAY));
});

const EXIT_CASES = [
  ['DQ', 'disqualified', 'exited', async (pg, clientId, src) => {
    await pg.query(`INSERT INTO disqualified_prospects (client_id, platform, campaign_id, lead_id, lead_email, lead_name)
                    VALUES ($1,'smartlead',$2,$3,$4,$5)`, [clientId, src.campaign_id, src.lead_id, src.lead_email, src.lead_name]);
  }],
  ['unsubscribe reply', 'unsubscribed', 'exited', async (pg, clientId, src) => {
    await addReply(pg, clientId, { classification: 'REMOVE_ME', lead_email: src.lead_email, lead_id: src.lead_id, created_at: new Date(OUTREACH.getTime() + DAY) });
  }],
  ['not interested reply', 'not_interested', 'exited', async (pg, clientId, src) => {
    await addReply(pg, clientId, { classification: 'NOT_INTERESTED', lead_email: src.lead_email, lead_id: src.lead_id, created_at: new Date(OUTREACH.getTime() + DAY) });
  }],
  ['positive reply', 'positive_reply', 'paused', async (pg, clientId, src) => {
    await addReply(pg, clientId, { classification: 'QUESTION', lead_email: src.lead_email, lead_id: src.lead_id, created_at: new Date(OUTREACH.getTime() + DAY) });
  }],
  ['booked meeting row', 'booked_meeting', 'paused', async (pg, _c, src) => {
    await pg.query(`UPDATE pending_replies SET status = 'meeting_booked' WHERE id = $1`, [src.id]);
  }],
  ['no-show rebook', 'no_show_rebook', 'exited', async (pg, clientId, src) => {
    await addSequence(pg, clientId, await addReply(pg, clientId, { lead_email: src.lead_email, lead_id: src.lead_id }),
      { origin: 'ghosted_meeting', status: 'active', sentEmail: false, updatedAt: new Date(OUTREACH.getTime() + DAY) });
    await pg.query(`UPDATE followup_sequences SET lead_key = $1, created_at = $2 WHERE origin = 'ghosted_meeting'`,
      [`${clientId}|${src.lead_email}`, new Date(OUTREACH.getTime() + DAY)]);
  }],
  ['client took the lead', 'client_claimed', 'exited', async (pg, _c, src) => {
    await pg.query(`INSERT INTO client_claimed_leads (lead_email, campaign_id, claimed) VALUES ($1,$2,true)`, [src.lead_email, src.campaign_id]);
  }],
];

for (const [label, reason, stage, arrange] of EXIT_CASES) {
  test(`entry: ${label} -> ${stage} (${reason}), never day30`, { skip }, async () => {
    const { pg, svc, clientId } = await setup();
    const src = await addReply(pg, clientId);
    await addSequence(pg, clientId, src);
    await arrange(pg, clientId, src);
    await svc.scanEntries({ now: NOW, env: { ...BASE_ENV, NURTURE_CLIENT_IDS: clientId }, deps: fakes().deps });
    const { rows: [lead] } = await pg.query('SELECT * FROM nurture_leads WHERE source_reply_id = $1', [src.id]);
    assert.equal(lead.stage, stage);
    assert.equal(lead.exit_reason, reason);
    assert.equal(lead.next_touch_at, null);
  });
}

test('entry: a booked meeting found by the booking check pauses the lead', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  f.deps.looksAlreadyBooked = async () => 'calendar_event_found';
  const { lead } = await enrolled(pg, svc, clientId, f);
  assert.equal(lead.stage, 'paused');
  assert.equal(lead.exit_reason, 'booked_meeting');
});

test('entry: an out-of-office auto reply does not stop nurture', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const src = await addReply(pg, clientId);
  await addSequence(pg, clientId, src);
  await addReply(pg, clientId, { classification: 'OOO', lead_email: src.lead_email, lead_id: src.lead_id, created_at: new Date(OUTREACH.getTime() + DAY) });
  await svc.scanEntries({ now: NOW, env: { ...BASE_ENV, NURTURE_CLIENT_IDS: clientId }, deps: fakes().deps });
  const { rows: [lead] } = await pg.query('SELECT * FROM nurture_leads WHERE source_reply_id = $1', [src.id]);
  assert.equal(lead.stage, 'day30');
});

// ─── Exit watching and HubSpot ────────────────────────────────────────────────

test('a positive reply after entry pauses the lead, closes its open card and stops sends', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { src, lead, env } = await enrolled(pg, svc, clientId, f, { NURTURE_POST_ENABLED: 'true', NURTURE_HUBSPOT_SYNC_ENABLED: 'true' });
  await svc.runTouches({ now: NOW, env, deps: f.deps });
  assert.equal(f.calls.posts.length, 1);
  await addReply(pg, clientId, { classification: 'INTERESTED', lead_email: src.lead_email, lead_id: src.lead_id, created_at: new Date(NOW - MIN) });
  const r = await svc.syncExits({ env, deps: f.deps });
  assert.equal(r.paused, 1);
  const { rows: [after] } = await pg.query('SELECT * FROM nurture_leads WHERE id = $1', [lead.id]);
  assert.equal(after.stage, 'paused');
  assert.equal(after.exit_reason, 'positive_reply');
  const { rows: [touch] } = await pg.query('SELECT status FROM nurture_touches WHERE nurture_lead_id = $1', [lead.id]);
  assert.equal(touch.status, 'cancelled');
  assert.ok(f.calls.updates.some((u) => u[0] === 'updateMessage'), 'the Slack card is closed');
  const last = f.calls.hsUpdate[f.calls.hsUpdate.length - 1];
  assert.equal(last.stage, 'paused');
  // A stopped lead never posts again.
  const again = await svc.runTouches({ now: new Date(NOW.getTime() + DAY), env, deps: f.deps });
  assert.equal(again.posted, 0);
});

test('HubSpot: flag off writes nothing; flag on writes the four properties once', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env } = await enrolled(pg, svc, clientId, f);
  assert.equal(await svc.flushHubSpot(lead, { env, deps: f.deps }), 'flag_off');
  assert.equal(f.calls.hsFind.length + f.calls.hsUpdate.length, 0);

  const on = { ...env, NURTURE_HUBSPOT_SYNC_ENABLED: 'true' };
  const t1 = await svc.flushAllHubSpot({ env: on, deps: f.deps });
  assert.equal(t1.synced, 1);
  assert.equal(f.calls.hsUpdate.length, 1);
  assert.equal(f.calls.hsUpdate[0].id, 'hs-1');
  assert.equal(f.calls.hsUpdate[0].stage, 'day30');
  const t2 = await svc.flushAllHubSpot({ env: on, deps: f.deps });
  assert.equal(t2.synced + t2.in_sync + t2.no_contact + t2.error, 0, 'nothing changed, nothing to write');
  assert.equal(f.calls.hsUpdate.length, 1);
});

test('HubSpot: a lead with no contact is skipped without error', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes({ contact: null });
  const { lead, env } = await enrolled(pg, svc, clientId, f);
  const r = await svc.flushHubSpot(lead, { env: { ...env, NURTURE_HUBSPOT_SYNC_ENABLED: 'true' }, deps: f.deps });
  assert.equal(r, 'no_contact');
  assert.equal(f.calls.hsUpdate.length, 0);
});

// ─── The card ─────────────────────────────────────────────────────────────────

async function makeDue(pg, leadId) {
  await pg.query('UPDATE nurture_leads SET next_touch_at = $2 WHERE id = $1', [leadId, new Date(NOW - MIN)]);
}

test('card: posting is off by default; the preview lists what would post and posts nothing', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env } = await enrolled(pg, svc, clientId, f);
  await makeDue(pg, lead.id);
  const r = await svc.runTouches({ now: NOW, env, deps: f.deps });
  assert.equal(f.calls.posts.length, 0);
  assert.equal(r.posted, 0);
  assert.equal(r.wouldPost.length, 1);
  assert.equal(r.wouldPost[0].valid, true);
  assert.equal((await pg.query('SELECT 1 FROM nurture_touches')).rows.length, 0, 'preview leaves no rows');
  assert.equal(f.calls.enrich.length, 0, 'preview never pays for a lookup');
});

test('card: NURTURE-tagged #nurture card with name, company, last outreach, phone, summary, HubSpot link', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env } = await enrolled(pg, svc, clientId, f, { NURTURE_POST_ENABLED: 'true', NURTURE_CALL_MENTIONS: 'U0CAL8ZDG92:Gabe' },
    { callOutcome: 'no_answer' }, { lead_phone: '+15555550100', lead_phone_provider: 'x' });
  await makeDue(pg, lead.id);
  const r = await svc.runTouches({ now: NOW, env, deps: f.deps });
  assert.equal(r.posted, 1);
  const post = f.calls.posts[0];
  assert.equal(post.channel, 'CNURTURE');
  const text = JSON.stringify(post.blocks);
  assert.match(text, /NURTURE/);
  assert.match(text, /Pat Smith/);
  assert.match(text, /Acme Roofing/);
  assert.match(text, /Last outreach:\*\s*Oct 28/);
  assert.match(text, /\+15555550100/);
  assert.match(text, /Replied Oct 27/);
  assert.match(text, /Last call: no answer/);
  assert.match(text, /https:\/\/app-na2\.hubspot\.com\/contacts\/999\/record\/0-1\/hs-1/);
  assert.match(text, /<@U0CAL8ZDG92>/);
  assert.match(text, /nurture_d30_approve/);
  assert.equal(f.calls.enrich.length, 0, 'phone was on file: no lookup');
  const { rows: [touch] } = await pg.query('SELECT * FROM nurture_touches');
  assert.equal(touch.status, 'posted');
  assert.equal(touch.slack_ts, '5000.1');
  // A second tick never double-posts.
  await svc.runTouches({ now: new Date(NOW.getTime() + MIN), env, deps: f.deps });
  assert.equal(f.calls.posts.length, 1);
});

test('card: no phone anywhere runs the phone lookup first, then posts', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env } = await enrolled(pg, svc, clientId, f, { NURTURE_POST_ENABLED: 'true' });
  await makeDue(pg, lead.id);
  await svc.runTouches({ now: NOW, env, deps: f.deps });
  assert.equal(f.calls.enrich.length, 1);
  assert.equal(f.calls.enrich[0], lead.source_reply_id);
  assert.match(JSON.stringify(f.calls.posts[0].blocks), /\+15555550123/);
});

test('card: HubSpot phone is used before paying for a lookup', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes({ contact: { id: 'hs-9', company: 'Acme', phone: '+15555550199' } });
  const { lead, env } = await enrolled(pg, svc, clientId, f, { NURTURE_POST_ENABLED: 'true' });
  await makeDue(pg, lead.id);
  await svc.runTouches({ now: NOW, env, deps: f.deps });
  assert.equal(f.calls.enrich.length, 0);
  assert.match(JSON.stringify(f.calls.posts[0].blocks), /\+15555550199/);
});

test('card: the lookup is for people who replied; a past not_found is not paid for again', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env } = await enrolled(pg, svc, clientId, f, { NURTURE_POST_ENABLED: 'true' }, {}, { phone_enrichment_status: 'not_found' });
  await makeDue(pg, lead.id);
  await svc.runTouches({ now: NOW, env, deps: f.deps });
  assert.equal(f.calls.enrich.length, 0);
  assert.match(JSON.stringify(f.calls.posts[0].blocks), /none found/);

  const f2 = fakes();
  const lead2 = await svc.resolvePhone(
    { id: 'x', client_id: clientId, source_reply_id: lead.source_reply_id, lead_email: 'nobody@x.co' },
    { classification: 'OTHER', phone_enrichment_status: null }, null, { deps: f2.deps });
  assert.equal(lead2.phone, null);
  assert.equal(f2.calls.enrich.length, 0, 'someone who has not replied positively gets no paid lookup');
});

test('card: outside business hours nothing posts; the daily cap holds', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env } = await enrolled(pg, svc, clientId, f, { NURTURE_POST_ENABLED: 'true', NURTURE_MAX_PER_WEEKDAY: '1' });
  await makeDue(pg, lead.id);
  const night = await svc.runTouches({ now: new Date('2026-11-30T03:00:00Z'), env, deps: f.deps });
  assert.equal(night.posted, 0);
  assert.equal(night.waited, 1);

  const second = await addReply(pg, clientId);
  await addSequence(pg, clientId, second);
  await svc.scanEntries({ now: NOW, env, deps: f.deps });
  await pg.query(`UPDATE nurture_leads SET next_touch_at = $1 WHERE stage = 'day30'`, [new Date(NOW - MIN)]);
  const day = await svc.runTouches({ now: NOW, env, deps: f.deps });
  assert.equal(day.posted, 1, 'cap of 1');
  assert.equal(f.calls.posts.length, 1);
});

test('day90 and quarterly touches are disabled: due leads in those stages never post', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env } = await enrolled(pg, svc, clientId, f, { NURTURE_POST_ENABLED: 'true' });
  await pg.query(`UPDATE nurture_leads SET stage = 'day90', next_touch_at = $2 WHERE id = $1`, [lead.id, new Date(NOW - MIN)]);
  const r = await svc.runTouches({ now: NOW, env, deps: f.deps });
  assert.equal(r.disabled, 1);
  assert.equal(r.posted, 0);
  await pg.query(`UPDATE nurture_leads SET stage = 'quarterly' WHERE id = $1`, [lead.id]);
  assert.equal((await svc.runTouches({ now: NOW, env, deps: f.deps })).posted, 0);
  assert.equal(f.calls.posts.length, 0);
});

test('card: a lead who exited before the card is due is stopped, not posted', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { src, lead, env } = await enrolled(pg, svc, clientId, f, { NURTURE_POST_ENABLED: 'true' });
  await makeDue(pg, lead.id);
  await pg.query(`INSERT INTO disqualified_prospects (client_id, platform, campaign_id, lead_id, lead_email, lead_name)
                  VALUES ($1,'smartlead',$2,$3,$4,$5)`, [clientId, src.campaign_id, src.lead_id, src.lead_email, src.lead_name]);
  const r = await svc.runTouches({ now: NOW, env, deps: f.deps });
  assert.equal(r.stopped, 1);
  assert.equal(f.calls.posts.length, 0);
  const { rows: [after] } = await pg.query('SELECT stage, exit_reason FROM nurture_leads WHERE id = $1', [lead.id]);
  assert.equal(after.stage, 'exited');
  assert.equal(after.exit_reason, 'disqualified');
});

// ─── Approve, edit, skip ──────────────────────────────────────────────────────

async function postedTouch(pg, svc, clientId, f, extraEnv = {}) {
  const { lead, env } = await enrolled(pg, svc, clientId, f, { NURTURE_POST_ENABLED: 'true', NURTURE_SEND_ENABLED: 'true', ...extraEnv });
  await makeDue(pg, lead.id);
  await svc.runTouches({ now: NOW, env, deps: f.deps });
  const { rows: [touch] } = await pg.query('SELECT * FROM nurture_touches WHERE nurture_lead_id = $1', [lead.id]);
  return { lead, env, touch };
}

test('approve: queues the approved email in the nurture campaign, moves the lead on, syncs HubSpot', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env, touch } = await postedTouch(pg, svc, clientId, f, { NURTURE_HUBSPOT_SYNC_ENABLED: 'true' });
  const r = await svc.approveTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps });
  assert.equal(r.outcome, 'queued');
  assert.equal(f.calls.imports.length, 1);
  const [key, campaignId, payload] = f.calls.imports[0];
  assert.equal(key, 'test-key-not-real');
  assert.equal(campaignId, '3122546');
  assert.equal(payload.email, lead.lead_email);
  assert.equal(payload.subject, touch.subject);
  assert.equal(payload.body, touch.body);
  const { rows: [t2] } = await pg.query('SELECT status, smartlead_campaign_id FROM nurture_touches WHERE id = $1', [touch.id]);
  assert.equal(t2.status, 'queued');
  assert.equal(t2.smartlead_campaign_id, '3122546');
  const { rows: [after] } = await pg.query('SELECT * FROM nurture_leads WHERE id = $1', [lead.id]);
  assert.equal(after.stage, 'day90');
  assert.equal(new Date(after.last_outreach_at).getTime(), NOW.getTime());
  assert.equal(after.touch_count, 1);
  assert.equal(f.calls.hsUpdate[f.calls.hsUpdate.length - 1].stage, 'day90');
  assert.ok(f.calls.updates.some((u) => u[0] === 'chat.update' && /Queued in Smartlead/.test(JSON.stringify(u[1].blocks))));
  // Clicking again does nothing.
  const twice = await svc.approveTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps });
  assert.equal(twice.outcome, 'already_handled');
  assert.equal(f.calls.imports.length, 1);
});

test('approve: only Josh and Cayden can; everyone else gets a private notice', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { env, touch } = await postedTouch(pg, svc, clientId, f);
  const r = await svc.approveTouch(touch.id, 'UEVERYONE1', { now: NOW, env, deps: f.deps });
  assert.equal(r.outcome, 'denied');
  assert.equal(f.calls.imports.length, 0);
  assert.match(f.calls.ephemerals[0].text, /Only Josh or Cayden/);
  const cayden = await svc.approveTouch(touch.id, 'U0BL8JT75KN', { now: NOW, env, deps: f.deps });
  assert.equal(cayden.outcome, 'queued');
});

test('approve: with NURTURE_SEND_ENABLED off nothing is queued and the card stays open', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { env, touch } = await postedTouch(pg, svc, clientId, f, { NURTURE_SEND_ENABLED: 'false' });
  const r = await svc.approveTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps });
  assert.equal(r.outcome, 'send_disabled');
  assert.equal(f.calls.imports.length, 0);
  const { rows: [t2] } = await pg.query('SELECT status FROM nurture_touches WHERE id = $1', [touch.id]);
  assert.equal(t2.status, 'posted');
});

test('approve: a campaign whose sequence does not render the approved email is refused', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes({ sequenceOk: false });
  const { env, touch } = await postedTouch(pg, svc, clientId, f);
  const r = await svc.approveTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps });
  assert.equal(r.outcome, 'campaign_not_ready');
  assert.equal(f.calls.imports.length, 0);
  const { rows: [t2] } = await pg.query('SELECT status FROM nurture_touches WHERE id = $1', [touch.id]);
  assert.equal(t2.status, 'posted', 'can be retried once the campaign is fixed');
});

test('approve: a lead already active in another campaign is blocked, never double-touched', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes({ lead: { ok: false, reason: 'in_other_campaign' } });
  const { env, touch } = await postedTouch(pg, svc, clientId, f);
  const r = await svc.approveTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps });
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.reason, 'in_other_campaign');
  assert.equal(f.calls.imports.length, 0);
});

test('approve: an unsubscribed lead exits nurture', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes({ lead: { ok: false, reason: 'unsubscribed' } });
  const { lead, env, touch } = await postedTouch(pg, svc, clientId, f);
  await svc.approveTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps });
  const { rows: [after] } = await pg.query('SELECT stage, exit_reason FROM nurture_leads WHERE id = $1', [lead.id]);
  assert.equal(after.stage, 'exited');
  assert.equal(after.exit_reason, 'unsubscribed');
  assert.equal(f.calls.imports.length, 0);
});

test('approve: a lead who replied or was DQ\'d after the card posted is blocked at click time', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env, touch } = await postedTouch(pg, svc, clientId, f);
  const src = (await pg.query('SELECT * FROM pending_replies WHERE id = $1', [lead.source_reply_id])).rows[0];
  await addReply(pg, clientId, { classification: 'MEETING_PROPOSED', lead_email: src.lead_email, lead_id: src.lead_id, created_at: new Date(NOW - MIN) });
  const r = await svc.approveTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps });
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.reason, 'positive_reply');
  assert.equal(f.calls.imports.length, 0);
  const { rows: [after] } = await pg.query('SELECT stage FROM nurture_leads WHERE id = $1', [lead.id]);
  assert.equal(after.stage, 'paused');
});

test('approve: a Smartlead error leaves the card open to retry and queues nothing twice', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  f.deps.smartleadNurture.importNurtureLead = async () => { throw new Error('boom'); };
  const { env, touch } = await postedTouch(pg, svc, clientId, f);
  const r = await svc.approveTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps });
  assert.equal(r.outcome, 'smartlead_error');
  const { rows: [t2] } = await pg.query('SELECT status FROM nurture_touches WHERE id = $1', [touch.id]);
  assert.equal(t2.status, 'posted');
});

test('edit: the edited text is checked, then approved; a bad edit is refused', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { env, touch } = await postedTouch(pg, svc, clientId, f);
  const good = `Hey Pat, quick one: still want to take a look?\n\n${'We guarantee meetings, or we keep working until you hit them.'}\n\nJosh Osborn`;
  const view = (subject, body) => ({
    user: { id: APPROVER },
    view: { private_metadata: JSON.stringify({ touchId: touch.id }), state: { values: {
      subject_block: { subject_input: { value: subject } }, body_block: { body_input: { value: body } },
    } } },
  });
  assert.ok(svc.validateEditSubmission(view('Pat?', 'Hey Pat, free proof of concept\n\nJosh Osborn')));
  assert.ok(svc.validateEditSubmission(view('Pat?', `${good.replace('quick one:', 'quick one \u2014')}`)));
  assert.equal(svc.validateEditSubmission(view('Pat?', good)), null);
  const r = await svc.handleEditSubmit(view('Pat?', good), { now: NOW, env, deps: f.deps });
  assert.equal(r.outcome, 'queued');
  assert.equal(f.calls.imports[0][2].body, good);
  const { rows: [t2] } = await pg.query('SELECT body FROM nurture_touches WHERE id = $1', [touch.id]);
  assert.equal(t2.body, good);
});

test('skip: no email goes out, the lead moves on, and a second click does nothing', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { lead, env, touch } = await postedTouch(pg, svc, clientId, f);
  const r = await svc.skipTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps });
  assert.equal(r.outcome, 'skipped');
  assert.equal(f.calls.imports.length, 0);
  const { rows: [after] } = await pg.query('SELECT stage FROM nurture_leads WHERE id = $1', [lead.id]);
  assert.equal(after.stage, 'day90');
  assert.equal((await svc.skipTouch(touch.id, APPROVER, { now: NOW, env, deps: f.deps })).outcome, 'already_handled');
});

test('button routing: approve, skip and edit-modal actions reach the right handler', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  const { env, touch } = await postedTouch(pg, svc, clientId, f);
  const modal = await svc.handleButton({ action_id: 'nurture_d30_edit', value: touch.id }, { user: { id: APPROVER }, trigger_id: 'T1' }, { env, deps: f.deps });
  assert.equal(modal.outcome, 'modal_opened');
  assert.equal(f.calls.modals[0].trigger_id, 'T1');
  assert.equal(f.calls.modals[0].view.callback_id, 'nurture_d30_edit_modal');
  const approved = await svc.handleButton({ action_id: 'nurture_d30_approve', value: touch.id }, { user: { id: APPROVER } }, { now: NOW, env, deps: f.deps });
  assert.equal(approved.outcome, 'queued');
});

test('status endpoint data reports flags and counts only', { skip }, async () => {
  const { pg, svc, clientId } = await setup();
  const f = fakes();
  await enrolled(pg, svc, clientId, f);
  const s = await svc.status({ env: { ...BASE_ENV, NURTURE_CLIENT_IDS: clientId } });
  assert.equal(s.flags.NURTURE_ENABLED, true);
  assert.equal(s.flags.NURTURE_POST_ENABLED, false);
  assert.equal(s.flags.NURTURE_SEND_ENABLED, false);
  assert.equal(s.flags.NURTURE_HUBSPOT_SYNC_ENABLED, false);
  assert.deepEqual(s.byStage, [{ stage: 'day30', n: 1 }]);
  assert.ok(!JSON.stringify(s).includes('@'), 'no lead emails in the status');
});
