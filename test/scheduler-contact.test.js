const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.BOOKED_BRIEF_DATA = 'off';
const { resolveSchedulerContact, answersFrom, sameEmail } = require('../src/services/scheduler-contact');
const { handleBookedMeetingEmail, parseBookedMeetingPayload, displayNameFor, _resetSeenForTests } = require('../src/services/booked-meeting-email');

const fakeFetch = (status, body, calls = []) => async (url, opts) => {
  calls.push({ url, opts });
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

describe('scheduler contact lookup', () => {
  it('reads the booker from a TidyCal booking (unwrapped body)', async () => {
    const calls = [];
    const hit = await resolveSchedulerContact(
      { platform: 'tidycal', bookingId: '123', email: 'Pat@Example.test' },
      { env: { TIDYCAL_API_TOKEN: 'tok' }, fetchImpl: fakeFetch(200, { id: 123, starts_at: '2026-11-02T20:00:00Z', contact: { name: 'Pat Example', email: 'pat@example.test' }, questions: [{ question: 'Company name', answer: 'Example Hotels' }] }, calls) },
    );
    assert.equal(hit.name, 'Pat Example');
    assert.equal(hit.company, 'Example Hotels');
    assert.equal(hit.startsAt, '2026-11-02T20:00:00Z');
    assert.equal(calls[0].url, 'https://tidycal.com/api/bookings/123');
    assert.match(calls[0].opts.headers.Authorization, /^Bearer tok$/);
  });

  it('sends a long (JWT-sized) token whole', async () => {
    const calls = [];
    const long = 'x'.repeat(1500);
    await resolveSchedulerContact(
      { platform: 'tidycal', bookingId: '1', email: '' },
      { env: { TIDYCAL_API_TOKEN: ` ${long}\n` }, fetchImpl: fakeFetch(200, { contact: { name: 'A B' } }, calls) },
    );
    assert.equal(calls[0].opts.headers.Authorization, `Bearer ${long}`);
  });

  it('accepts a wrapped {data} body', async () => {
    const hit = await resolveSchedulerContact(
      { platform: 'tidycal', bookingId: '5', email: '' },
      { env: { TIDYCAL_API_TOKEN: 'tok' }, fetchImpl: fakeFetch(200, { data: { contact: { name: 'Sam Roe', email: 'sam@x.test' } } }) },
    );
    assert.equal(hit.name, 'Sam Roe');
  });

  it('never takes another person\'s name: a different email returns null', async () => {
    const hit = await resolveSchedulerContact(
      { platform: 'tidycal', bookingId: '5', email: 'pat@example.test' },
      { env: { TIDYCAL_API_TOKEN: 'tok' }, fetchImpl: fakeFetch(200, { contact: { name: 'Someone Else', email: 'else@example.test' } }) },
    );
    assert.equal(hit, null);
  });

  it('is inert without a token or a numeric id, and never throws on an API error', async () => {
    const calls = [];
    assert.equal(await resolveSchedulerContact({ platform: 'tidycal', bookingId: '5' }, { env: {}, fetchImpl: fakeFetch(200, {}, calls) }), null);
    assert.equal(await resolveSchedulerContact({ platform: 'tidycal', bookingId: 'abc' }, { env: { TIDYCAL_API_TOKEN: 't' }, fetchImpl: fakeFetch(200, {}, calls) }), null);
    assert.equal(calls.length, 0);
    assert.equal(await resolveSchedulerContact({ platform: 'tidycal', bookingId: '5' }, { env: { TIDYCAL_API_TOKEN: 't' }, fetchImpl: fakeFetch(500, {}) }), null);
    assert.equal(await resolveSchedulerContact({ platform: 'savvycal', bookingId: '5' }, { env: { TIDYCAL_API_TOKEN: 't' }, fetchImpl: fakeFetch(200, {}) }), null);
  });

  it('reads a Calendly invitee, and only from api.calendly.com', async () => {
    const calls = [];
    const env = { CALENDLY_API_TOKEN: 'c' };
    const hit = await resolveSchedulerContact(
      { platform: 'calendly', inviteeUri: 'https://api.calendly.com/scheduled_events/A/invitees/B', email: 'pat@example.test' },
      { env, fetchImpl: fakeFetch(200, { resource: { name: 'Pat Example', email: 'pat@example.test', questions_and_answers: [{ question: 'Organization', answer: 'Example Co' }] } }, calls) },
    );
    assert.equal(hit.name, 'Pat Example');
    assert.equal(hit.company, 'Example Co');
    const off = await resolveSchedulerContact(
      { platform: 'calendly', inviteeUri: 'https://evil.test/x', email: 'pat@example.test' },
      { env, fetchImpl: fakeFetch(200, { resource: { name: 'X' } }, calls) },
    );
    assert.equal(off, null);
    assert.equal(calls.length, 1);
  });

  it('pulls company, title and phone from the form answers', () => {
    const a = answersFrom([
      { question: 'What company do you work for?', answer: 'Acme' },
      { question: 'Your job title', answer: 'COO' },
      { question: 'Phone number for a text', answer: '+1 402 555 0100' },
      { question: 'Anything else?', answer: '' },
    ]);
    assert.deepEqual([a.company, a.title, a.phone], ['Acme', 'COO', '+1 402 555 0100']);
    assert.equal(sameEmail('A@x.test', 'a@X.test'), true);
    assert.equal(sameEmail('a@x.test', 'b@x.test'), false);
  });
});

describe('booked meeting email for a scheduler booking', () => {
  const scheduler = (over = {}) => ({
    event: 'booked_meeting_email',
    booking_id: 254,
    client: 'vector',
    client_slug: 'vector',
    platform: 'tidycal',
    meeting_at: '2026-11-02T20:00:00Z',
    booked_at: '2026-10-30T15:54:59Z',
    scheduler_booking_id: '777',
    prospect: { name: '', company: '', email: 'pat@example.test', phone: '', title: '' },
    ...over,
  });
  const base = (extra = {}) => ({
    send: async () => {}, env: {}, now: Date.now(),
    resolveCc: async () => ({ clients: [], always: [], rows: [] }),
    highlightsFn: async () => null,
    ...extra,
  });

  it('parses the scheduler ids', () => {
    const r = parseBookedMeetingPayload(scheduler({ scheduler_invitee_uri: 'https://api.calendly.com/x' }));
    assert.equal(r.value.schedulerBookingId, '777');
    assert.equal(r.value.schedulerInviteeUri, 'https://api.calendly.com/x');
  });

  it('names the booker from the scheduler and looks up LinkedIn with that name', async () => {
    _resetSeenForTests();
    const sent = [];
    const li = [];
    const out = await handleBookedMeetingEmail(scheduler(), base({
      send: async (m) => sent.push(m),
      contactFn: async () => ({ name: 'Pat Example', company: 'Example Hotels', title: '', phone: '', email: 'pat@example.test', startsAt: '' }),
      linkedinFn: async (m) => { li.push(m.prospect.name); return ''; },
    }));
    assert.equal(out.status, 200);
    assert.match(sent[0].subject, /^Meeting booked: Pat Example/);
    assert.match(sent[0].textBody, /Name: Pat Example/);
    assert.match(sent[0].textBody, /Company: Example Hotels/);
    assert.deepEqual(li, ['Pat Example']);
  });

  it('skips the paid LinkedIn lookup when nobody knows the name', async () => {
    _resetSeenForTests();
    const sent = [];
    let lookups = 0;
    await handleBookedMeetingEmail(scheduler({ booking_id: 255 }), base({
      send: async (m) => sent.push(m),
      contactFn: async () => null,
      linkedinFn: async () => { lookups += 1; return 'https://www.linkedin.com/in/someone-else'; },
    }));
    assert.equal(lookups, 0);
    assert.doesNotMatch(sent[0].textBody, /linkedin\.com/i);
    // the subject falls back to the booker's email, not the word "Prospect"
    assert.match(sent[0].subject, /^Meeting booked: pat@example\.test/);
  });

  it('shows the client\'s real name, not the bare slug', async () => {
    _resetSeenForTests();
    const sent = [];
    await handleBookedMeetingEmail(scheduler({ booking_id: 256 }), base({
      send: async (m) => sent.push(m),
      contactFn: async () => null,
      linkedinFn: async () => '',
    }));
    assert.match(sent[0].subject, /Vector Energy Group$/);
    assert.equal(displayNameFor({ clientSlug: 'vector', clientDisplay: 'vector', client: 'vector' }, [{ name: 'Matched Client' }]), 'Matched Client');
    assert.equal(displayNameFor({ clientSlug: 'emcor', clientDisplay: 'EMCOR', client: 'Emcor' }, []), 'EMCOR');
  });

  it('does not ask a scheduler about a cold-call booking', async () => {
    _resetSeenForTests();
    let asked = 0;
    await handleBookedMeetingEmail(scheduler({ booking_id: 257, platform: 'allo', allo_call_id: 'c1', scheduler_booking_id: '9' }), base({
      send: async () => {}, contactFn: async () => { asked += 1; return null; }, linkedinFn: async () => '',
    }));
    assert.equal(asked, 0);
  });
});
