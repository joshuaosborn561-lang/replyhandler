const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.BOOKED_BRIEF_DATA = 'off'; // no network from the legacy handler tests
const gmail = require('../src/services/gmail-send');
const db = require('../src/db');
const { DEFAULT_FYI_CC_EMAILS } = require('../src/utils/fyi-notify');
const { buildClientNotifyEmail, BOOKED_NOTES_LINE } = require('../src/services/client-notify-email');
const { normalizeHighlights, generateHighlights } = require('../src/services/booked-meeting-highlights');
const {
  DEFAULT_TO,
  NO_SUMMARY,
  recipient,
  parseBookedMeetingPayload,
  buildBookedMeetingEmail,
  buildRecipients,
  bookedCcEmails,
  callerLabel,
  useClientName,
  resolveClientAlwaysCc,
  handleBookedMeetingEmail,
  _resetSeenForTests,
} = require('../src/services/booked-meeting-email');

const OPS = DEFAULT_FYI_CC_EMAILS;
const GABE = 'gabe@salesglidergrowth.com'; // never copied on a booked-meeting email (Josh, Oct 29)
const CC = [OPS];
const CC_JOSH = [OPS, DEFAULT_TO]; // Cayden and Josh; Josh is always on To or CC (Oct 29)
const noLinkedin = async () => '';

