const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.BOOKED_BRIEF_DATA = 'off';
const {
  stripQuoted, threadFrom, timelineText, normalizeSynthesis, gatherBrief, domainOf, meetingLabel, synthesize,
} = require('../src/services/booked-brief-data');
const { buildBookedBrief } = require('../src/services/booked-brief');
const {
  DEFAULT_TO, buildRecipients, isClientFacing, parseBookedMeetingPayload, handleBookedMeetingEmail, _resetSeenForTests,
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
    for (const needle of ['HVAC installer', 'Ask about capacity', 'Yes, lets talk']) {
      assert.ok(sent[0].htmlBody.includes(needle), `html should include ${needle}`);
      assert.ok(sent[0].textBody.includes(needle), `text should include ${needle}`);
    }
    // A client is on To: the campaign never reaches them (Josh, Oct 31).
    assert.ok(!sent[0].htmlBody.includes('Central TX Owners') && !sent[0].textBody.includes('Central TX Owners'));
    assert.ok(!/how they booked/i.test(sent[0].htmlBody) && !/how they booked/i.test(sent[0].textBody));
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

describe('booked brief: campaign details are hidden from clients (Josh, Oct 31)', () => {
  const CAMPAIGN = 'Synthetic Campaign Alpha';
  const MAILBOX = 'sender@mailbox-fixture.test';
  const brief = (over = {}) => ({
    clientName: 'Fixture Client',
    prospect: { name: 'Sam Sample', company: 'Sample Co', title: 'Owner', email: 'sam@sample.test' },
    when: { label: 'Fri, Nov 6 at 1:00 PM CT', where: '', bookedLabel: '' },
    company: { website: 'https://sample.test', whatTheyDo: 'Makes samples', notes: [] },
    how: { client: 'Fixture Client', channel: 'Cold email, then Calendly booking page', campaign: CAMPAIGN, hook: 'Fixture hook', sender: MAILBOX, timeline: 'first email Mon', category: 'Meeting request' },
    thread: [], talkingPoints: ['Ask about their schedule', `Mention the ${CAMPAIGN} offer`, `Replied to ${MAILBOX}`, 'We pulled this from Smartlead', 'Confirm the decision maker'],
    watchOuts: ['Check the title', 'Allo logged a missed call'],
    links: [{ label: 'Email thread', url: 'campaign 111, lead 222' }, { label: 'Company', url: 'https://sample.test' }, { label: 'LinkedIn', url: 'https://www.linkedin.com/in/sample-fixture' }],
    ...over,
  });
  const SECTION_LABELS = ['HOW THEY BOOKED', 'Reply category', 'Hook:', 'Timeline:', 'Sender:'];

  it('client send: no How they booked section in text or html, and no campaign/lead id link', () => {
    const { htmlBody, textBody } = buildBookedBrief(brief({ clientFacing: true }));
    for (const out of [htmlBody, textBody]) {
      assert.ok(!/how they booked/i.test(out));
      assert.ok(!out.includes('Reply category') && !out.includes('Fixture hook') && !out.includes('first email Mon'));
      assert.ok(!out.includes(CAMPAIGN) && !out.includes(MAILBOX));
      assert.ok(!/Email thread|campaign 111|lead 222/.test(out), 'no campaign id / lead id link');
      assert.ok(out.includes('https://sample.test') && out.includes('sample-fixture'), 'Company and LinkedIn links stay');
      assert.ok(out.includes('Ask about their schedule') && out.includes('Confirm the decision maker') && out.includes('Check the title'));
    }
    for (const l of SECTION_LABELS) assert.ok(!textBody.includes(l), `${l} must not appear`);
  });

  it('client send: talking points and watch-outs naming the campaign, mailbox or a tool are dropped', () => {
    const { htmlBody, textBody } = buildBookedBrief(brief({ clientFacing: true }));
    for (const out of [htmlBody, textBody]) {
      assert.ok(!/smartlead|allo logged|mailbox-fixture/i.test(out));
    }
    assert.match(textBody, /1\. Ask about their schedule\n2\. Confirm the decision maker/);
  });

  it('internal send (Josh and Cayden only): the full section and the thread link stay', () => {
    for (const over of [{ clientFacing: false }, {}]) {
      const { htmlBody, textBody } = buildBookedBrief(brief(over));
      for (const out of [htmlBody, textBody]) {
        assert.ok(/how they booked/i.test(out));
        for (const needle of [CAMPAIGN, MAILBOX, 'Fixture hook', 'Meeting request', 'first email Mon', 'campaign 111, lead 222']) {
          assert.ok(out.includes(needle), `internal brief should include ${needle}`);
        }
      }
      for (const label of ['Client:', 'Channel:', 'Campaign:', 'Hook:', 'Sender:', 'Timeline:', 'Reply category:']) {
        assert.ok(textBody.includes(label), `${label} stays on internal sends`);
      }
    }
  });

  it('gatherBrief keeps the campaign name away from the model and the thread link out on client sends', async () => {
    const seenPrompts = [];
    const stubs = {
      sl: {
        lookupLeadByEmail: async () => ({ leadId: '222', campaignIds: ['111'], lead: {} }),
        pickLeadCampaign: () => '111',
        getThreadHistory: async () => ({ history: [] }),
        resolveCampaignName: async () => CAMPAIGN,
      },
      search: async () => [], siteText: async () => '',
      llm: async ({ user }) => { seenPrompts.push(user); return JSON.stringify({ talking_points: ['Ask about timing'] }); },
      db: { query: async () => ({ rows: [] }) }, google: {}, env: {},
    };
    const m = parseBookedMeetingPayload(calendlyPayload()).value;
    const client = await gatherBrief(m, { clients: [{ id: 'c1', smartlead_api_key: 'k' }], clientFacing: true }, stubs);
    assert.ok(!seenPrompts[0].includes(CAMPAIGN), 'campaign withheld from the model');
    assert.ok(!client.links.some((l) => l.label === 'Email thread'));
    const internal = await gatherBrief(m, { clients: [{ id: 'c1', smartlead_api_key: 'k' }] }, stubs);
    assert.ok(seenPrompts[1].includes(CAMPAIGN));
    assert.ok(internal.links.some((l) => l.label === 'Email thread'));
  });

  it('isClientFacing: a client address on To counts; Josh, Cayden and other team addresses do not', () => {
    assert.equal(isClientFacing({ to: ['owner@client.test'], josh: DEFAULT_TO, cc: [OPS] }), true);
    assert.equal(isClientFacing({ to: [DEFAULT_TO], josh: DEFAULT_TO, cc: [OPS] }), false);
    assert.equal(isClientFacing({ to: [DEFAULT_TO, OPS], josh: DEFAULT_TO, cc: [OPS] }), false);
    assert.equal(isClientFacing({ to: ['someone@salesglidergrowth.com'], josh: DEFAULT_TO, cc: [OPS] }), false);
    assert.equal(isClientFacing({ to: [DEFAULT_TO, 'owner@client.test'], josh: DEFAULT_TO, cc: [OPS] }), true);
  });

  const handlerDeps = (sent, always) => ({
    send: async (x) => { sent.push(x); }, env: {},
    resolveCc: async () => ({ clients: ['Acme Client'], always, rows: [] }),
    highlightsFn: async () => null, linkedinFn: async () => '',
    briefDataFn: async (m, ctx) => ({
      clientName: 'Acme Client', prospect: { name: 'Pat Example', company: 'Example Mechanical', email: 'pat@example.test' },
      when: { label: 'Fri, Nov 6 at 1:00 PM CT' }, company: {},
      how: { client: 'Acme Client', channel: 'Cold email', campaign: CAMPAIGN, hook: 'Fixture hook', sender: MAILBOX, timeline: 'first email Mon', category: 'Meeting request' },
      thread: [], talkingPoints: [], watchOuts: [],
      links: [{ label: 'Email thread', url: 'campaign 111, lead 222' }],
    }),
  });

  it('handler: client on To hides the section; the no-notify_emails fallback to Josh and Cayden keeps it', async () => {
    _resetSeenForTests();
    const clientSent = [];
    const a = await handleBookedMeetingEmail(calendlyPayload({ booking_id: 301 }), handlerDeps(clientSent, ['owner@client.test']));
    assert.equal(a.status, 200);
    assert.deepEqual(clientSent[0].to, ['owner@client.test']);
    for (const out of [clientSent[0].htmlBody, clientSent[0].textBody]) {
      assert.ok(!/how they booked/i.test(out) && !out.includes(CAMPAIGN) && !out.includes('lead 222'));
    }
    const internalSent = [];
    const b = await handleBookedMeetingEmail(calendlyPayload({ booking_id: 302 }), handlerDeps(internalSent, []));
    assert.equal(b.status, 200);
    assert.deepEqual(internalSent[0].to, [DEFAULT_TO]);
    for (const out of [internalSent[0].htmlBody, internalSent[0].textBody]) {
      assert.ok(/how they booked/i.test(out) && out.includes(CAMPAIGN) && out.includes('lead 222'));
    }
  });

  it('handler dry_run reports client_facing for both cases and sends nothing', async () => {
    _resetSeenForTests();
    const sent = [];
    const c = await handleBookedMeetingEmail(calendlyPayload({ dry_run: true, booking_id: 303 }), handlerDeps(sent, ['owner@client.test']));
    const i = await handleBookedMeetingEmail(calendlyPayload({ dry_run: true, booking_id: 304 }), handlerDeps(sent, []));
    assert.equal(c.body.client_facing, true);
    assert.equal(i.body.client_facing, false);
    assert.ok(!/HOW THEY BOOKED/.test(c.body.textBody) && /HOW THEY BOOKED/.test(i.body.textBody));
    assert.equal(sent.length, 0);
  });
});
