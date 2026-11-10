const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { heyreachConversationUrl, HEYREACH_INBOX_URL } = require('../src/services/heyreach-inbox-url');
const {
  findSmartleadColdEmails,
  buildSmartleadThreadMessage,
  postHeyreachSmartleadContext,
  campaignsOwnedByClient,
  noteContextBackoff,
  contextPaceDelayMs,
  resetSmartleadContextPace,
  lastNameMatches,
  NO_MATCH_LINE,
  NO_SENT_LINE,
} = require('../src/services/heyreach-smartlead-context');
const { applyHeyreachDraftPolicy } = require('../src/utils/client-draft-policy');
const { buildDraftApprovalCard, buildAlertCard } = require('../src/services/slack');
const { postProspectSlackCard } = require('../src/services/slack-reply-post');

const CONV = '2-ODM0YmIzNzgtOGEyOS00ZTYzLWExYTItNmM0MWNhMjNlNGZjXzAxMw==';
const ACCOUNT = 8811;
const BUTTON_URL = `https://app.heyreach.io/app/inbox/${ACCOUNT}/${encodeURIComponent(CONV)}`;

function sentHistory() {
  return {
    history: [
      {
        type: 'SENT',
        email_seq_number: 1,
        time: '2026-03-02T15:04:00.000Z',
        subject: 'Quick question',
        email_body: '<p>Hi Pat — we book meetings for HVAC owners.</p>',
        stats_id: 's1',
      },
      {
        type: 'REPLY',
        time: '2026-03-03T12:00:00.000Z',
        email_body: 'Not now',
      },
      {
        type: 'SENT',
        email_seq_number: 2,
        time: '2026-03-09T15:04:00.000Z',
        subject: 'Following up',
        email_body: 'Bumping this in case it got buried.',
        stats_id: 's2',
      },
    ],
  };
}

test('HeyReach conversation URL uses account id and conversation id', () => {
  assert.equal(
    heyreachConversationUrl({ conversationId: CONV, linkedInAccountId: ACCOUNT }),
    BUTTON_URL,
  );
  assert.equal(heyreachConversationUrl({ conversationId: CONV, linkedinAccountId: '55' }),
    'https://app.heyreach.io/app/inbox/55/' + encodeURIComponent(CONV));
  assert.equal(heyreachConversationUrl({ conversationId: CONV }), HEYREACH_INBOX_URL);
  assert.equal(heyreachConversationUrl({ linkedInAccountId: ACCOUNT }), HEYREACH_INBOX_URL);
  assert.equal(heyreachConversationUrl({}), HEYREACH_INBOX_URL);
});

test('Reply button deep-links to the HeyReach conversation, not the LinkedIn profile', () => {
  const card = {
    replyId: 'real-1',
    leadId: 'lead-1',
    leadName: 'Pat Riley',
    leadEmail: 'pat@acme.com',
    leadCompany: 'Acme Mechanical',
    platform: 'heyreach',
    classification: 'INTERESTED',
    draft: 'Happy to share a couple times.',
    inboundMessage: 'Sure, send times.',
    lastOutboundMessage: 'Worth a look this month?',
    campaignDisplay: 'Acme | Owners',
    conversationId: CONV,
    linkedInAccountId: ACCOUNT,
    hasHeyreachApiKey: true,
    heyreachCanSend: true,
    leadLinkedinUrl: 'https://www.linkedin.com/in/pat-riley',
  };
  const draft = buildDraftApprovalCard(card);
  const link = draft.blocks.flatMap((block) => block.elements || [])
    .find((el) => el.action_id === 'reply_on_linkedin');
  assert.ok(link, 'send-capable cards still get the HeyReach button');
  assert.equal(link.text.text, 'Reply in HeyReach');
  assert.equal(link.url, BUTTON_URL);
  assert.doesNotMatch(JSON.stringify(link), /linkedin\.com/);
  assert.ok(draft.blocks.flatMap((b) => b.elements || []).some((el) => el.action_id === 'approve_reply'));

  const limited = buildDraftApprovalCard({ ...card, heyreachCanSend: false, hasHeyreachApiKey: false });
  const limitedLink = limited.blocks.flatMap((block) => block.elements || [])
    .find((el) => el.action_id === 'reply_on_linkedin');
  assert.equal(limitedLink.url, BUTTON_URL);
  assert.ok(!limited.blocks.flatMap((b) => b.elements || []).some((el) => el.action_id === 'approve_reply'));

  const alert = buildAlertCard({
    replyId: 'real-1',
    leadName: 'Pat Riley',
    platform: 'heyreach',
    classification: 'QUESTION',
    inboundMessage: 'What does this cost?',
    conversationId: CONV,
    linkedInAccountId: ACCOUNT,
    leadLinkedinUrl: 'https://www.linkedin.com/in/pat-riley',
  });
  const alertLink = alert.blocks.flatMap((block) => block.elements || [])
    .find((el) => el.action_id === 'reply_on_linkedin');
  assert.equal(alertLink.url, BUTTON_URL);

  const fallback = buildAlertCard({
    replyId: 'real-1',
    leadName: 'Pat Riley',
    platform: 'heyreach',
    classification: 'QUESTION',
    inboundMessage: 'What does this cost?',
    leadLinkedinUrl: 'https://www.linkedin.com/in/pat-riley',
  });
  const fallbackLink = fallback.blocks.flatMap((block) => block.elements || [])
    .find((el) => el.action_id === 'reply_on_linkedin');
  assert.equal(fallbackLink.url, HEYREACH_INBOX_URL);

  const profileStillThere = JSON.stringify(draft.blocks);
  assert.match(profileStillThere, /linkedin\.com\/in\/pat-riley/);
});

