const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const gmail = require('../src/services/gmail-send');
const db = require('../src/db');
const { FYI_NOTES_LINE } = require('../src/utils/fyi-notify');
const { buildClientNotifyEmail } = require('../src/services/client-notify-email');
const {
  DEFAULT_TO,
  NO_SUMMARY,
  recipient,
  parseBookedMeetingPayload,
  buildBookedMeetingEmail,
  buildRecipients,
  resolveClientAlwaysCc,
  handleBookedMeetingEmail,
  _resetSeenForTests,
} = require('../src/services/booked-meeting-email');

function payload(over = {}) {
  return {
    event: 'booked_meeting_email',
    booking_id: 41,
    allo_call_id: 'cll-1',
    caller: 'Gabe Lopez',
    client: 'Acme Client',
    client_slug: 'acmeclient',
    list: 'Acme Central Owners',
    call_at: '2026-10-27T15:30:00Z',
    summary: 'Pat agreed to a demo Thursday.\nSend the calendar invite.',
    summary_source: 'allo_calls',
    prospect: {
      name: 'Pat Example',
      company: 'Example Mechanical',
      email: 'pat@example.test',
      phone: '(555) 111-2222',
      title: 'Owner',
    },
    ...over,
  };
}

const noCc = async () => ({ clients: [], always: [] });
const withCc = (...emails) => async () => ({ clients: ['Acme Client'], always: emails });

describe('booked meeting email: payload parsing', () => {
  it('accepts a complete payload', () => {
    const r = parseBookedMeetingPayload(payload());
    assert.equal(r.ok, true);
    assert.equal(r.value.prospect.email, 'pat@example.test');
    assert.equal(r.value.clientSlug, 'acmeclient');
  });

  it('rejects other events and payloads with no booking id', () => {
    assert.deepEqual(parseBookedMeetingPayload({ event: 'booking_confirmed' }), { ok: false, error: 'unsupported_event' });
    assert.deepEqual(parseBookedMeetingPayload(null), { ok: false, error: 'unsupported_event' });
    assert.deepEqual(
      parseBookedMeetingPayload(payload({ booking_id: null, allo_call_id: null })),
      { ok: false, error: 'missing_booking_id' },
    );
  });

  it('flattens newlines in header-ish fields', () => {
    const r = parseBookedMeetingPayload(payload({ prospect: { name: 'Pat\r\nBcc: x@example.test', company: 'Co' } }));
    assert.equal(r.value.prospect.name, 'Pat Bcc: x@example.test');
  });
});

describe('booked meeting email: content matches the positive-reply notify email', () => {
  const reply = buildClientNotifyEmail({
    leadName: 'Pat Example',
    clientName: 'Acme Client',
    campaignName: 'Acme Central Owners',
    enrichment: { email: 'pat@example.test', phone: '(555) 111-2222' },
    threadContext: null,
    inboundMessage: 'Sounds good',
    sentText: 'Great',
  });
  const booked = buildBookedMeetingEmail(parseBookedMeetingPayload(payload()).value);

  it('uses the same subject style: "<Kind>: Name · Client"', () => {
    assert.equal(reply.subject, 'Prospect reply: Pat Example · Acme Client');
    assert.equal(booked.subject, 'Meeting booked: Pat Example · Acme Client');
  });

  it('shares the wrapper style, FYI line, notes line, and Prospect/section headings', () => {
    const wrapper = reply.htmlBody.match(/^<div style="[^"]+">/)[0];
    assert.ok(booked.htmlBody.startsWith(wrapper), 'same outer container style');
    assert.ok(booked.htmlBody.includes('<p>FYI — Gabe just booked a meeting with <strong>Pat Example</strong> (Acme Central Owners).</p>'));
    assert.ok(reply.htmlBody.includes(`<p>${FYI_NOTES_LINE}</p>`) && booked.htmlBody.includes(`<p>${FYI_NOTES_LINE}</p>`));
    assert.ok(booked.htmlBody.includes('<h3 style="margin:18px 0 8px;font-size:14px;">Prospect</h3>'));
    assert.ok(booked.htmlBody.includes('border:1px solid #e5e7eb;border-radius:6px'), 'same card style as Thread');
    assert.ok(booked.textBody.includes(FYI_NOTES_LINE));
  });

  it('lists name, company, title, email, cell and the Allo summary', () => {
    for (const want of ['Name: Pat Example', 'Company: Example Mechanical', 'Title: Owner', 'Email: pat@example.test', 'Cell: (555) 111-2222']) {
      assert.ok(booked.textBody.includes(want), `text has ${want}`);
    }
    assert.ok(booked.textBody.includes('Pat agreed to a demo Thursday.\nSend the calendar invite.'));
    assert.ok(booked.textBody.includes('Booked on the call · Tue, Oct 27, 10:30 AM CT'));
    assert.ok(booked.htmlBody.includes('Pat agreed to a demo Thursday.\nSend the calendar invite.'));
  });

  it('marks missing fields "not found" and a missing summary instead of leaving blanks', () => {
    const m = parseBookedMeetingPayload(payload({
      summary: '',
      prospect: { name: 'Pat Example', company: '', email: '', phone: '', title: '' },
    })).value;
    const b = buildBookedMeetingEmail(m);
    assert.ok(b.textBody.includes('Email: not found') && b.textBody.includes('Cell: not found') && b.textBody.includes('Title: not found'));
    assert.ok(b.textBody.includes(NO_SUMMARY));
    assert.ok(b.htmlBody.includes('color:#999;">not found'));
  });

  it('falls back to the company in the subject when the contact has no name', () => {
    const m = parseBookedMeetingPayload(payload({ prospect: { name: '', company: 'Example Mechanical' } })).value;
    assert.equal(buildBookedMeetingEmail(m).subject, 'Meeting booked: Example Mechanical · Acme Client');
  });

  it('escapes HTML in every field', () => {
    const m = parseBookedMeetingPayload(payload({
      summary: '<script>alert(1)</script>',
      list: 'A & B',
      prospect: { name: '<b>Pat</b>', company: 'A & B', email: 'x@example.test', phone: '', title: '' },
    })).value;
    const { htmlBody } = buildBookedMeetingEmail(m);
    assert.ok(!htmlBody.includes('<script>') && !htmlBody.includes('<b>Pat</b>'));
    assert.ok(htmlBody.includes('&lt;script&gt;') && htmlBody.includes('&lt;b&gt;Pat&lt;/b&gt;'));
    assert.ok(htmlBody.includes('A &amp; B'));
  });
});

