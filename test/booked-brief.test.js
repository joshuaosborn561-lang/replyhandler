const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.BOOKED_BRIEF_DATA = 'off';
const {
  stripQuoted, threadFrom, timelineText, normalizeSynthesis, gatherBrief, domainOf, meetingLabel, synthesize,
} = require('../src/services/booked-brief-data');
const { buildBookedBrief } = require('../src/services/booked-brief');
const {
  DEFAULT_TO, buildRecipients, parseBookedMeetingPayload, handleBookedMeetingEmail, _resetSeenForTests,
} = require('../src/services/booked-meeting-email');

const OPS = 'cayden@salesglidergrowth.com';
const GABE = 'gabe@salesglidergrowth.com';

describe('booked brief: recipients always include Josh', () => {
  it('Josh lands on To when the client has no list, and on CC when it does', () => {
    const none = buildRecipients({ always: [], josh: DEFAULT_TO, cc: [OPS, GABE] });
    assert.deepEqual(none.to, [DEFAULT_TO]);
    const withList = buildRecipients({ always: ['a@client.test'], josh: DEFAULT_TO, cc: [OPS, GABE] });
    assert.deepEqual(withList.to, ['a@client.test']);
    assert.ok(withList.cc.includes(DEFAULT_TO));
  });
  it('Josh is never listed twice', () => {
    const r = buildRecipients({ always: [DEFAULT_TO, 'a@client.test'], josh: DEFAULT_TO, cc: [OPS, GABE, DEFAULT_TO] });
    const all = [...r.to, ...r.cc];
    assert.equal(all.filter((e) => e === DEFAULT_TO).length, 1);
  });
});

describe('booked brief: thread helpers', () => {
  it('stripQuoted keeps what the person wrote and drops quoted history and footers', () => {
    const t = 'Sounds good, Thursday works.\n\nOn Mon, Oct 26, 2026 at 9:00 AM Rep <rep@x.test> wrote:\n> old stuff\n> more';
    assert.equal(stripQuoted(t), 'Sounds good, Thursday works.');
    assert.equal(stripQuoted('Yes.\n\nCONFIDENTIALITY NOTICE: blah'), 'Yes.');
    assert.equal(stripQuoted(''), '');
  });

  const history = {
    history: [
      { type: 'REPLY', time: '2026-10-27T15:00:00Z', from: 'pat@example.test', email_body: '<p>Interested, send times.</p>' },
      { type: 'SENT', time: '2026-10-26T15:00:00Z', from: 'rep@client.test', email_body: 'Hi Pat, quick question.' },
      { type: 'OPEN', time: '2026-10-26T16:00:00Z', email_body: 'ignored' },
    ],
  };
  it('threadFrom orders messages oldest first, keeps only sent and replies, labels direction', () => {
    const t = threadFrom(history, { clientName: 'Acme' });
    assert.deepEqual(t.map((m) => m.direction), ['out', 'in']);
    assert.equal(t[0].from, 'Acme (sent)');
    assert.equal(t[1].body, 'Interested, send times.');
  });
  it('timelineText says how long each step took', () => {
    const t = threadFrom(history, { clientName: 'Acme' });
    const text = timelineText(t, '2026-10-28T15:00:00Z');
    assert.match(text, /first email/);
    assert.match(text, /first reply 24 hours later/);
    assert.match(text, /booked 2 days after the first email/);
  });
  it('domainOf ignores consumer mail', () => {
    assert.equal(domainOf('pat@example.test'), 'example.test');
    assert.equal(domainOf('pat@gmail.com'), '');
  });
  it('meetingLabel is empty without a usable time', () => {
    assert.equal(meetingLabel('nonsense'), '');
    assert.match(meetingLabel('2026-10-29T20:00:00Z', '2026-10-29T20:30:00Z'), /CT/);
  });
});

