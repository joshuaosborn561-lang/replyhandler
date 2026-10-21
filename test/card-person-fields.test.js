const test = require('node:test');
const assert = require('node:assert/strict');

const { timezoneForLocation, pickLocation, resolvePersonLocation } = require('../src/services/lead-location');
const {
  parseAiArkPerson, parseLinkedinSearchResult, matchesLead, lookupPersonProfile,
} = require('../src/services/person-profile-lookup');
const { leadFieldText, bestFullName } = require('../src/services/slack');
const {
  mergeCardPayload, patchPostedCard, rememberCard, completeCardLinks, applyCardLinks,
} = require('../src/services/slack-reply-post');
const { CONSUMER_DOMAINS } = require('../src/services/prospect-enrich');

test('time zone comes from the person location', () => {
  assert.equal(timezoneForLocation('Austin, Texas, United States'), 'America/Chicago');
  assert.equal(timezoneForLocation('Austin, TX'), 'America/Chicago');
  assert.equal(timezoneForLocation('Greater Boston'), 'America/New_York');
  assert.equal(timezoneForLocation('San Francisco Bay Area'), 'America/Los_Angeles');
  assert.equal(timezoneForLocation('Charleston, West Virginia'), 'America/New_York');
  assert.equal(timezoneForLocation('Denver, CO'), 'America/Denver');
  assert.equal(timezoneForLocation('Toronto, Ontario, Canada'), 'America/Toronto');
  assert.equal(timezoneForLocation('London, England, United Kingdom'), 'Europe/London');
  assert.equal(timezoneForLocation(''), null);
  assert.equal(timezoneForLocation('Somewhere'), null);
});

test('location picks person fields, including custom fields and city/state parts', () => {
  assert.equal(pickLocation({ custom_fields: { location: 'Tulsa, OK' } }), 'Tulsa, OK');
  assert.equal(pickLocation({ city: 'Tampa', state: 'FL' }), 'Tampa, FL');
  assert.equal(pickLocation({ company_name: 'x' }), null);
  assert.equal(resolvePersonLocation({ location: { default: 'Phoenix, Arizona' } }).timezone, 'America/Phoenix');
});

test('AI Ark and LinkedIn search results yield name, LinkedIn and location', () => {
  const p = parseAiArkPerson({ profile: { full_name: 'Pat Doe', location: { default: 'Dallas, Texas' } }, link: { linkedin: 'https://www.linkedin.com/in/patdoe' } });
  assert.equal(p.fullName, 'Pat Doe');
  assert.equal(p.linkedinUrl, 'https://www.linkedin.com/in/patdoe');
  assert.equal(p.location, 'Dallas, Texas');
  const hit = parseLinkedinSearchResult({
    link: 'https://www.linkedin.com/in/patdoe?trk=x',
    title: 'Pat Doe - Owner - Example Co | LinkedIn',
    snippet: 'Owner at Example Co · Location: Nashville, Tennessee · 500+ connections',
  });
  assert.equal(hit.linkedinUrl, 'https://www.linkedin.com/in/patdoe');
  assert.equal(hit.location, 'Nashville, Tennessee');
  assert.ok(matchesLead(hit, 'Pat Doe'));
  assert.ok(!matchesLead(hit, 'Sam Roe'));
});

test('profile lookup falls back to Serper when AI Ark misses', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ organic: [{ link: 'https://linkedin.com/in/pd', title: 'Pat Doe - Example', snippet: 'Location: Miami, Florida · 3 connections' }] }),
  });
  const r = await lookupPersonProfile(
    { email: 'pat@example.com', leadName: 'Pat Doe', companyName: 'Example' },
    { aiarkApi: { isConfigured: () => true, reverseLookupByEmail: async () => ({}) }, fetchImpl, env: { SERPER_API_KEY: 'x' } },
  );
  assert.equal(r.linkedinUrl, 'https://linkedin.com/in/pd');
  assert.equal(r.timezone, 'America/New_York');
});

test('card never says Website: not found when the email has a company domain', () => {
  const t = leadFieldText({ leadName: 'Pat', leadEmail: 'pat@example.com' });
  assert.match(t, /example\.com/);
  assert.doesNotMatch(t, /Website: not found/);
  assert.match(leadFieldText({ leadName: 'Pat', leadEmail: 'pat@gmail.com' }), /Website: not found/);
  assert.ok(CONSUMER_DOMAINS.test('aol.com'));
  assert.ok(!CONSUMER_DOMAINS.test('olive.com'));
});