function payload(over = {}) {
  return {
    event: 'booked_meeting_email',
    booking_id: 41,
    allo_call_id: 'cll-1',
    caller: 'Gabe Lopez',
    client: 'Acme Client',
    client_slug: 'acmeclient',
    list: 'Acme Central Owners',
    transcript: 'USER: hi\nEXTERNAL: hello',
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

const noHighlights = async () => null;
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

  it('shares the wrapper, section headings and card styling; opener and notes line are for bookings', () => {
    const wrapper = reply.htmlBody.match(/^<div style="[^"]+">/)[0];
    assert.ok(booked.htmlBody.startsWith(wrapper), 'same outer container style');
    assert.ok(booked.htmlBody.includes('<p>FYI, we just booked a meeting with <strong>Pat Example</strong> at <strong>Example Mechanical</strong> through a cold call.</p>'));
    assert.ok(booked.textBody.startsWith('FYI, we just booked a meeting with Pat Example at Example Mechanical through a cold call.'));
    assert.ok(!booked.htmlBody.includes('Acme Central Owners') && !booked.textBody.includes('Acme Central Owners'), 'internal list name is not in the email');
    assert.ok(!booked.textBody.includes('Gabe'), 'no caller name in the opener');
    assert.ok(BOOKED_NOTES_LINE.includes('before the meeting'));
    assert.ok(booked.htmlBody.includes(`<p>${BOOKED_NOTES_LINE}</p>`) && booked.textBody.includes(BOOKED_NOTES_LINE));
    assert.ok(!booked.textBody.includes('notes on this reply'));
    assert.ok(booked.htmlBody.includes('<h3 style="margin:18px 0 8px;font-size:14px;">Prospect</h3>'));
    assert.ok(booked.htmlBody.includes('border:1px solid #e5e7eb;border-radius:6px'), 'same card style as Thread');
  });

  it('drops "at <company>" when either part is missing', () => {
    const noCompany = buildBookedMeetingEmail(parseBookedMeetingPayload(payload({ prospect: { name: 'Pat Example', company: '' } })).value);
    assert.ok(noCompany.textBody.startsWith('FYI, we just booked a meeting with Pat Example through a cold call.'));
    const noName = buildBookedMeetingEmail(parseBookedMeetingPayload(payload({ prospect: { name: '', company: 'Example Mechanical' } })).value);
    assert.ok(noName.textBody.startsWith('FYI, we just booked a meeting with Example Mechanical through a cold call.'));
  });

  it('lists name, company, title, email, cell and the Allo summary', () => {
    for (const want of ['Name: Pat Example', 'Company: Example Mechanical', 'Title: Owner', 'Email: pat@example.test', 'Cell: (555) 111-2222']) {
      assert.ok(booked.textBody.includes(want), `text has ${want}`);
    }
    assert.ok(booked.textBody.includes('Pat agreed to a demo Thursday.\nSend the calendar invite.'));
    assert.ok(booked.textBody.includes('Booked on a cold call · Tue, Oct 27, 10:30 AM CT'));
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

describe('booked meeting email: highlights', () => {
  const m = parseBookedMeetingPayload(payload()).value;
  const h = {
    painPoints: ['Past lead vendors never produced work.'],
    currentSetup: 'All work comes from referrals after 30 years in business.',
    objections: ['Does not trust paid lead services.'],
    nextStep: 'Phone call tomorrow at 4:30 PM.',
  };

  it('renders the short summary first, then Pain points / Current setup / Objections / Next step', () => {
    const b = buildBookedMeetingEmail(m, h);
    const t = b.textBody;
    assert.ok(t.indexOf('Pat agreed to a demo') < t.indexOf('Pain points:'));
    for (const want of ['Pain points:', '- Past lead vendors never produced work.', 'Current setup:', 'Objections:', 'Next step:', '- Phone call tomorrow at 4:30 PM.']) {
      assert.ok(t.includes(want), `text has ${want}`);
    }
    assert.ok(b.htmlBody.includes('<li>Past lead vendors never produced work.</li>'));
    assert.ok(b.htmlBody.indexOf('Pain points') < b.htmlBody.indexOf('Next step'));
  });

  it('falls back to the short summary alone without highlights, and says so with neither', () => {
    const b = buildBookedMeetingEmail(m, null);
    assert.ok(b.textBody.includes('Pat agreed to a demo') && !b.textBody.includes('Pain points'));
    const none = buildBookedMeetingEmail(parseBookedMeetingPayload(payload({ summary: '' })).value, null);
    assert.ok(none.textBody.includes(NO_SUMMARY));
  });

  it('highlights alone (no short summary) still render', () => {
    const b = buildBookedMeetingEmail(parseBookedMeetingPayload(payload({ summary: '' })).value, h);
    assert.ok(b.textBody.includes('Next step:') && !b.textBody.includes(NO_SUMMARY));
  });

  it('normalizeHighlights trims, caps, drops contact details and empty results', () => {
    const n = normalizeHighlights({
      pain_points: ['  a  ', '', 'call me at 555-111-2222', 'b', 'c', 'd', 'e'],
      current_setup: 'mail me at x@example.test',
      objections: [],
      next_step: ' Tomorrow 4:30 ',
    });
    assert.deepEqual(n.painPoints, ['a', 'b', 'c', 'd']);
    assert.equal(n.currentSetup, null);
    assert.equal(n.nextStep, 'Tomorrow 4:30');
    assert.equal(normalizeHighlights({ pain_points: [], current_setup: null, objections: [], next_step: null }), null);
    assert.equal(normalizeHighlights(null), null);
  });

  it('generateHighlights parses model JSON, and returns null without a transcript, on bad JSON, or on error', async () => {
    const seen = [];
    const llm = async (args) => { seen.push(args); return 'ok {"pain_points":["p"],"current_setup":null,"objections":[],"next_step":"n"} done'; };
    const r = await generateHighlights({ transcript: 'USER: hi', summary: 'short' }, { llm });
    assert.deepEqual(r, { painPoints: ['p'], currentSetup: null, objections: [], nextStep: 'n' });
    assert.ok(seen[0].user.includes('USER: hi') && seen[0].user.includes('short'));
    assert.equal(await generateHighlights({ transcript: '', summary: 's' }, { llm }), null);
    assert.equal(seen.length, 1, 'no LLM call without a transcript');
    assert.equal(await generateHighlights({ transcript: 't' }, { llm: async () => 'not json' }), null);
    assert.equal(await generateHighlights({ transcript: 't' }, { llm: async () => { throw new Error('boom'); } }), null);
    assert.equal(await generateHighlights({ transcript: 't' }, { llm: async () => null }), null);
  });
});

describe('booked meeting email: recipients', () => {
  it('To = client always-CC, CC = Cayden and Josh (no Gabe)', () => {
    assert.deepEqual(
      buildRecipients({ always: ['client@example.test', 'second@example.test'], josh: DEFAULT_TO, cc: CC }),
      { to: ['client@example.test', 'second@example.test'], cc: CC_JOSH },
    );
  });

  it('no always-CC means To Josh (he is the client), same CC', () => {
    assert.deepEqual(buildRecipients({ always: [], josh: DEFAULT_TO, cc: CC }), { to: [DEFAULT_TO], cc: CC });
    assert.deepEqual(buildRecipients({ always: [], josh: DEFAULT_TO, cc: [] }), { to: [DEFAULT_TO], cc: [] });
  });

  it('nobody is listed twice when Cayden is on the client list', () => {
    assert.deepEqual(
      buildRecipients({ always: [OPS, 'client@example.test'], josh: DEFAULT_TO, cc: CC }),
      { to: ['client@example.test'], cc: CC_JOSH },
    );
    assert.deepEqual(buildRecipients({ always: [DEFAULT_TO], josh: DEFAULT_TO, cc: CC }), { to: [DEFAULT_TO], cc: CC });
  });

  it('CC defaults to Cayden, honors BOOKED_MEETING_EMAIL_CC, and ignores the retired Gabe CC var', () => {
    assert.deepEqual(bookedCcEmails({}), [OPS]);
    assert.deepEqual(bookedCcEmails({ BOOKED_MEETING_EMAIL_CC: 'x@example.test, y@example.test' }), ['x@example.test', 'y@example.test']);
    assert.deepEqual(bookedCcEmails({ BOOKED_MEETING_EMAIL_CC: '' }), []);
    assert.deepEqual(bookedCcEmails({ BOOKED_MEETING_EMAIL_CC_EXTRA: GABE, FYI_CC_EMAILS: GABE }), [OPS], 'old Gabe vars no longer add anyone');
  });

  it('names whoever made the call, any Allo caller, and never needs an allowlist', () => {
    assert.equal(callerLabel({ caller: 'Cayden Martini' }), 'Cayden Martini');
    assert.equal(callerLabel({ caller: '  New   Caller ' }), 'New Caller');
    assert.equal(callerLabel({ caller: '' }), '');
    assert.equal(callerLabel({ caller: 'Unknown caller' }), '');
    assert.equal(callerLabel({}), '');
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

  it('sends to the client always-CC with Cayden and Josh on CC (not Gabe), never to an address from the request', async () => {
    const sent = [];
    const send = async (m) => { sent.push(m); };
    const a = await handleBookedMeetingEmail(
      payload({ to: 'attacker@example.test', cc: 'attacker@example.test' }),
      { send, env: {}, resolveCc: withCc('client@example.test'), highlightsFn: noHighlights, linkedinFn: noLinkedin },
    );
    assert.deepEqual(a, { status: 200, body: { ok: true, sent: true, to: ['client@example.test'], cc: CC_JOSH } });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['client@example.test']);
    assert.deepEqual(sent[0].cc, CC_JOSH);
    assert.ok(![...sent[0].to, ...sent[0].cc].includes(GABE), 'Gabe is not on the email');
    assert.equal(sent[0].replyTo, 'joshua@salesglidergrowth.com');
    assert.ok(sent[0].subject.startsWith('Meeting booked:'));
    assert.ok(sent[0].htmlBody && sent[0].textBody);
  });

  it('includes highlights from the transcript in the sent email, and still sends when generation fails', async () => {
    const sent = [];
    const send = async (m) => { sent.push(m); };
    const seen = [];
    const hl = { painPoints: ['Wants fewer vendor calls.'], currentSetup: null, objections: [], nextStep: 'Call tomorrow.' };
    await handleBookedMeetingEmail(payload(), { send, env: {}, resolveCc: noCc, highlightsFn: async (a) => { seen.push(a); return hl; }, linkedinFn: noLinkedin });
    assert.equal(seen[0].transcript, 'USER: hi\nEXTERNAL: hello');
    assert.ok(sent[0].textBody.includes('Pain points:') && sent[0].textBody.includes('- Call tomorrow.'));
    _resetSeenForTests();
    await handleBookedMeetingEmail(payload(), { send, env: {}, resolveCc: noCc, highlightsFn: async () => null, linkedinFn: noLinkedin });
    assert.equal(sent.length, 2);
    assert.ok(!sent[1].textBody.includes('Pain points:') && sent[1].textBody.includes('Pat agreed to a demo'));
  });

  it('sends to Josh only when the client has no always-CC, and dedupes a repeat', async () => {
    const sent = [];
    const send = async (m) => { sent.push(m); };
    const a = await handleBookedMeetingEmail(payload(), { send, env: {}, resolveCc: noCc, highlightsFn: noHighlights, linkedinFn: noLinkedin });
    const b = await handleBookedMeetingEmail(payload(), { send, env: {}, resolveCc: noCc, highlightsFn: noHighlights, linkedinFn: noLinkedin });
    assert.deepEqual(a.body, { ok: true, sent: true, to: [DEFAULT_TO], cc: CC });
    assert.deepEqual(b, { status: 200, body: { ok: true, deduped: true } });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].cc, CC);
  });

  it('a failed client lookup still sends Josh his copy', async () => {
    const sent = [];
    const r = await handleBookedMeetingEmail(payload(), {
      send: async (m) => { sent.push(m); },
      env: {},
      highlightsFn: noHighlights,
      linkedinFn: noLinkedin,
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
      highlightsFn: noHighlights,
      linkedinFn: noLinkedin,
    });
    assert.deepEqual(bad, { status: 502, body: { ok: false, error: 'send_failed' } });
    const ok = await handleBookedMeetingEmail(payload(), { send: async () => { calls.push('ok'); }, env: {}, resolveCc: noCc, highlightsFn: noHighlights, linkedinFn: noLinkedin });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, ['fail', 'ok']);
  });

  it('400s a bad payload without sending', async () => {
    let called = false;
    const r = await handleBookedMeetingEmail({ event: 'nope' }, { send: async () => { called = true; }, env: {}, resolveCc: noCc, highlightsFn: noHighlights, linkedinFn: noLinkedin });
    assert.equal(r.status, 400);
    assert.equal(called, false);
  });
});

describe('booked meeting email: route', () => {
  const realSend = gmail.sendMail;
  const realQuery = db.query;
  const realSecret = process.env.BOOKING_BRIDGE_WEBHOOK_SECRET;
  const realAnthropic = process.env.ANTHROPIC_API_KEY;
  let server;
  let base;
  let sent;

  beforeEach(async () => {
    _resetSeenForTests();
    sent = [];
    gmail.sendMail = async (m) => { sent.push(m); return { ok: true }; };
    db.query = async () => ({ rows: [{ name: 'Acme Client', cc_emails: 'client@example.test', cc_email: 'client@example.test' }] });
    process.env.BOOKING_BRIDGE_WEBHOOK_SECRET = 'test-secret-value';
    delete process.env.ANTHROPIC_API_KEY; // never call the LLM from a test
    process.env.BOOKED_MEETING_LINKEDIN_LOOKUP = 'off'; // never spend on a lookup from a test
    const app = express();
    app.use(express.json());
    app.use(require('../src/routes/booking-bridge-recap'));
    await new Promise((r) => { server = http.createServer(app).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    gmail.sendMail = realSend;
    db.query = realQuery;
    delete process.env.BOOKED_MEETING_LINKEDIN_LOOKUP;
    if (realAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = realAnthropic;
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

  it('sends with the right bearer secret: client To, Cayden and Josh CC', async () => {
    const res = await post('Bearer test-secret-value', payload());
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['client@example.test']);
    assert.deepEqual(sent[0].cc, CC_JOSH);
  });
});

describe('booked meeting email: any caller', () => {
  beforeEach(() => _resetSeenForTests());
  for (const name of ['Cayden Martini', 'Joshua Osborn', 'Gabe Lopez', 'Maria Newhire']) {
    it(`sends the same way and names ${name}`, async () => {
      const sent = [];
      const r = await handleBookedMeetingEmail(payload({ caller: name }), {
        send: async (m) => { sent.push(m); }, env: {}, resolveCc: withCc('client@example.test'), highlightsFn: noHighlights, linkedinFn: noLinkedin,
      });
      assert.equal(r.status, 200);
      assert.deepEqual(sent[0].to, ['client@example.test']);
      assert.deepEqual(sent[0].cc, CC_JOSH);
      assert.ok(sent[0].textBody.includes(`Booked on a cold call by ${name}`), 'the brief names the caller');
      assert.ok(sent[0].htmlBody.includes(`Booked on a cold call by ${name}`));
      for (const other of ['Cayden Martini', 'Joshua Osborn', 'Gabe Lopez', 'Maria Newhire']) {
        if (other !== name) assert.ok(!sent[0].textBody.includes(other), `${other} is not mentioned`);
      }
    });
  }

  it('a booking with no caller still sends, without a "by" line', async () => {
    const sent = [];
    await handleBookedMeetingEmail(payload({ caller: '' }), {
      send: async (m) => { sent.push(m); }, env: {}, resolveCc: noCc, highlightsFn: noHighlights, linkedinFn: noLinkedin,
    });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].textBody.includes('Booked on a cold call') && !/cold call by/.test(sent[0].textBody));
  });

  it('dry_run shows To and CC without sending', async () => {
    const sent = [];
    const r = await handleBookedMeetingEmail(payload({ caller: 'Maria Newhire', dry_run: true }), {
      send: async (m) => { sent.push(m); }, env: {}, resolveCc: withCc('client@example.test'), highlightsFn: noHighlights, linkedinFn: noLinkedin,
    });
    assert.equal(r.body.dry_run, true);
    assert.deepEqual(r.body.cc, CC_JOSH);
    assert.equal(sent.length, 0);
  });
});

describe('booked meeting email: LinkedIn', () => {
  beforeEach(() => _resetSeenForTests());
  const li = 'https://www.linkedin.com/in/pat-example';

  it('shows the LinkedIn URL from the payload and does not run a lookup', async () => {
    const sent = [];
    let lookups = 0;
    const body = payload();
    body.prospect.linkedin_url = li;
    await handleBookedMeetingEmail(body, {
      send: async (m) => { sent.push(m); }, env: {}, resolveCc: noCc, highlightsFn: noHighlights,
      linkedinFn: async () => { lookups += 1; return 'https://www.linkedin.com/in/other'; },
    });
    assert.equal(lookups, 0);
    assert.ok(sent[0].textBody.includes(`LinkedIn: ${li}`));
    assert.ok(sent[0].htmlBody.includes(`href="${li}"`));
  });

  it('falls back to the capped lookup when the payload has none', async () => {
    const sent = [];
    const seenArgs = [];
    await handleBookedMeetingEmail(payload(), {
      send: async (m) => { sent.push(m); }, env: {}, resolveCc: noCc, highlightsFn: noHighlights,
      linkedinFn: async (m) => { seenArgs.push(m.prospect.email); return li; },
    });
    assert.deepEqual(seenArgs, ['pat@example.test']);
    assert.ok(sent[0].textBody.includes(`LinkedIn: ${li}`));
  });

  it('omits the LinkedIn row when nothing is found, a lookup throws, or the value is not a profile URL', async () => {
    for (const linkedinFn of [async () => '', async () => { throw new Error('boom'); }, async () => 'https://example.test/not-linkedin']) {
      _resetSeenForTests();
      const sent = [];
      const r = await handleBookedMeetingEmail(payload(), {
        send: async (m) => { sent.push(m); }, env: {}, resolveCc: noCc, highlightsFn: noHighlights, linkedinFn,
      });
      assert.equal(r.status, 200);
      assert.ok(!/linkedin/i.test(sent[0].textBody) && !/linkedin/i.test(sent[0].htmlBody));
    }
  });

  it('ignores a non-LinkedIn URL in the payload', () => {
    const body = payload();
    body.prospect.linkedin_url = 'https://evil.example.test/in/x';
    assert.equal(parseBookedMeetingPayload(body).value.prospect.linkedinUrl, '');
  });
});

describe('booked meeting email: client name, never the caller-line brand', () => {
  beforeEach(() => _resetSeenForTests());
  const brandPayload = (over = {}) => payload({
    client: 'Emcor',
    client_display: 'EMCOR',
    client_slug: 'emcor',
    caller_brand: 'Mesa Energy',
    summary: 'HVAC vendor Mesa Energy offers free PM scope and requests a follow-up call.',
    ...over,
  });
  const brandHighlights = {
    painPoints: ['Mesa Energy could not reach him before.'],
    currentSetup: 'Two package units.',
    objections: ['Asked whether mesa energy was a new vendor.'],
    nextStep: 'Mesa Energy account executive calls Wednesday.',
  };

  it('replaces the caller-line brand with the client display name in the whole email', async () => {
    const sent = [];
    await handleBookedMeetingEmail(brandPayload(), {
      send: async (m) => { sent.push(m); }, env: {}, resolveCc: noCc, highlightsFn: async () => brandHighlights, linkedinFn: noLinkedin,
    });
    const all = `${sent[0].subject}\n${sent[0].textBody}\n${sent[0].htmlBody}`;
    assert.ok(!/mesa energy/i.test(all), 'brand must not appear anywhere');
    assert.ok(sent[0].subject.endsWith('· EMCOR'));
    assert.ok(sent[0].textBody.includes('HVAC vendor EMCOR offers free PM scope'));
    assert.ok(sent[0].textBody.includes('- EMCOR account executive calls Wednesday.'));
  });

  it('knows the EMCOR caller-line brand even when the payload does not carry it', () => {
    const m = parseBookedMeetingPayload(brandPayload({ caller_brand: undefined })).value;
    const { textBody } = buildBookedMeetingEmail(m, null);
    assert.ok(!/mesa energy/i.test(textBody) && textBody.includes('HVAC vendor EMCOR'));
  });

  it('tells the highlights model the client name and the call-line names to avoid', async () => {
    let seen;
    await handleBookedMeetingEmail(brandPayload(), {
      send: async () => {}, env: {}, resolveCc: noCc, linkedinFn: noLinkedin,
      highlightsFn: async (a) => { seen = a; return null; },
    });
    assert.equal(seen.clientName, 'EMCOR');
    assert.ok(seen.brands.includes('Mesa Energy'));
    let user = '';
    await generateHighlights({ transcript: 't', summary: 's', clientName: 'EMCOR', brands: ['Mesa Energy'] }, { llm: async (a) => { user = a.user; return null; } });
    assert.ok(user.includes('CLIENT: EMCOR') && user.includes('CALL-LINE NAMES: Mesa Energy'));
  });

  it('never rewrites the prospect\'s own company, even if it matches the brand', () => {
    const m = parseBookedMeetingPayload(brandPayload({ prospect: { name: 'Sam', company: 'Mesa Energy', email: '', phone: '', title: '' } })).value;
    const { textBody } = buildBookedMeetingEmail(m, null);
    assert.ok(textBody.includes('Company: Mesa Energy'));
    assert.ok(textBody.includes('HVAC vendor Mesa Energy offers'));
  });

  it('useClientName matches whole names only, case-insensitively', () => {
    assert.equal(useClientName('MESA ENERGY and Mesa Energy Group', { clientName: 'EMCOR', brands: ['Mesa Energy'] }), 'EMCOR and EMCOR Group');
    assert.equal(useClientName('Mesa Energyx', { clientName: 'EMCOR', brands: ['Mesa Energy'] }), 'Mesa Energyx');
    assert.equal(useClientName('plain', { clientName: '', brands: ['Mesa Energy'] }), 'plain');
  });
});