describe('booked brief: synthesis', () => {
  it('normalizeSynthesis drops numbers the model put in front of talking points', () => {
    const out = normalizeSynthesis({ talking_points: ['1. Ask why they booked.', '2) Confirm the role.', '3 sentences is not a number prefix'] });
    assert.deepEqual(out.talkingPoints, ['Ask why they booked.', 'Confirm the role.', '3 sentences is not a number prefix']);
  });

  it('normalizeSynthesis returns null for junk and trims lists', () => {
    assert.equal(normalizeSynthesis(null), null);
    assert.equal(normalizeSynthesis({}), null);
    const out = normalizeSynthesis({ company: { what_they_do: 'HVAC contractor' }, talking_points: ['a', '', 'b'], watch_outs: [] });
    assert.equal(out.whatTheyDo, 'HVAC contractor');
    assert.deepEqual(out.talkingPoints, ['a', 'b']);
  });
  it('synthesize parses model JSON through an injected llm', async () => {
    const out = await synthesize({ clientName: 'Acme', web: { results: [], siteText: '' }, prospect: {}, crm: {} }, {
      llm: async () => '```json\n{"company":{"what_they_do":"Plumbing"},"talking_points":["Ask about backlog"]}\n```',
    });
    assert.equal(out.whatTheyDo, 'Plumbing');
    assert.deepEqual(out.talkingPoints, ['Ask about backlog']);
  });
});

function calendlyPayload(over = {}) {
  return {
    event: 'booked_meeting_email',
    booking_id: 77,
    platform: 'calendly',
    client: 'Acme Client',
    list: 'Acme Central Owners',
    meeting_at: '2026-10-30T19:00:00Z',
    booked_at: '2026-10-28T14:00:00Z',
    smartlead_campaign_id: '111',
    smartlead_lead_id: '222',
    prospect: { name: 'Pat Example', company: 'Example Mechanical', email: 'pat@example.test', title: 'Owner' },
    ...over,
  };
}