test('card shows full name, location + time zone, and an alt phone', () => {
  const t = leadFieldText({
    leadName: 'Pat', leadFullName: 'Pat Doe', leadEmail: 'pat@example.com',
    leadPhoneAlt: '+15555550100', leadLocation: 'Dallas, Texas',
  });
  assert.match(t, /\*Pat Doe\*/);
  assert.match(t, /📍 Dallas, Texas · 🕒 C[SD]T \(America\/Chicago\)/);
  assert.match(t, /☎️ \+15555550100/);
  assert.match(leadFieldText({ leadName: 'Pat' }), /Location: not found/);
  assert.equal(bestFullName('Pat', 'Sam Roe'), 'Pat');
});

test('draft update and late enrichment update no longer wipe each other', async () => {
  const calls = [];
  const slackApi = { updateDraftApprovalCard: async (_t, _c, _ts, p) => { calls.push(p); return { ok: true }; } };
  rememberCard('r1', { replyId: 'r1', leadName: 'Pat', draft: '', leadLinkedinUrl: 'https://linkedin.com/in/pd', leadWebsite: 'https://example.com' });
  await patchPostedCard({
    slackApi, token: 't', channelId: 'c', ts: '1', isDraft: true, replyId: 'r1',
    base: { replyId: 'r1', leadName: 'Pat', leadLinkedinUrl: undefined },
    patch: { draft: 'Hi Pat' },
  });
  assert.equal(calls[0].draft, 'Hi Pat');
  assert.equal(calls[0].leadLinkedinUrl, 'https://linkedin.com/in/pd');
  const merged = mergeCardPayload({ leadPhone: '+1', leadIcpVerdict: { status: 'qualified' } }, { leadPhone: undefined, leadIcpVerdict: { status: 'unknown', reason: 'checking' } });
  assert.equal(merged.leadPhone, '+1');
  assert.equal(merged.leadIcpVerdict.status, 'qualified');
});

test('late enrichment fills location, full name, and keeps a newer draft', async () => {
  const calls = [];
  const slackApi = { updateDraftApprovalCard: async (_t, _c, _ts, p) => { calls.push(p); return { ok: true }; } };
  const db = { query: async () => ({ rows: [] }) };
  rememberCard('r2', { replyId: 'r2', draft: 'newest draft' });
  const card = { replyId: 'r2', leadName: 'Pat', leadEmail: 'pat@example.com', classification: 'INTERESTED' };
  const out = await completeCardLinks({
    token: 't', channelId: 'c', postedTs: '1', isDraft: true,
    payload: { ...card, draft: '' }, card, replyId: 'r2', slackApi,
    enrichFn: async () => ({ phone: null, phoneAlt: '+15555550100', linkedinUrl: null }),
    linkLookup: async () => ({}),
    identity: { website: 'https://example.com', email: 'pat@example.com' },
    dbClient: db, clientId: 'c1',
    evaluateIcp: async () => ({ status: 'unknown', reason: 'no ICP' }),
    profileLookup: async () => ({ fullName: 'Pat Doe', linkedinUrl: 'https://linkedin.com/in/pd', location: 'Denver, CO' }),
    icpBuild: () => null,
  });
  assert.equal(out.timezone, 'America/Denver');
  const last = calls.at(-1);
  assert.equal(last.draft, 'newest draft');
  assert.equal(last.leadFullName, 'Pat Doe');
  assert.equal(last.leadLocation, 'Denver, CO');
  assert.equal(last.leadPhoneAlt, '+15555550100');
});

test('a client with no ICP triggers an on-demand Fireflies build', async () => {
  let built = 0;
  const db = { query: async () => ({ rows: [] }) };
  const card = { replyId: 'r3', leadName: 'Pat Doe', leadEmail: 'pat@example.com', classification: 'QUESTION' };
  await completeCardLinks({
    token: 't', channelId: 'c', postedTs: '1', isDraft: false, payload: card, card, replyId: 'r3',
    slackApi: { updateAlertCard: async () => ({}) }, enrichFn: async () => null, linkLookup: async () => ({}),
    identity: { website: 'https://example.com', linkedinUrl: 'https://linkedin.com/in/pd', location: 'Austin, TX' },
    dbClient: db, clientId: 'c9',
    evaluateIcp: async () => ({ status: 'unknown', reason: 'no ICP' }),
    profileLookup: async () => ({}), icpBuild: () => { built += 1; },
  });
  assert.equal(built, 1);
  assert.equal(applyCardLinks({}, { location: 'Austin, TX' }, {}).leadTimezone, 'America/Chicago');
});