describe('booked meeting email: recipients', () => {
  it('To = client always-CC, CC = Josh', () => {
    assert.deepEqual(
      buildRecipients({ always: ['client@example.test', 'second@example.test'], josh: DEFAULT_TO }),
      { to: ['client@example.test', 'second@example.test'], cc: [DEFAULT_TO] },
    );
  });

  it('no always-CC means Josh only', () => {
    assert.deepEqual(buildRecipients({ always: [], josh: DEFAULT_TO }), { to: [DEFAULT_TO], cc: [] });
  });

  it('Josh is never duplicated or dropped when he is on the client list', () => {
    assert.deepEqual(
      buildRecipients({ always: [DEFAULT_TO, 'client@example.test'], josh: DEFAULT_TO }),
      { to: ['client@example.test'], cc: [DEFAULT_TO] },
    );
    assert.deepEqual(buildRecipients({ always: [DEFAULT_TO], josh: DEFAULT_TO }), { to: [DEFAULT_TO], cc: [] });
  });

  it('honors BOOKED_MEETING_EMAIL_TO', () => {
    assert.equal(recipient({ BOOKED_MEETING_EMAIL_TO: ' ops@example.test ' }), 'ops@example.test');
    assert.equal(recipient({ BOOKED_MEETING_EMAIL_TO: '' }), DEFAULT_TO);
  });

  it('resolves active clients by slug alias and exact name and merges always-CC lists', async () => {
    const seenArgs = [];
    const query = async (sql, args) => {
      seenArgs.push({ sql, args });
      return {
        rows: [
          { name: 'Goliath', cc_emails: 'a@example.test, B@example.test', cc_email: 'a@example.test' },
          { name: 'Goliath Cybersecurity', cc_emails: null, cc_email: 'b@example.test' },
        ],
      };
    };
    const r = await resolveClientAlwaysCc({ clientSlug: 'goliath', clientName: 'Goliath Cybersecurity' }, { query });
    assert.deepEqual(r.always, ['a@example.test', 'b@example.test']);
    assert.ok(/active IS DISTINCT FROM false/.test(seenArgs[0].sql), 'inactive duplicates excluded');
    assert.ok(seenArgs[0].args[0].includes('goliath') && seenArgs[0].args[0].includes('goliath cybersecurity'));
  });

  it('falls back to the legacy cc_email and returns nothing when the client has none', async () => {
    const legacy = await resolveClientAlwaysCc({ clientSlug: '', clientName: 'Some Client' }, {
      query: async () => ({ rows: [{ name: 'Some Client', cc_emails: '', cc_email: 'owner@example.test' }] }),
    });
    assert.deepEqual(legacy.always, ['owner@example.test']);
    const none = await resolveClientAlwaysCc({ clientSlug: '', clientName: 'Some Client' }, {
      query: async () => ({ rows: [{ name: 'Some Client', cc_emails: null, cc_email: null }] }),
    });
    assert.deepEqual(none.always, []);
    let called = false;
    const unnamed = await resolveClientAlwaysCc({ clientSlug: '', clientName: '' }, { query: async () => { called = true; return { rows: [] }; } });
    assert.deepEqual(unnamed.always, []);
    assert.equal(called, false, 'no query without a client to look up');
  });
});