test('thread payload lists each sent cold email and skips replies', () => {
  const message = buildSmartleadThreadMessage({
    status: 'match',
    matchedBy: 'email',
    emails: [
      {
        campaignName: 'Acme | Owners',
        seq: 1,
        time: '2026-03-02T15:04:00.000Z',
        subject: 'Quick question',
        body: 'Hi Pat — we book meetings for HVAC owners.',
      },
      {
        campaignName: 'Acme | Owners',
        seq: 2,
        time: '2026-03-09T15:04:00.000Z',
        subject: 'Following up',
        body: 'Bumping this in case it got buried.',
      },
    ],
  });
  const text = JSON.stringify(message.blocks);
  assert.match(text, /Acme \| Owners/);
  assert.match(text, /\*Step:\* 1/);
  assert.match(text, /\*Step:\* 2/);
  assert.match(text, /2026-03-02/);
  assert.match(text, /2026-03-09/);
  assert.match(text, /we book meetings for HVAC owners/);
  assert.match(text, /Bumping this in case it got buried/);
  assert.doesNotMatch(text, /Not now/);
  assert.match(message.text, /step 1/);

  const none = buildSmartleadThreadMessage({ status: 'none' });
  assert.equal(none.text, NO_MATCH_LINE);
  assert.equal(none.blocks.length, 1);

  const empty = buildSmartleadThreadMessage({ status: 'match', matchedBy: 'name', emails: [] });
  assert.equal(empty.text, NO_SENT_LINE);
  assert.equal(buildSmartleadThreadMessage({ status: 'error' }), null);
});

test('email lookup uses GET /leads and message-history, and ignores replies', async () => {
  const calls = [];
  const found = await findSmartleadColdEmails({
    apiKey: 'test-key',
    email: 'pat@acme.com',
    name: 'Pat Riley',
    company: 'Acme Mechanical',
    gapMs: 0,
    ownedCampaigns: [{ id: 321, name: 'Acme | Owners' }],
    fetchJson: async (req) => {
      calls.push(req);
      if (req.path === '/leads/') {
        assert.equal(req.query.email, 'pat@acme.com');
        return {
          status: 200,
          ok: true,
          json: {
            id: 55501,
            first_name: 'Pat',
            last_name: 'Riley',
            email: 'pat@acme.com',
            company_name: 'Acme Mechanical',
            lead_campaign_data: [{ campaign_id: 321, campaign_name: 'Acme | Owners' }],
          },
        };
      }
      assert.equal(req.path, '/campaigns/321/leads/55501/message-history');
      assert.equal(req.query.show_plain_text_response, 'true');
      return { status: 200, ok: true, json: sentHistory() };
    },
  });
  assert.equal(found.status, 'match');
  assert.equal(found.matchedBy, 'email');
  assert.equal(found.emails.length, 2);
  assert.equal(found.emails[0].seq, 1);
  assert.equal(found.emails[0].campaignName, 'Acme | Owners');
  assert.match(found.emails[0].body, /HVAC owners/);
  assert.equal(calls.some((c) => String(c.path).includes('/filter')), false);
});

