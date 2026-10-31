'use strict';

/**
 * The client day-of brief is written the way Josh's own "Brief:" emails are written
 * (EA's LLM routine -> send-brief). These tests use synthetic people and an injected
 * model. No network, no keys, no real lead names.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SYSTEM,
  writerInput,
  normalizeWritten,
  writeClientBriefSections,
  writerConfigured,
} = require('../src/services/client-brief-writer');
const {
  buildClientDayofBrief,
  assembleBriefFacts,
  gatherBriefFacts,
  mergeFacts,
} = require('../src/services/client-dayof-brief');

const START = '2026-10-31T14:30:00.000Z';

function row(over = {}) {
  return {
    id: 'meet-1',
    client_name: 'Example Roofing Partners',
    lead_full_name: 'Jordan Hale',
    lead_name: 'Jordan Hale',
    lead_email: 'jordan.hale@northwind-roofing.example',
    lead_title: 'Owner',
    lead_company: 'Northwind Roofing Co.',
    lead_phone: '(214) 555-0148',
    linkedin_url: 'https://www.linkedin.com/in/jordan-hale-example',
    lead_website: 'https://northwind-roofing.example',
    lead_location: 'Rockwall, TX',
    campaign_name: 'Spring Owners Big Campaign 1031',
    platform: 'smartlead',
    inbound_message: 'Saturday works. Can you walk us through how this works first?',
    sent_reply: 'Two times are open on our side this week.',
    confirmed_time: START,
    created_at: '2026-10-28T15:00:00.000Z',
    updated_at: '2026-10-28T15:30:00.000Z',
    meeting_link: 'https://us06web.zoom.us/j/00000000000',
    digest_timezone: 'America/Chicago',
    icp_verdict: { status: 'qualified', reason: 'commercial roofer' },
    ...over,
  };
}

const GOOD = {
  who: [
    'Jordan Hale, Owner, Northwind Roofing Co. (family business since 2004)',
    'Rockwall, TX. Commercial and storm-restoration roofing for property managers and GCs',
    'jordan.hale@northwind-roofing.example | (214) 555-0148 | https://www.linkedin.com/in/jordan-hale-example',
    'Owner, so the decision maker. Commercial roofer, a fit for you',
  ],
  why: [
    'Replied to our outreach Oct 28 and asked how this works first',
    'Picked Sat 9:30am CT from the two times we offered',
  ],
  rapport: [
    'Third generation in the family business',
    'Army veteran, avid hunter',
    'Local team is the Cowboys \u2014 easy opener on the season',
  ],
  openers: [
    '"How did the hunt go this year?"',
    '"Where does new commercial work come from today: property managers, owners or GCs?"',
  ],
  allo: ['Allo had no history: no calls, texts or voicemails with (214) 555-0148'],
  fireflies: ['No prior Fireflies transcripts mention Northwind Roofing Co. First call'],
  logistics: [
    'Sat Oct 31, 9:30am CT (Zoom)',
    'Join: https://us06web.zoom.us/j/00000000000',
    'No prior no-shows on file',
  ],
};

const llmReturning = (obj) => async () => JSON.stringify(obj);

describe('client brief writer: same sections and look as Josh\'s send-brief emails', () => {
  it('renders the same shell, h3 titles, order and plain bullets', async () => {
    const facts = assembleBriefFacts(row());
    facts.written = await writeClientBriefSections(facts, { results: [], siteText: '' }, { llm: llmReturning(GOOD) });
    const out = buildClientDayofBrief(facts);
    assert.match(out.subject, /^Brief: Jordan Hale and Example Roofing Partners @ 9:30am CT$/);
    assert.ok(out.htmlBody.startsWith("<div style='font-family:Arial,sans-serif;font-size:14px'>"));
    const titles = [...out.htmlBody.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
    assert.deepEqual(titles, ['Who', "Why you're meeting", 'Rapport hooks', 'Easy openers', 'Allo', 'Fireflies / Cube', 'Logistics']);
    assert.equal(out.htmlBody.includes('<a '), false, 'links print as plain text, like the real emails');
    assert.match(out.htmlBody, /<h3>Who<\/h3><ul><li>Jordan Hale, Owner/);
    assert.match(out.textBody, /^Brief: Jordan Hale/);
    assert.match(out.textBody, /Rapport hooks\n- Third generation in the family business\n- Army veteran/);
    assert.match(out.textBody, /Easy openers\n- "How did the hunt go this year\?"/);
  });

  it('keeps the new content types out of the mechanical placeholders', async () => {
    const facts = assembleBriefFacts(row());
    facts.written = await writeClientBriefSections(facts, {}, { llm: llmReturning(GOOD) });
    const out = buildClientDayofBrief(facts);
    assert.equal(out.textBody.includes('Nothing personal on file'), false);
    assert.equal(out.textBody.includes('They asked:'), false);
  });

  it('drops internal-only lines: LTV, pricing, other clients, campaign, unsubscribe', () => {
    const input = writerInput(assembleBriefFacts(row()));
    const written = normalizeWritten({
      ...GOOD,
      why: [
        'Replied Oct 28',
        'Should clear the $36K LTV bar',
        'Smartlead shows him unsubscribed after he replied',
        'Source campaign Spring Owners Big Campaign 1031',
      ],
      openers: ['Proof to lean on: Kyle at another client, four bid invitations in a day', '"Where does new work come from?"'],
    }, input);
    assert.deepEqual(written.why, ['Replied Oct 28']);
    assert.deepEqual(written.openers, ['"Where does new work come from?"']);
  });

  it('drops a bullet that names a link, email or phone the lookups never found', () => {
    const input = writerInput(assembleBriefFacts(row()));
    const written = normalizeWritten({
      ...GOOD,
      logistics: [
        'Sat Oct 31, 9:30am CT (Zoom)',
        'Join: https://us06web.zoom.us/j/99999999999',
        'Cell 312-859-1559',
        'Reach him at someone.else@elsewhere.example',
        'Join: https://us06web.zoom.us/j/00000000000',
      ],
    }, input);
    assert.deepEqual(written.logistics, ['Sat Oct 31, 9:30am CT (Zoom)', 'Join: https://us06web.zoom.us/j/00000000000']);
  });

  it('removes em and en dashes the way the brief routine requires', () => {
    const input = writerInput(assembleBriefFacts(row()));
    const written = normalizeWritten({ ...GOOD, rapport: ['Local team is the Cowboys \u2014 easy opener', 'Open 9\u20135'] }, input);
    assert.deepEqual(written.rapport, ['Local team is the Cowboys, easy opener', 'Open 9, 5']);
  });

  it('never lets the model write a call or transcript that was not found', async () => {
    const facts = assembleBriefFacts(row());
    facts.history.callNotes = 'No calls on file.';
    facts.history.firefliesChecked = true;
    const lie = { ...GOOD, allo: ['Cayden called him Oct 26 and left a voicemail'], fireflies: ['Josh met him Oct 20 for 30 minutes'] };
    const written = await writeClientBriefSections(facts, {}, { llm: llmReturning(lie) });
    assert.equal(written.allo, undefined);
    assert.equal(written.fireflies, undefined);
    facts.written = written;
    const out = buildClientDayofBrief(facts);
    assert.match(out.textBody, /Allo had no history: no calls, texts or voicemails with \(214\) 555-0148\./);
    assert.match(out.textBody, /No prior Fireflies transcripts mention Northwind Roofing Co\. First call\./);
    assert.equal(out.textBody.includes('Cayden called'), false);
  });

  it('keeps real call and transcript lines when the lookups found some', async () => {
    const facts = assembleBriefFacts(row());
    facts.history.callLines = ['Oct 26, 1:37pm CT: Cayden outbound, left a voicemail about the booking link'];
    facts.history.firefliesLines = ['Josh x Northwind intro, Oct 20'];
    const written = await writeClientBriefSections(facts, {}, {
      llm: llmReturning({ ...GOOD, allo: ['One call: Cayden, Oct 26 1:37pm CT, outbound, left a voicemail about the booking link'], fireflies: ['Josh x Northwind intro, Oct 20'] }),
    });
    assert.match(written.allo[0], /Cayden, Oct 26/);
    assert.match(written.fireflies[0], /Oct 20/);
  });

  it('falls back to the plain sections when the model fails or returns junk', async () => {
    const facts = assembleBriefFacts(row());
    for (const llm of [async () => { throw new Error('down'); }, async () => 'not json', async () => '{"who":"x"}']) {
      let written = null;
      try { written = await writeClientBriefSections(facts, {}, { llm }); } catch { written = null; }
      assert.equal(written, null);
    }
    const out = buildClientDayofBrief(facts);
    assert.match(out.textBody, /Who\n- Jordan Hale/);
    assert.match(out.textBody, /Logistics\n- /);
  });

  it('does not show the model the campaign name, and tells it not to quote our pricing', () => {
    const input = writerInput(assembleBriefFacts(row()));
    assert.equal(JSON.stringify(input).includes('Spring Owners Big Campaign'), false);
    assert.match(SYSTEM, /Never include: our pricing/);
    assert.match(SYSTEM, /Who, Why you're meeting, Rapport hooks, Easy openers, Allo, Fireflies \/ Cube, Logistics/);
  });

  it('gather runs the writer on the hold and the preview, with web results and site text', async () => {
    let seenInput = null;
    const deps = {
      async searchWeb(q) {
        return [{ title: `About ${q.split(' ')[0]}`, snippet: 'Army veteran. Avid hunter.', link: 'https://news.example/jordan' }];
      },
      async fetchSiteText() { return 'Northwind Roofing Co. Family owned since 2004. Commercial roofing across north Texas.'; },
      async searchCalls() { return []; },
      async searchTranscripts() { return []; },
      llm: async ({ user }) => { seenInput = user; return JSON.stringify(GOOD); },
    };
    const facts = await gatherBriefFacts(row({ lead_website: '' , lead_email: 'jordan.hale@northwind-roofing.example' }), { env: {}, deps });
    assert.ok(seenInput, 'the model was called');
    assert.match(seenInput, /Army veteran/);
    assert.match(seenInput, /Family owned since 2004/);
    assert.equal(seenInput.includes('Spring Owners Big Campaign'), false);
    assert.equal(facts.written.rapport.length, 3);
  });

  it('a reviewer can edit written bullets before release', () => {
    const facts = assembleBriefFacts(row());
    facts.written = { rapport: ['Old line'] };
    const merged = mergeFacts(facts, { written: { rapport: ['New hook one', 'New hook two'] } });
    assert.deepEqual(merged.written.rapport, ['New hook one', 'New hook two']);
  });

  it('is off without a key, so tests and dry runs never call a model', () => {
    assert.equal(writerConfigured({}), false);
    assert.equal(writerConfigured({ OPENROUTER_API_KEY: 'x' }), true);
    assert.equal(writerConfigured({ ANTHROPIC_API_KEY: 'x' }), true);
  });
});