describe('booked brief: non-call booking (Calendly)', () => {
  it('the payload carries platform, meeting and booking times, and the Smartlead ids', () => {
    const m = parseBookedMeetingPayload(calendlyPayload()).value;
    assert.equal(m.platform, 'calendly');
    assert.equal(m.meetingAt, '2026-10-30T19:00:00.000Z');
    assert.equal(m.bookedAt, '2026-10-28T14:00:00.000Z');
  });

  const stubs = {
    sl: {
      lookupLeadByEmail: async () => ({ leadId: '222', campaignIds: ['111'], lead: { company_name: 'Example Mechanical', location: 'Austin, TX' } }),
      pickLeadCampaign: (want) => want || '111',
      getThreadHistory: async () => ({
        history: [
          { type: 'SENT', time: '2026-10-26T15:00:00Z', from: 'rep@client.test', email_body: 'Hi Pat' },
          { type: 'REPLY', time: '2026-10-26T18:00:00Z', from: 'pat@example.test', email_body: 'Yes, lets talk' },
        ],
      }),
      resolveCampaignName: async () => 'Central TX Owners',
    },
    search: async () => [{ title: 'Example Mechanical', snippet: 'HVAC in Austin' }],
    siteText: async () => 'We install HVAC.',
    llm: async () => JSON.stringify({ company: { what_they_do: 'HVAC installer', size: 'about 20 people' }, talking_points: ['Ask about capacity'], watch_outs: ['Wants evenings'] }),
    db: { query: async () => ({ rows: [] }) },
    google: {},
    env: {},
  };

  it('gatherBrief builds the brief from a thread, research and a model, with injected deps', async () => {
    const m = parseBookedMeetingPayload(calendlyPayload()).value;
    const data = await gatherBrief(m, { clients: [{ id: 'c1', smartlead_api_key: 'k' }] }, stubs);
    assert.equal(data.how.campaign, 'Central TX Owners');
    assert.equal(data.thread.length, 2);
    assert.match(data.how.channel, /Calendly/);
    assert.equal(data.company.whatTheyDo, 'HVAC installer');
    assert.deepEqual(data.talkingPoints, ['Ask about capacity']);
    assert.match(data.when.label, /CT/);
  });

  it('gatherBrief survives every lookup failing', async () => {
    const boom = async () => { throw new Error('down'); };
    const m = parseBookedMeetingPayload(calendlyPayload({ meeting_at: undefined })).value;
    const data = await gatherBrief(m, { clients: [] }, {
      sl: { lookupLeadByEmail: boom, pickLeadCampaign: boom, getThreadHistory: boom, resolveCampaignName: boom },
      search: boom, siteText: boom, llm: boom, db: { query: boom }, google: {}, env: {},
    });
    assert.equal(data.thread.length, 0);
    assert.equal(data.when.label, '');
    assert.equal(data.when.fallback, 'See the calendar invite.');
  });

  it('the email goes to the client list with Josh copied, in the brief format, and says Calendly', async () => {
    _resetSeenForTests();
    const sent = [];
    const r = await handleBookedMeetingEmail(calendlyPayload(), {
      send: async (x) => { sent.push(x); },
      env: {},
      resolveCc: async () => ({ clients: ['Acme Client'], always: ['owner@client.test'], rows: [] }),
      highlightsFn: async () => null,
      linkedinFn: async () => '',
      briefDataFn: async (m, ctx) => gatherBrief(m, { ...ctx, clients: [{ id: 'c1', smartlead_api_key: 'k' }] }, stubs),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(sent[0].to, ['owner@client.test']);
    assert.ok(sent[0].cc.includes(DEFAULT_TO) && sent[0].cc.includes(OPS) && !sent[0].cc.includes(GABE), 'Cayden and Josh copied, not Gabe');
    assert.match(sent[0].subject, /^Meeting booked: Pat Example/);
    for (const needle of ['Central TX Owners', 'HVAC installer', 'Ask about capacity', 'Yes, lets talk']) {
      assert.ok(sent[0].htmlBody.includes(needle), `html should include ${needle}`);
      assert.ok(sent[0].textBody.includes(needle), `text should include ${needle}`);
    }
  });

  it('still sends a minimal brief when the data step throws', async () => {
    _resetSeenForTests();
    const sent = [];
    const r = await handleBookedMeetingEmail(calendlyPayload({ booking_id: 78 }), {
      send: async (x) => { sent.push(x); },
      env: {},
      resolveCc: async () => ({ clients: [], always: [], rows: [] }),
      highlightsFn: async () => null,
      linkedinFn: async () => '',
      briefDataFn: async () => { throw new Error('everything is down'); },
    });
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [DEFAULT_TO]);
  });
});

describe('booked brief: ops test modes', () => {
  const deps = (sent) => ({
    send: async (x) => { sent.push(x); }, env: {}, resolveCc: async () => ({ clients: ['Acme Client'], always: ['owner@client.test'], rows: [] }),
    highlightsFn: async () => null, linkedinFn: async () => '', briefDataFn: async () => { throw new Error('skip'); },
  });
  it('dry_run returns the brief and sends nothing', async () => {
    _resetSeenForTests();
    const sent = [];
    const r = await handleBookedMeetingEmail(calendlyPayload({ dry_run: true, booking_id: 90 }), deps(sent));
    assert.equal(r.body.dry_run, true);
    assert.equal(sent.length, 0);
  });
  it('josh_only sends a single copy to Josh, never the client, and does not dedupe the real send', async () => {
    _resetSeenForTests();
    const sent = [];
    await handleBookedMeetingEmail(calendlyPayload({ josh_only: true, booking_id: 91 }), deps(sent));
    assert.deepEqual(sent[0].to, [DEFAULT_TO]);
    assert.deepEqual(sent[0].cc, []);
    assert.match(sent[0].subject, /^\[TEST\] Meeting booked/);
    const real = await handleBookedMeetingEmail(calendlyPayload({ booking_id: 91 }), deps(sent));
    assert.equal(real.body.sent, true);
  });
});

describe('booked brief: rendering', () => {
  it('omits empty sections, prints "not found" for missing facts, escapes html', () => {
    const { htmlBody, textBody, subject } = buildBookedBrief({
      clientName: 'Acme <b>', prospect: { name: 'Pat <script>', company: '', title: '', email: 'p@x.test' },
      when: { label: '', fallback: 'See the calendar invite.' }, company: {}, how: { client: 'Acme', channel: 'Cold email' },
      thread: [], talkingPoints: [], watchOuts: [], links: [], meeting: {}, smartlead: {},
    });
    assert.ok(!htmlBody.includes('<script>'));
    assert.match(subject, /^Meeting booked: /);
    assert.ok(!/LinkedIn/.test(textBody), 'no LinkedIn row when none was found');
    assert.ok(!/Suggested talking points/i.test(htmlBody), 'empty sections are dropped');
    assert.match(textBody, /See the calendar invite\./);
  });
});