test('name plus company is the fallback and a company miss is no match', async () => {
  const calls = [];
  const fetchJson = async (req) => {
    calls.push(`${req.method || 'GET'} ${req.path}`);
    if (req.path === '/leads/') return { status: 200, ok: true, json: {} };
    if (req.path === '/campaigns/77/leads/filter') {
      assert.equal(req.body.searchText, 'Pat Riley');
      assert.equal(req.body.fieldSet, 'drafted_table');
      return {
        status: 200,
        ok: true,
        json: {
          leads: [
            {
              email_lead: {
                id: 9,
                first_name: 'Pat',
                last_name: 'Riley',
                company_name: 'Other Co',
              },
            },
            {
              email_lead: {
                id: 10,
                first_name: 'Pat',
                last_name: 'Riley',
                company_name: 'Acme Mechanical LLC',
              },
            },
          ],
        },
      };
    }
    if (req.path === '/campaigns/77/leads/10/message-history') {
      return { status: 200, ok: true, json: sentHistory() };
    }
    throw new Error(`unexpected ${req.path}`);
  };
  const found = await findSmartleadColdEmails({
    apiKey: 'test-key',
    email: null,
    name: 'Pat Riley',
    company: 'Acme Mechanical',
    gapMs: 0,
    ownedCampaigns: [{ id: 77, name: 'Acme | Owners' }],
    fetchJson,
  });
  assert.equal(found.status, 'match');
  assert.equal(found.matchedBy, 'name');
  assert.equal(found.leadId, 10);
  assert.equal(found.emails.length, 2);
  assert.ok(calls.includes('POST /campaigns/77/leads/filter'));

  const miss = await findSmartleadColdEmails({
    apiKey: 'test-key',
    name: 'Pat Riley',
    company: 'No Such Firm',
    gapMs: 0,
    ownedCampaigns: [{ id: 77, name: 'Acme | Owners' }],
    fetchJson: async (req) => {
      if (req.path.endsWith('/filter')) {
        return {
          status: 200,
          ok: true,
          json: {
            leads: [{
              email_lead: { id: 9, first_name: 'Pat', last_name: 'Riley', company_name: 'Other Co' },
            }],
          },
        };
      }
      throw new Error(req.path);
    },
  });
  assert.equal(miss.status, 'none');
});