describe('booked meeting email: sending', () => {
  beforeEach(() => _resetSeenForTests());

  it('sends to the client always-CC with Josh on CC, never to an address from the request', async () => {
    const sent = [];
    const send = async (m) => { sent.push(m); };
    const a = await handleBookedMeetingEmail(
      payload({ to: 'attacker@example.test', cc: 'attacker@example.test' }),
      { send, env: {}, resolveCc: withCc('client@example.test') },
    );
    assert.deepEqual(a, { status: 200, body: { ok: true, sent: true, to: ['client@example.test'], cc: [DEFAULT_TO] } });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['client@example.test']);
    assert.deepEqual(sent[0].cc, [DEFAULT_TO]);
    assert.equal(sent[0].replyTo, 'joshua@salesglidergrowth.com');
    assert.ok(sent[0].subject.startsWith('Meeting booked:'));
    assert.ok(sent[0].htmlBody && sent[0].textBody);
  });

  it('sends to Josh only when the client has no always-CC, and dedupes a repeat', async () => {
    const sent = [];
    const send = async (m) => { sent.push(m); };
    const a = await handleBookedMeetingEmail(payload(), { send, env: {}, resolveCc: noCc });
    const b = await handleBookedMeetingEmail(payload(), { send, env: {}, resolveCc: noCc });
    assert.deepEqual(a.body, { ok: true, sent: true, to: [DEFAULT_TO], cc: [] });
    assert.deepEqual(b, { status: 200, body: { ok: true, deduped: true } });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].cc, []);
  });

  it('a failed client lookup still sends Josh his copy', async () => {
    const sent = [];
    const r = await handleBookedMeetingEmail(payload(), {
      send: async (m) => { sent.push(m); },
      env: {},
      resolveCc: async () => { throw new Error('db down'); },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(sent[0].to, [DEFAULT_TO]);
  });

  it('returns 502 and does not mark the booking sent when Gmail fails, so a retry can send', async () => {
    const calls = [];
    const bad = await handleBookedMeetingEmail(payload(), {
      send: async () => { calls.push('fail'); throw new Error('Gmail send failed (403)'); },
      env: {},
      resolveCc: noCc,
    });
    assert.deepEqual(bad, { status: 502, body: { ok: false, error: 'send_failed' } });
    const ok = await handleBookedMeetingEmail(payload(), { send: async () => { calls.push('ok'); }, env: {}, resolveCc: noCc });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, ['fail', 'ok']);
  });

  it('400s a bad payload without sending', async () => {
    let called = false;
    const r = await handleBookedMeetingEmail({ event: 'nope' }, { send: async () => { called = true; }, env: {}, resolveCc: noCc });
    assert.equal(r.status, 400);
    assert.equal(called, false);
  });
});

describe('booked meeting email: route', () => {
  const realSend = gmail.sendMail;
  const realQuery = db.query;
  const realSecret = process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
  let server;
  let base;
  let sent;

  beforeEach(async () => {
    _resetSeenForTests();
    sent = [];
    gmail.sendMail = async (m) => { sent.push(m); return { ok: true }; };
    db.query = async () => ({ rows: [{ name: 'Acme Client', cc_emails: 'client@example.test', cc_email: 'client@example.test' }] });
    process.env.BOOKING_BRIDGE_WEBHOOK_SECRET = 'test-secret-value';
    const app = express();
    app.use(express.json());
    app.use(require('../src/routes/booking-bridge-recap'));
    await new Promise((r) => { server = http.createServer(app).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    gmail.sendMail = realSend;
    db.query = realQuery;
    if (realSecret === undefined) delete process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
    else process.env.BOOKING_BRIDGE_WEBHOOK_SECRET = realSecret;
    await new Promise((r) => server.close(r));
  });

  const post = (auth, body) => fetch(`${base}/webhook/booking-bridge/booked-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

  it('401s without the bearer secret and sends nothing', async () => {
    assert.equal((await post(null, payload())).status, 401);
    assert.equal((await post('Bearer wrong', payload())).status, 401);
    assert.equal(sent.length, 0);
  });

  it('503s when the secret is not configured', async () => {
    delete process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
    assert.equal((await post('Bearer anything', payload())).status, 503);
  });

  it('sends with the right bearer secret: client To, Josh CC', async () => {
    const res = await post('Bearer test-secret-value', payload());
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['client@example.test']);
    assert.deepEqual(sent[0].cc, [DEFAULT_TO]);
  });
});
