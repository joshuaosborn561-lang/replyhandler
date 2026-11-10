const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { heyreachConversationUrl, HEYREACH_INBOX_URL } = require('../src/services/heyreach-inbox-url');
const {
  findSmartleadColdEmails,
  buildSmartleadThreadMessage,
  postHeyreachSmartleadContext,
  NO_MATCH_LINE,
  NO_SENT_LINE,
  resetSmartleadContextPace,
} = require('../src/services/heyreach-smartlead-context');
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
    listCampaignIds: async () => { throw new Error('name search must not list campaigns after an email hit'); },
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
    campaignIds: ['77'],
    gapMs: 0,
    listCampaignIds: null,
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
    campaignIds: ['77'],
    gapMs: 0,
    listCampaignIds: null,
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
    listCampaignIds: null,
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
