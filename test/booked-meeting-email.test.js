const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const gmail = require('../src/services/gmail-send');
const {
  DEFAULT_TO,
  NO_SUMMARY,
  recipient,
  parseBookedMeetingPayload,
  buildBookedMeetingEmail,
  handleBookedMeetingEmail,
  _resetSeenForTests,
} = require('../src/services/booked-meeting-email');

function payload(over = {}) {
  return {
    event: 'booked_meeting_email',
    booking_id: 41,
    allo_call_id: 'cll-1',
    caller: 'Gabe Lopez',
    client: 'SalesGlider',
    list: 'SalesGlider3 Central',
    call_at: '2026-10-27T15:30:00Z',
    summary: 'Pat agreed to a demo Thursday.\nSend the calendar invite.',
    summary_source: 'allo_calls',
    recording_url: 'https://allo.example.test/r/1',
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

describe('booked meeting email: payload parsing', () => {
  it('accepts a complete payload', () => {
    const r = parseBookedMeetingPayload(payload());
    assert.equal(r.ok, true);
    assert.equal(r.value.prospect.email, 'pat@example.test');
    assert.equal(r.value.caller, 'Gabe Lopez');
  });

  it('rejects other events and payloads with no booking id', () => {
    assert.deepEqual(parseBookedMeetingPayload({ event: 'booking_confirmed' }), { ok: false, error: 'unsupported_event' });
    assert.deepEqual(parseBookedMeetingPayload(null), { ok: false, error: 'unsupported_event' });
    assert.deepEqual(
      parseBookedMeetingPayload(payload({ booking_id: null, allo_call_id: null })),
      { ok: false, error: 'missing_booking_id' },
    );
  });

  it('drops non-https recording links and flattens newlines in header-ish fields', () => {
    const r = parseBookedMeetingPayload(payload({
      recording_url: 'javascript:alert(1)',
      prospect: { name: 'Pat\r\nBcc: x@example.test', company: 'Co' },
    }));
    assert.equal(r.value.recordingUrl, '');
    assert.equal(r.value.prospect.name, 'Pat Bcc: x@example.test');
  });
});

describe('booked meeting email: content', () => {
  it('lists name, company, email, phone, title and the Allo summary', () => {
    const { subject, text, html } = buildBookedMeetingEmail(parseBookedMeetingPayload(payload()).value);
    assert.equal(subject, 'Meeting booked: Example Mechanical (SalesGlider) via Gabe');
    for (const want of ['Name: Pat Example', 'Company: Example Mechanical', 'Title: Owner', 'Email: pat@example.test', 'Phone: (555) 111-2222']) {
      assert.ok(text.includes(want), `text has ${want}`);
    }
    assert.ok(text.includes('Pat agreed to a demo Thursday.\nSend the calendar invite.'));
    assert.ok(text.includes('Booked by: Gabe Lopez'));
    assert.ok(text.includes('Call time: Tue, Oct 27, 10:30 AM CT'));
    assert.ok(html.includes('mailto:pat@example.test'));
    assert.ok(html.includes('Call recording'));
  });

  it('marks missing fields and a missing summary instead of leaving blanks', () => {
    const m = parseBookedMeetingPayload(payload({
      summary: '',
      recording_url: null,
      prospect: { name: 'Pat Example', company: '', email: '', phone: '', title: '' },
    })).value;
    const { subject, text, html } = buildBookedMeetingEmail(m);
    assert.equal(subject, 'Meeting booked: Pat Example (SalesGlider) via Gabe');
    assert.ok(text.includes('Email: -') && text.includes('Phone: -') && text.includes('Title: -'));
    assert.ok(text.includes(NO_SUMMARY));
    assert.ok(!html.includes('Call recording'));
  });

  it('escapes HTML in every field', () => {
    const m = parseBookedMeetingPayload(payload({
      summary: '<script>alert(1)</script>',
      prospect: { name: '<b>Pat</b>', company: 'A & B', email: 'x@example.test', phone: '', title: '' },
    })).value;
    const { html } = buildBookedMeetingEmail(m);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&lt;b&gt;Pat&lt;/b&gt;'));
    assert.ok(html.includes('A &amp; B'));
  });
});

describe('booked meeting email: sending', () => {
  beforeEach(() => _resetSeenForTests());

  it('sends once to the fixed recipient and dedupes a repeat of the same booking', async () => {
    const sent = [];
    const send = async (m) => { sent.push(m); };
    const a = await handleBookedMeetingEmail(payload({ to: 'attacker@example.test' }), { send, env: {} });
    const b = await handleBookedMeetingEmail(payload(), { send, env: {} });
    assert.deepEqual(a, { status: 200, body: { ok: true, sent: true } });
    assert.deepEqual(b, { status: 200, body: { ok: true, deduped: true } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, DEFAULT_TO);
    assert.ok(sent[0].subject.startsWith('Meeting booked:'));
    assert.ok(sent[0].htmlBody && sent[0].textBody);
  });

  it('honors BOOKED_MEETING_EMAIL_TO', async () => {
    assert.equal(recipient({ BOOKED_MEETING_EMAIL_TO: ' ops@example.test ' }), 'ops@example.test');
    assert.equal(recipient({ BOOKED_MEETING_EMAIL_TO: '' }), DEFAULT_TO);
  });

  it('returns 502 and does not mark the booking sent when Gmail fails, so a retry can send', async () => {
    const calls = [];
    const failing = async () => { calls.push('fail'); throw new Error('Gmail send failed (403)'); };
    const bad = await handleBookedMeetingEmail(payload(), { send: failing, env: {} });
    assert.deepEqual(bad, { status: 502, body: { ok: false, error: 'send_failed' } });
    const ok = await handleBookedMeetingEmail(payload(), { send: async () => { calls.push('ok'); }, env: {} });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, ['fail', 'ok']);
  });

  it('400s a bad payload without sending', async () => {
    let called = false;
    const r = await handleBookedMeetingEmail({ event: 'nope' }, { send: async () => { called = true; }, env: {} });
    assert.equal(r.status, 400);
    assert.equal(called, false);
  });
});

describe('booked meeting email: route', () => {
  const realSend = gmail.sendMail;
  const realSecret = process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
  let server;
  let base;
  let sent;

  beforeEach(async () => {
    _resetSeenForTests();
    sent = [];
    gmail.sendMail = async (m) => { sent.push(m); return { ok: true }; };
    process.env.BOOKING_BRIDGE_WEBHOOK_SECRET = 'test-secret-value';
    const app = express();
    app.use(express.json());
    app.use(require('../src/routes/booking-bridge-recap'));
    await new Promise((r) => { server = http.createServer(app).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    gmail.sendMail = realSend;
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

  it('sends the email with the right bearer secret', async () => {
    const res = await post('Bearer test-secret-value', payload());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, DEFAULT_TO);
  });
});
