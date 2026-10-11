const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  leadFieldText,
  buildDraftApprovalCard,
  buildSentConfirmationBlocks,
  buildAlertCard,
} = require('../src/services/slack');
const { postProspectSlackCard, applyCardLinks } = require('../src/services/slack-reply-post');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const LI = 'https://www.linkedin.com/in/pat-riley';
const WEB = 'https://acme.com';

function leadHasBoth(text, { linkedin = true, website = true } = {}) {
  if (linkedin) {
    assert.match(text, /linkedin\.com\/in\/pat-riley|<https:\/\/www\.linkedin\.com\/in\/pat-riley\|/);
  } else {
    assert.match(text, /LinkedIn: not found/);
    assert.doesNotMatch(text, /linkedin\.com\/in\//);
  }
  if (website) {
    assert.match(text, /<https:\/\/acme\.com\|/);
  } else {
    assert.match(text, /Website: not found/);
  }
}

test('lead field always shows LinkedIn and website — link or not found', () => {
  const withBoth = leadFieldText({
    leadName: 'Pat Riley',
    leadEmail: 'pat@acme.com',
    leadLinkedinUrl: LI,
    leadWebsite: WEB,
  });
  leadHasBoth(withBoth);
  assert.match(withBoth, /<https:\/\/www\.linkedin\.com\/in\/pat-riley\|/);
  assert.match(withBoth, /<https:\/\/acme\.com\|/);

  const missing = leadFieldText({ leadName: 'Pat', leadEmail: 'pat@gmail.com' });
  assert.match(missing, /LinkedIn: not found/);
  assert.match(missing, /Website: not found/);
  assert.doesNotMatch(missing, /<https?:\/\/[^>|]*linkedin/);
});

test('draft approval, alert, and sent confirmation all render both links', () => {
  const draft = buildDraftApprovalCard({
    replyId: '1',
    leadName: 'Pat',
    platform: 'smartlead',
    classification: 'INTERESTED',
    draft: 'Hey Pat',
    inboundMessage: 'Sure',
    leadLinkedinUrl: LI,
    leadWebsite: WEB,
  });
  leadHasBoth(JSON.stringify(draft.blocks));

  const alert = buildAlertCard({
    replyId: '1',
    leadName: 'Pat',
    platform: 'heyreach',
    classification: 'QUESTION',
    inboundMessage: 'When?',
    leadLinkedinUrl: LI,
    leadWebsite: WEB,
  });
  leadHasBoth(JSON.stringify(alert.blocks));

  const sent = buildSentConfirmationBlocks({
    leadName: 'Pat',
    platform: 'smartlead',
    classification: 'INTERESTED',
    inboundMessage: 'Sure',
    sentReply: 'Hey Pat',
    actionKind: 'approved',
    leadLinkedinUrl: LI,
    leadWebsite: WEB,
  });
  leadHasBoth(JSON.stringify(sent));

  const emptyDraft = buildDraftApprovalCard({
    replyId: '2',
    leadName: 'Pat',
    platform: 'heyreach',
    classification: 'FOLLOW_UP',
    draft: 'Bump',
    inboundMessage: 'Hi',
  });
  const emptyText = JSON.stringify(emptyDraft.blocks);
  assert.match(emptyText, /LinkedIn: not found/);
  assert.match(emptyText, /Website: not found/);
});

test('every Slack reply-card path goes through postProspectSlackCard or leadFieldText', () => {
  const paths = [
    'src/routes/webhooks.js',
    'src/services/smartlead-poller.js',
    'src/services/heyreach-poller.js',
    'src/services/follow-up-runner.js',
    'src/services/reply-dedupe.js',
    'src/routes/admin.js',
    'src/routes/test-webhooks.js',
  ];
  for (const file of paths) {
    const src = read(file);
    assert.match(
      src,
      /postProspectSlackCard/,
      `${file} must post reply cards through postProspectSlackCard`,
    );
  }

  const confirmation = [
    'src/routes/slack.js',
    'src/services/refresh-followup-cards.js',
  ];
  for (const file of confirmation) {
    const src = read(file);
    assert.match(src, /leadWebsite/, `${file} must pass leadWebsite onto the Lead field`);
    assert.match(src, /leadLinkedinUrl|linkedin_url/, `${file} must pass LinkedIn onto the Lead field`);
  }

  const slack = read('src/services/slack.js');
  assert.match(slack, /function leadFieldText/);
  assert.match(slack, /LinkedIn: not found/);
  assert.match(slack, /Website: not found/);
  assert.match(slack, /function buildAlertCard/);
  assert.match(slack, /async function updateAlertCard/);
});

test('poster posts immediately then chat.update when LinkedIn arrives late', async () => {
  const posts = [];
  const updates = [];
  const persists = [];
  const slackApi = {
    postDraftApproval: async (token, channel, payload) => {
      posts.push({ token, channel, payload });
      return { ts: '123.456' };
    },
    updateDraftApprovalCard: async (token, channel, ts, payload) => {
      updates.push({ token, channel, ts, payload });
      return { ok: true };
    },
    postAlert: async () => ({ ts: '123.456' }),
    updateAlertCard: async () => ({ ok: true }),
  };
  const dbClient = {
    query: async (sql, params = []) => {
      persists.push({ sql: String(sql), params });
      return { rows: [] };
    },
  };

  const result = await postProspectSlackCard({
    token: 'xoxb-test',
    channelId: 'C123',
    clientId: 'client-1',
    platform: 'smartlead',
    campaignId: 'camp-1',
    leadId: 'lead-1',
    isDraft: true,
    replyId: 'reply-1',
    card: {
      replyId: 'reply-1',
      leadName: 'Pat Riley',
      leadEmail: 'pat@acme.com',
      platform: 'smartlead',
      classification: 'INTERESTED',
      draft: 'Hey Pat',
      inboundMessage: 'Sure',
    },
    slackApi,
    claimFn: async () => ({ claimed: true }),
    identityResolve: async () => ({
      linkedinUrl: null,
      website: 'https://acme.com',
      email: 'pat@acme.com',
      sources: { website: 'email_domain' },
    }),
    enrichFn: async () => ({
      phone: null,
      linkedinUrl: null,
      website: 'https://acme.com',
      email: 'pat@acme.com',
      status: 'not_found',
    }),
    linkLookup: async () => ({
      linkedinUrl: LI,
      website: null,
      spentUsd: 0.0037,
    }),
    dbClient,
    awaitLinkUpdate: true,
  });

  assert.equal(result.ts, '123.456');
  assert.equal(posts.length, 1, 'card posts once immediately');
  assert.equal(posts[0].payload.leadWebsite, 'https://acme.com');
  assert.ok(!posts[0].payload.leadLinkedinUrl, 'first post does not wait for paid LinkedIn');

  assert.equal(updates.length, 1, 'same Slack message is updated when the link arrives');
  assert.equal(updates[0].ts, '123.456');
  assert.equal(updates[0].payload.leadLinkedinUrl, LI);
  assert.equal(updates[0].payload.leadWebsite, 'https://acme.com');

  const persistSql = persists.filter((c) => /linkedin_url = COALESCE/.test(c.sql));
  assert.ok(persistSql.length >= 1);
  assert.ok(persists.some((c) => /slack_message_ts/.test(c.sql)));
});

test('alert cards also late-update through updateAlertCard', async () => {
  const updates = [];
  const slackApi = {
    postDraftApproval: async () => ({ ts: '9.9' }),
    updateDraftApprovalCard: async () => ({ ok: true }),
    postAlert: async (token, channel, payload) => {
      assert.equal(payload.leadLinkedinUrl, LI);
      return { ts: '9.9' };
    },
    updateAlertCard: async (token, channel, ts, payload) => {
      updates.push({ ts, payload });
      return { ok: true };
    },
  };

  await postProspectSlackCard({
    token: 'xoxb-test',
    channelId: 'C999',
    clientId: 'client-1',
    platform: 'heyreach',
    campaignId: 'c',
    leadId: 'l',
    isDraft: false,
    replyId: 'reply-alert',
    postInThread: false,
    card: {
      leadName: 'Casey',
      leadEmail: null,
      linkedinUrl: LI,
      platform: 'heyreach',
      classification: 'QUESTION',
      inboundMessage: 'When works?',
    },
    slackApi,
    claimFn: async () => ({ claimed: true }),
    identityResolve: async () => ({
      linkedinUrl: LI,
      website: null,
      email: null,
      sources: { linkedin: 'lead' },
    }),
    enrichFn: async () => ({
      email: 'casey@steelco.io',
      website: 'https://steelco.io',
      linkedinUrl: LI,
      status: 'found',
    }),
    linkLookup: async () => ({ linkedinUrl: LI }),
    dbClient: { query: async () => ({ rows: [] }) },
    awaitLinkUpdate: true,
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].ts, '9.9');
  assert.equal(updates[0].payload.leadWebsite, 'https://steelco.io');
  assert.equal(updates[0].payload.leadLinkedinUrl, LI);
});

test('applyCardLinks keeps caller fields when identity is empty', () => {
  const card = applyCardLinks(
    { leadLinkedinUrl: LI, leadWebsite: WEB, leadEmail: 'a@b.com' },
    {},
  );
  assert.equal(card.leadLinkedinUrl, LI);
  assert.equal(card.leadWebsite, WEB);
});

test('poster does not await enrichment before the first Slack post', () => {
  const poster = read('src/services/slack-reply-post.js');
  const postFn = poster.slice(
    poster.indexOf('async function postProspectSlackCard'),
    poster.indexOf('module.exports'),
  );
  const postCall = postFn.indexOf('slackApi.postDraftApproval');
  const lateCall = postFn.indexOf('completeCardLinks');
  assert.ok(postCall > 0 && lateCall > postCall, 'late enrich must run after the first post');
  assert.match(poster, /updateDraftApprovalCard|updateAlertCard/);
  assert.match(poster, /awaitLinkUpdate/);
});