test('a Smartlead failure is not reported as no match and does not post', async () => {
  const found = await findSmartleadColdEmails({
    apiKey: 'test-key',
    email: 'pat@acme.com',
    gapMs: 0,
    ownedCampaigns: [{ id: 1, name: 'Acme | Owners' }],
    fetchJson: async () => ({ status: 429, ok: false, json: null }),
  });
  assert.equal(found.status, 'error');
  const posts = [];
  const result = await postHeyreachSmartleadContext({
    replyId: 'r1',
    clientId: 'c1',
    token: 'xoxb',
    channelId: 'C1',
    threadTs: '1.2',
    email: 'pat@acme.com',
    query: async (sql) => {
      if (/smartlead_api_key/.test(sql)) return { rows: [{ smartlead_api_key: 'k' }] };
      throw new Error(sql);
    },
    findEmails: async () => found,
    postThread: async (msg) => { posts.push(msg); },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'lookup_failed');
  assert.equal(posts.length, 0);
});

test('the thread message posts once; a retry does not post a second one', async () => {
  resetSmartleadContextPace();
  let claimed = false;
  const posts = [];
  const query = async (sql) => {
    if (/smartlead_api_key/.test(sql)) return { rows: [{ smartlead_api_key: 'k' }] };
    if (/DISTINCT campaign_id/.test(sql)) return { rows: [] };
    if (/smartleadContextPosted/.test(sql) && /'false'/.test(sql)) {
      claimed = false;
      return { rows: [] };
    }
    if (/smartleadContextPosted/.test(sql)) {
      if (claimed) return { rows: [] };
      claimed = true;
      return { rows: [{ id: 'r1' }] };
    }
    throw new Error(sql);
  };
  const findEmails = async () => ({ status: 'none' });
  const first = await postHeyreachSmartleadContext({
    replyId: 'r1', clientId: 'c1', token: 'x', channelId: 'C', threadTs: '1.2',
    email: 'pat@acme.com', query, findEmails,
    postThread: async (msg) => { posts.push(msg); },
  });
  const second = await postHeyreachSmartleadContext({
    replyId: 'r1', clientId: 'c1', token: 'x', channelId: 'C', threadTs: '1.2',
    email: 'pat@acme.com', query, findEmails,
    postThread: async (msg) => { posts.push(msg); },
  });
  assert.equal(first.posted, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, NO_MATCH_LINE);
  assert.equal(second.posted, false);
  assert.equal(second.reason, 'already_posted');
  assert.equal(posts.length, 1);
});

test('the card is posted before the Smartlead lookup, and a lookup throw does not fail the card', async () => {
  let cardPosted = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let contextCalls = 0;
  const dbClient = { query: async () => ({ rows: [] }) };
  const slackApi = {
    postDraftApproval: async (_token, _channel, payload) => {
      cardPosted = true;
      assert.equal(payload.platform, 'heyreach');
      assert.equal(payload.conversationId, CONV);
      assert.equal(payload.linkedInAccountId, ACCOUNT);
      return { ts: '1700000000.000100' };
    },
    updateDraftApprovalCard: async () => ({ ok: true }),
    postAlert: async () => { throw new Error('not an alert'); },
    getPermalink: async () => null,
  };
  const pending = postProspectSlackCard({
    token: 'xoxb-test',
    channelId: 'C123',
    clientId: 'client-1',
    platform: 'heyreach',
    campaignId: 'hr-1',
    leadId: 'lead-1',
    isDraft: true,
    replyId: 'reply-1',
    threadContext: {
      messages: [{ role: 'prospect', message: 'Sure, send times.' }],
      heyreach: { conversationId: CONV, linkedinAccountId: ACCOUNT },
    },
    card: {
      replyId: 'reply-1',
      leadName: 'Pat Riley',
      leadEmail: null,
      leadCompany: 'Acme Mechanical',
      platform: 'heyreach',
      classification: 'INTERESTED',
      draft: 'Happy to share a couple times.',
      inboundMessage: 'Sure, send times.',
      campaignDisplay: 'Acme | Owners',
    },
    slackApi,
    claimFn: async () => ({ claimed: true }),
    identityResolve: async () => ({ email: null, linkedinUrl: 'https://www.linkedin.com/in/pat-riley' }),
    enrichFn: async () => ({ email: 'pat@acme.com', linkedinUrl: null, website: null }),
    linkLookup: async () => ({ linkedinUrl: null, website: null }),
    evaluateIcp: async () => ({ status: 'unknown', reason: 'test' }),
    profileLookup: async () => null,
    dbClient,
    awaitLinkUpdate: false,
    smartleadContextFn: async (args) => {
      contextCalls += 1;
      assert.equal(cardPosted, true);
      assert.equal(args.threadTs, '1700000000.000100');
      assert.equal(args.email, 'pat@acme.com');
      assert.equal(args.company, 'Acme Mechanical');
      await gate;
      throw new Error('smartlead down');
    },
  });
  const result = await pending;
  assert.equal(result.ts, '1700000000.000100');
  assert.equal(cardPosted, true);
  for (let i = 0; i < 30 && contextCalls === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(contextCalls, 1);
  release();
});

test('ownership keeps every campaign for this client, including ones we have not stored', () => {
  const ciotola = { id: 'client-ciotola', name: 'Ciotola' };
  const power = { id: 'client-power', name: 'PowerGRYD' };
  const sales = { id: 'client-sales', name: 'SalesGlider' };
  const clients = [ciotola, power, sales];
  const smartleadClients = [
    { id: 345263, name: 'SalesGlider', logo: 'SalesGlider', uuid: 'not-ours' },
    { id: 592842, name: 'PowerGryd', logo: 'PowerGRYD', uuid: 'not-ours-2' },
  ];
  const smartleadCampaigns = [
    { id: 1, name: 'Ciotola | East Village Church', client_id: 345263 },
    { id: 2, name: 'MSP Owners 36 to 100', client_id: 592842 },
    { id: 3, name: 'Peterson | Roofers', client_id: 345263 },
    ...Array.from({ length: 13 }, (_, i) => ({
      id: 100 + i,
      name: `Ciotola | Lane ${i + 1}`,
      client_id: 345263,
    })),
  ];
  const owned = campaignsOwnedByClient({
    replyClient: ciotola,
    clients,
    routes: [],
    storedCampaignIds: ['1'],
    smartleadCampaigns,
    smartleadClients,
  });
  const ids = owned.map((c) => c.id).sort((a, b) => a - b);
  assert.equal(ids.includes(1), true);
  assert.equal(ids.includes(2), false, 'PowerGRYD client_id is not Ciotola');
  assert.equal(ids.includes(3), false, 'another client title is excluded');
  assert.equal(ids.filter((id) => id >= 100).length, 13);
  assert.ok(ids.length > 12);
  const outside = owned.find((c) => c.id === 100);
  assert.equal(outside.via, 'title');
  assert.equal(owned.find((c) => c.id === 1).via, 'title');

  const powerOwned = campaignsOwnedByClient({
    replyClient: power,
    clients,
    storedCampaignIds: [],
    smartleadCampaigns,
    smartleadClients,
  });
  assert.deepEqual(powerOwned.map((c) => c.id), [2]);
  assert.equal(powerOwned[0].via, 'smartlead_client');

  const routed = campaignsOwnedByClient({
    replyClient: ciotola,
    clients,
    routes: [{ campaign_id: '50', client_id: 'client-ciotola' }],
    storedCampaignIds: [],
    smartleadCampaigns: [],
    smartleadClients: [],
  });
  assert.deepEqual(routed.map((c) => c.id), [50]);

  const tagged = campaignsOwnedByClient({
    replyClient: ciotola,
    clients,
    smartleadCampaigns: [{ id: 9, name: 'Other | Roofers', tags: [{ name: 'sg-owner:ciotola' }] }],
    smartleadClients,
  });
  assert.equal(tagged[0].via, 'tag');
  assert.equal(tagged[0].id, 9);
});

test('name search covers every owned campaign past the old cap of 12', async () => {
  const calls = [];
  const owned = Array.from({ length: 13 }, (_, i) => ({
    id: 200 + i,
    name: `Ciotola | Lane ${i + 1}`,
  }));
  const found = await findSmartleadColdEmails({
    apiKey: 'test-key',
    name: 'Pat Riley',
    company: 'Acme Mechanical',
    gapMs: 0,
    ownedCampaigns: owned,
    fetchJson: async (req) => {
      calls.push(req.path);
      if (String(req.path).endsWith('/filter')) {
        if (req.path === '/campaigns/212/leads/filter') {
          return {
            status: 200,
            ok: true,
            json: {
              leads: [{
                email_lead: {
                  id: 10, first_name: 'Pat', last_name: 'Riley', company_name: 'Acme Mechanical',
                },
              }],
            },
          };
        }
        return { status: 200, ok: true, json: { leads: [] } };
      }
      if (req.path === '/campaigns/212/leads/10/message-history') {
        return { status: 200, ok: true, json: sentHistory() };
      }
      throw new Error(req.path);
    },
  });
  const filters = calls.filter((p) => String(p).endsWith('/filter'));
  assert.equal(filters.length, 13);
  assert.equal(found.status, 'match');
  assert.equal(found.ownedCount, 13);
  assert.equal(found.emails[0].campaignName, 'Ciotola | Lane 13');
});

test('an email hit in another client campaign is excluded', async () => {
  const calls = [];
  const found = await findSmartleadColdEmails({
    apiKey: 'test-key',
    email: 'pat@acme.com',
    name: 'Pat Riley',
    company: 'Acme Mechanical',
    gapMs: 0,
    ownedCampaigns: [{ id: 321, name: 'Ciotola | Owners' }],
    fetchJson: async (req) => {
      calls.push(req.path);
      if (req.path === '/leads/') {
        return {
          status: 200,
          ok: true,
          json: {
            id: 55501,
            first_name: 'Pat',
            last_name: 'Riley',
            email: 'pat@acme.com',
            lead_campaign_data: [
              { campaign_id: 321, campaign_name: 'Ciotola | Owners' },
              { campaign_id: 999, campaign_name: 'Peterson | Roofers' },
            ],
          },
        };
      }
      assert.equal(req.path, '/campaigns/321/leads/55501/message-history');
      return { status: 200, ok: true, json: sentHistory() };
    },
  });
  assert.equal(found.status, 'match');
  assert.equal(found.matchedBy, 'email');
  assert.equal(calls.includes('/campaigns/999/leads/55501/message-history'), false);
  assert.equal(found.emails[0].campaignName, 'Ciotola | Owners');
});

test('a failed name search reports the HTTP status', async () => {
  const found = await findSmartleadColdEmails({
    apiKey: 'test-key',
    name: 'Pat Riley',
    company: 'Acme',
    gapMs: 0,
    ownedCampaigns: [{ id: 5, name: 'Ciotola | Owners' }, { id: 6, name: 'Ciotola | Two' }],
    fetchJson: async () => ({ status: 500, ok: false, json: { message: 'Error fetching campaign leads with multi-select filters' }, text: 'Error fetching campaign leads with multi-select filters' }),
  });
  assert.equal(found.status, 'error');
  assert.match(found.error, /status 500/);
  assert.match(found.error, /\/campaigns\/5\/leads\/filter/);
});

test('a middle name still matches the last name', () => {
  assert.equal(lastNameMatches('Faye Allred', 'Allred'), true);
  assert.equal(lastNameMatches('Allred', 'Allred'), true);
  assert.equal(lastNameMatches('Smithson', 'Smith'), false);
});

test('HeyReach drafts every reply except Parlay .io and .ai', () => {
  const other = applyHeyreachDraftPolicy(
    { id: 'client-1', name: 'Ciotola' },
    null,
    { classification: 'OTHER', draft: 'Thanks for connecting.', reasoning: 'neutral' },
  );
  assert.equal(other.isDraft, true);
  assert.equal(other.status, 'pending');
  assert.equal(other.draft, 'Thanks for connecting.');

  const parlay = applyHeyreachDraftPolicy(
    { id: '9760132c-1dd3-4e97-8f29-c5d4d01f5054', name: 'Parlay Tech' },
    'ada@startup.io',
    { classification: 'INTERESTED', draft: 'Let us talk.', reasoning: 'yes' },
  );
  assert.equal(parlay.isDraft, false);
  assert.equal(parlay.status, 'alert_only');
  assert.equal(parlay.draft, null);
});

test('a 429 backs off this path only', () => {
  resetSmartleadContextPace();
  noteContextBackoff(5000);
  assert.ok(contextPaceDelayMs() >= 4000);
  assert.ok(contextPaceDelayMs() <= 5000);
  resetSmartleadContextPace();
  assert.equal(contextPaceDelayMs(), 0);
});

test('writes the example card and thread payloads', () => {
  const card = buildDraftApprovalCard({
    replyId: '11111111-1111-4111-8111-111111111111',
    leadId: 'lead-pat',
    leadName: 'Pat Riley',
    leadEmail: 'pat@acme.com',
    leadCompany: 'Acme Mechanical',
    platform: 'heyreach',
    classification: 'INTERESTED',
    draft: 'Happy to share a couple times.',
    reasoning: 'They asked for times.',
    inboundMessage: 'Sure, send times.',
    lastOutboundMessage: 'Worth a look this month?',
    campaignDisplay: 'Acme | Owners',
    conversationId: CONV,
    linkedInAccountId: ACCOUNT,
    hasHeyreachApiKey: true,
    heyreachCanSend: true,
    leadLinkedinUrl: 'https://www.linkedin.com/in/pat-riley',
  });
  const thread = buildSmartleadThreadMessage({
    status: 'match',
    matchedBy: 'email',
    emails: [
      {
        campaignName: 'Acme | Owners',
        seq: 1,
        time: '2026-03-02T15:04:00.000Z',
        subject: 'Quick question',
        body: 'Hi Pat — we book meetings for HVAC owners.',
      },
      {
        campaignName: 'Acme | Owners',
        seq: 2,
        time: '2026-03-09T15:04:00.000Z',
        subject: 'Following up',
        body: 'Bumping this in case it got buried.',
      },
    ],
  });
  const none = buildSmartleadThreadMessage({ status: 'none' });
  const link = card.blocks.flatMap((block) => block.elements || [])
    .find((el) => el.action_id === 'reply_on_linkedin');
  const example = {
    buttonUrl: link.url,
    buttonLabel: link.text.text,
    card: { text: card.text, blocks: card.blocks },
    thread: { text: thread.text, blocks: thread.blocks, thread_ts: '1700000000.000100' },
    noMatchThread: { text: none.text, blocks: none.blocks },
  };
  assert.equal(example.buttonUrl, BUTTON_URL);
  const dir = '/opt/cursor/artifacts';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'heyreach-card-example.json'), JSON.stringify(example, null, 2));
});
