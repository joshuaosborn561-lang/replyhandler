/**
 * HeyReach approve must be able to send when the stored row has a LinkedIn
 * URL but no conversationId / linkedInAccountId (James A Frenchik, 2026-10-26).
 * A lookup failure must not send. A suppressed LinkedIn reply keeps the ids.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const heyreach = require('../src/services/heyreach');
const db = require('../src/db');
const { recordSuppressedReply } = require('../src/services/suppressed-replies');
const {
  sendHeyreachReply,
  lookupStoredHeyreachIdentifiers,
} = require('../src/services/reply-send');
const { postStoredHeyreachApprovalCard } = require('../src/services/heyreach-approval-card');

const JAMES_URL = 'https://linkedin.com/in/james-frenchik';
const JAMES_CANONICAL = 'https://www.linkedin.com/in/james-frenchik/';

function jamesConversation(overrides = {}) {
  return {
    id: '2-Y29udmVyc2F0aW9u',
    linkedInAccountId: 8811,
    lastMessageAt: '2026-10-26T20:08:00.000Z',
    correspondentProfile: {
      firstName: 'James',
      lastName: 'Frenchik',
      profileUrl: JAMES_CANONICAL,
    },
    ...overrides,
  };
}

function installFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const result = await handler({ url: String(url), body, calls });
    const payload = result.body == null ? '' : (typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
    return {
      status: result.status || 200,
      ok: (result.status || 200) >= 200 && (result.status || 200) < 300,
      text: async () => payload,
    };
  };
  return {
    calls,
    restore() { global.fetch = original; },
  };
}

function pageOf(offset, limit, targetAt) {
  const items = [];
  for (let i = 0; i < limit; i++) {
    const n = offset + i;
    if (n === targetAt) {
      items.push(jamesConversation());
    } else {
      items.push({
        id: `other-${n}`,
        linkedInAccountId: 7,
        correspondentProfile: {
          firstName: 'Pat',
          lastName: `Person${n}`,
          profileUrl: `https://www.linkedin.com/in/person-${n}/`,
        },
      });
    }
  }
  return { items, totalCount: 1000 };
}

test('linkedin profile urls match on the /in/ slug', () => {
  assert.equal(heyreach.linkedinProfileSlug(JAMES_URL), 'james-frenchik');
  assert.equal(heyreach.linkedinProfileSlug(JAMES_CANONICAL), 'james-frenchik');
  assert.equal(heyreach.linkedinUrlsMatch(JAMES_URL, JAMES_CANONICAL), true);
  assert.equal(
    heyreach.namesMatch('James A Frenchik', {
      correspondentProfile: { firstName: 'James', lastName: 'Frenchik' },
    }),
    true,
  );
});

test('findConversation filters by LinkedIn URL instead of trusting the latest page', async () => {
  const fetchMock = installFetch(async ({ body }) => {
    assert.equal(body.filters.leadProfileUrl, JAMES_CANONICAL);
    return { body: { items: [jamesConversation()], totalCount: 1 } };
  });
  try {
    const found = await heyreach.findConversation('hr-key', {
      linkedinUrl: JAMES_URL,
      leadName: 'James A Frenchik',
      maxPages: 3,
      limit: 50,
    });
    assert.equal(found.id, '2-Y29udmVyc2F0aW9u');
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].body.offset, 0);
  } finally {
    fetchMock.restore();
  }
});

test('findConversation pages past the latest 150 conversations', async () => {
  const fetchMock = installFetch(async ({ body }) => {
    assert.equal(body.filters, undefined);
    return { body: pageOf(body.offset, body.limit, 150) };
  });
  try {
    const missed = await heyreach.findConversation('hr-key', {
      conversationId: '2-Y29udmVyc2F0aW9u',
      maxPages: 3,
      limit: 50,
    });
    assert.equal(missed, null);
    const found = await heyreach.findConversation('hr-key', {
      conversationId: '2-Y29udmVyc2F0aW9u',
      maxPages: 6,
      limit: 50,
    });
    assert.equal(found.id, '2-Y29udmVyc2F0aW9u');
    assert.ok(fetchMock.calls.some((call) => call.body.offset === 150));
  } finally {
    fetchMock.restore();
  }
});

test('findConversation does not accept an unrelated inbox row when the URL filter is ignored', async () => {
  const fetchMock = installFetch(async ({ body }) => {
    if (body.filters?.leadProfileUrl) {
      return {
        body: {
          items: [{
            id: 'wrong-person',
            linkedInAccountId: 1,
            correspondentProfile: {
              firstName: 'Ada',
              lastName: 'Lovelace',
              profileUrl: 'https://www.linkedin.com/in/ada-lovelace/',
            },
          }],
          totalCount: 1,
        },
      };
    }
    if (body.offset === 0) return { body: pageOf(0, body.limit, -1) };
    return { body: pageOf(body.offset, body.limit, 100) };
  });
  try {
    const found = await heyreach.findConversation('hr-key', {
      linkedinUrl: JAMES_URL,
      leadName: 'James A Frenchik',
      maxPages: 3,
      limit: 50,
    });
    assert.equal(found.id, '2-Y29udmVyc2F0aW9u');
    assert.notEqual(found.id, 'wrong-person');
  } finally {
    fetchMock.restore();
  }
});

test('HeyReach 500 fails the lookup instead of looking like not-found', async () => {
  const fetchMock = installFetch(async () => ({ status: 500, body: 'inbox down' }));
  try {
    await assert.rejects(
      () => heyreach.findConversation('hr-key', { linkedinUrl: JAMES_URL, maxPages: 10, limit: 100 }),
      (err) => err.status === 500 && /GetConversationsV2 failed \(500\)/.test(err.message),
    );
    assert.equal(fetchMock.calls.length, 1);
  } finally {
    fetchMock.restore();
  }
});

test('approve with missing identifiers resolves the conversation and sends once', async () => {
  const events = [];
  const reply = {
    id: 'card-james',
    client_id: 'client-nutter',
    platform: 'heyreach',
    lead_id: 'test-lead',
    lead_name: 'James A Frenchik',
    linkedin_url: JAMES_URL,
    inbound_message: 'Happy to chat next week.',
    thread_context: {
      messages: [{ role: 'prospect', message: 'Happy to chat next week.' }],
      heyreach: { campaignName: 'Nutter' },
    },
  };
  await sendHeyreachReply(
    { heyreach_api_key: 'super-secret-heyreach-key' },
    reply,
    'Thanks James — what time works?',
    {
      lookupSibling: async () => null,
      findConversation: async (apiKey, query) => {
        events.push('find');
        assert.equal(apiKey, 'super-secret-heyreach-key');
        assert.equal(query.linkedinUrl, JAMES_URL);
        assert.equal(query.leadName, 'James A Frenchik');
        assert.equal(query.allowNameSearch, true);
        assert.ok(query.maxPages > 3);
        return jamesConversation();
      },
      query: async (sql, params) => {
        if (/thread_context #>>/.test(sql)) return { rows: [] };
        events.push('persist');
        assert.match(sql, /UPDATE pending_replies/);
        const stored = JSON.parse(params[0]);
        assert.equal(stored.heyreach.conversationId, '2-Y29udmVyc2F0aW9u');
        assert.equal(stored.heyreach.linkedinAccountId, 8811);
        assert.equal(stored.heyreach.linkedinUrl, JAMES_CANONICAL);
        assert.equal(stored.messages[0].message, 'Happy to chat next week.');
        return { rows: [] };
      },
      sendMessage: async (_key, payload) => {
        events.push('send');
        assert.equal(payload.conversationId, '2-Y29udmVyc2F0aW9u');
        assert.equal(payload.linkedInAccountId, 8811);
        assert.equal(payload.message, 'Thanks James — what time works?');
        return { ok: true };
      },
    },
  );
  assert.deepEqual(events, ['find', 'persist', 'send']);
  assert.equal(reply.thread_context.heyreach.conversationId, '2-Y29udmVyc2F0aW9u');
});

test('a second resolution is not required once identifiers were stored, and send still happens once per call', async () => {
  let finds = 0;
  let sends = 0;
  const reply = {
    id: 'card-ready',
    client_id: 'client-nutter',
    lead_name: 'James A Frenchik',
    linkedin_url: JAMES_CANONICAL,
    thread_context: {
      heyreach: { conversationId: 'conv-ready', linkedinAccountId: 55 },
    },
  };
  await sendHeyreachReply({ heyreach_api_key: 'k' }, reply, 'Hello', {
    lookupSibling: async () => { throw new Error('should not look up a sibling'); },
    findConversation: async () => { finds += 1; return null; },
    query: async (sql) => {
      if (/thread_context #>>/.test(sql)) return { rows: [] };
      throw new Error('should not rewrite a complete row');
    },
    sendMessage: async (_key, payload) => {
      sends += 1;
      assert.equal(payload.conversationId, 'conv-ready');
      assert.equal(payload.linkedInAccountId, 55);
    },
  });
  assert.equal(finds, 0);
  assert.equal(sends, 1);
});

test('a second card for the same LinkedIn inbound does not send again', async () => {
  let sends = 0;
  const reply = {
    id: 'manual-card',
    client_id: 'client-nutter',
    lead_id: 'test-lead',
    lead_name: 'James A Frenchik',
    linkedin_url: JAMES_URL,
    inbound_message: 'Happy to chat next week.',
    thread_context: { heyreach: {} },
  };
  const result = await sendHeyreachReply({ heyreach_api_key: 'k' }, reply, 'Different draft', {
    lookupSibling: async () => null,
    findConversation: async () => jamesConversation(),
    query: async (sql) => {
      if (/thread_context #>>/.test(sql)) {
        return { rows: [{ id: 'first-card', inbound_message: 'Happy to chat next week.' }] };
      }
      if (/UPDATE pending_replies/.test(sql)) return { rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
    sendMessage: async () => { sends += 1; },
  });
  assert.equal(sends, 0);
  assert.equal(result.skippedDuplicate, true);

  const laterReply = await sendHeyreachReply({ heyreach_api_key: 'k' }, {
    ...reply,
    id: 'later-reply',
    inbound_message: 'Actually, Thursday is better.',
  }, 'Thursday works', {
    lookupSibling: async () => null,
    findConversation: async () => jamesConversation(),
    query: async (sql) => {
      if (/thread_context #>>/.test(sql)) {
        return { rows: [{ id: 'first-card', inbound_message: 'Happy to chat next week.' }] };
      }
      return { rows: [] };
    },
    sendMessage: async () => { sends += 1; },
  });
  assert.equal(laterReply, undefined);
  assert.equal(sends, 1);
});

test('lookup not found fails safely with no send', async () => {
  let sends = 0;
  await assert.rejects(
    () => sendHeyreachReply(
      { heyreach_api_key: 'super-secret-heyreach-key' },
      {
        id: 'card-missing',
        client_id: 'client-nutter',
        lead_name: 'James A Frenchik',
        linkedin_url: JAMES_URL,
        thread_context: { heyreach: {} },
      },
      'Hello',
      {
        lookupSibling: async () => null,
        findConversation: async () => null,
        query: async () => { throw new Error('must not persist when nothing was found'); },
        sendMessage: async () => { sends += 1; },
      },
    ),
    (err) => /conversation not found/i.test(err.message) && /Nothing was sent/.test(err.message),
  );
  assert.equal(sends, 0);
});

test('HeyReach 500 fails safely with no send', async () => {
  let sends = 0;
  const boom = new Error('HeyReach GetConversationsV2 failed (500): super-secret-heyreach-key inbox down');
  boom.status = 500;
  await assert.rejects(
    () => sendHeyreachReply(
      { heyreach_api_key: 'super-secret-heyreach-key' },
      {
        id: 'card-500',
        client_id: 'client-nutter',
        lead_name: 'James A Frenchik',
        linkedin_url: JAMES_URL,
        thread_context: {},
      },
      'Hello',
      {
        lookupSibling: async () => null,
        findConversation: async () => { throw boom; },
        query: async () => { throw new Error('must not persist after a HeyReach error'); },
        sendMessage: async () => { sends += 1; },
      },
    ),
    (err) => {
      assert.match(err.message, /Nothing was sent/);
      assert.match(err.message, /500/);
      assert.equal(err.message.includes('super-secret-heyreach-key'), false);
      return true;
    },
  );
  assert.equal(sends, 0);
});

test('a stored linkedin URL on a sibling row is what the lookup uses', async () => {
  const seen = [];
  await sendHeyreachReply(
    { heyreach_api_key: 'k' },
    {
      id: 'manual-card',
      client_id: 'client-nutter',
      lead_id: 'test-lead',
      lead_name: 'James A Frenchik',
      linkedin_url: null,
      inbound_message: '(test) fake',
      thread_context: { heyreach: { campaignName: 'Nutter' } },
    },
    'Hello',
    {
      lookupSibling: async () => ({ linkedinUrl: JAMES_URL }),
      findConversation: async (_key, query) => {
        seen.push(query.linkedinUrl);
        return jamesConversation();
      },
      query: async () => ({ rows: [] }),
      sendMessage: async (_key, payload) => {
        assert.equal(payload.conversationId, '2-Y29udmVyc2F0aW9u');
        assert.equal(payload.linkedInAccountId, 8811);
      },
    },
  );
  assert.deepEqual(seen, [JAMES_URL]);
});

test('sibling identifier lookup uses one LinkedIn URL for the same name', async () => {
  const reply = {
    id: 'manual-card',
    client_id: 'client-nutter',
    lead_id: 'test-lead',
    lead_name: 'James A Frenchik',
    linkedin_url: null,
    inbound_message: 'a different manual body',
  };
  const hit = await lookupStoredHeyreachIdentifiers(reply, async () => ({
    rows: [{
      id: '50080d39-9f97-4b80-8983-29951b1a08d7',
      lead_name: 'James A Frenchik',
      linkedin_url: JAMES_CANONICAL,
      inbound_message: 'the real LinkedIn reply',
      thread_context: null,
    }],
  }));
  assert.equal(hit.linkedinUrl, JAMES_CANONICAL);

  const middleInitial = await lookupStoredHeyreachIdentifiers(reply, async () => ({
    rows: [{
      id: '50080d39-9f97-4b80-8983-29951b1a08d7',
      lead_name: 'James Frenchik',
      linkedin_url: JAMES_CANONICAL,
      inbound_message: 'the real LinkedIn reply',
      thread_context: null,
    }],
  }));
  assert.equal(middleInitial.linkedinUrl, JAMES_CANONICAL);

  const ambiguous = await lookupStoredHeyreachIdentifiers(reply, async () => ({
    rows: [
      { id: 'a', lead_name: 'James A Frenchik', linkedin_url: JAMES_CANONICAL, inbound_message: 'one', thread_context: null },
      { id: 'b', lead_name: 'James A Frenchik', linkedin_url: 'https://www.linkedin.com/in/james-other/', inbound_message: 'two', thread_context: null },
    ],
  }));
  assert.equal(ambiguous, null);
});

test('suppressed LinkedIn reply retains HeyReach identifiers', async () => {
  const original = db.query.bind(db);
  let captured = null;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await recordSuppressedReply({
      clientId: 'client-nutter',
      platform: 'heyreach',
      campaignId: '321',
      campaignName: 'Nutter LinkedIn',
      leadId: 'lead-james',
      leadName: 'James A Frenchik',
      linkedinUrl: JAMES_CANONICAL,
      inboundMessage: 'Happy to chat next week.',
      classification: 'OTHER',
      reason: 'not_interested_channel_test',
      threadContext: {
        messages: [{ role: 'prospect', message: 'Happy to chat next week.' }],
        heyreach: {
          conversationId: '2-Y29udmVyc2F0aW9u',
          linkedinAccountId: 8811,
          linkedinUrl: JAMES_CANONICAL,
          listId: 7,
        },
      },
    });
  } finally {
    db.query = original;
  }
  assert.match(captured.sql, /thread_context/);
  assert.match(captured.sql, /'suppressed'/);
  const stored = JSON.parse(captured.params[9]);
  assert.equal(stored.heyreach.conversationId, '2-Y29udmVyc2F0aW9u');
  assert.equal(stored.heyreach.linkedinAccountId, 8811);
  assert.equal(stored.messages[0].message, 'Happy to chat next week.');
  assert.equal(captured.params[7], JAMES_CANONICAL);

  const poller = read('src/services/heyreach-poller.js');
  const webhook = read('src/routes/webhooks.js');
  const pollerCall = poller.slice(
    poller.indexOf('await recordSuppressedReply'),
    poller.indexOf('return { skipped: suppressed }'),
  );
  assert.match(pollerCall, /threadContext:\s*meta/);
  assert.match(poller, /conversationId: convId/);
  assert.match(poller, /linkedinAccountId: linkedInAccountId\(conv\)/);
  const webhookCall = webhook.slice(webhook.indexOf('HeyReach reply suppressed'));
  assert.match(webhookCall, /threadContext: contextWithMeta/);
  assert.match(webhook, /conversationId: hrConversationId/);
  assert.match(webhook, /linkedinAccountId/);
});

test('approve path resolves HeyReach after the outbound claim', () => {
  const send = read('src/services/reply-send.js');
  const fn = send.slice(
    send.indexOf('async function sendReplyToPlatform'),
    send.indexOf('async function maybeBookMeetingAfterSend'),
  );
  assert.ok(fn.indexOf('claimOutboundSend') < fn.indexOf('sendHeyreachReply'));
  assert.ok(fn.indexOf('alreadySentSameOutbound') < fn.indexOf('sendHeyreachReply'));
  assert.doesNotMatch(fn, /heyreach\.sendMessage/);
});

test('admin promotion posts one card for the stored reply and will not insert another', async () => {
  const fullInbound = `Happy to chat next week. ${'detail '.repeat(80)}`;
  assert.ok(fullInbound.length > 280);
  const row = {
    id: '50080d39-9f97-4b80-8983-29951b1a08d7',
    client_id: 'client-nutter',
    platform: 'heyreach',
    campaign_id: '321',
    campaign_name: 'Nutter LinkedIn',
    lead_id: 'lead-james',
    lead_name: 'James A Frenchik',
    linkedin_url: JAMES_CANONICAL,
    inbound_message: fullInbound,
    thread_context: {
      messages: [{ role: 'prospect', message: fullInbound }],
      heyreach: { conversationId: '2-Y29udmVyc2F0aW9u', linkedinAccountId: 8811, linkedinUrl: JAMES_CANONICAL },
    },
    status: 'suppressed',
    slack_message_ts: null,
    slack_bot_token: 'xoxb-test',
    slack_channel_id: 'C123',
    active: true,
    created_at: '2026-10-26T20:08:00.000Z',
  };
  const sqls = [];
  let posts = 0;
  const query = async (sql, params) => {
    sqls.push(sql);
    if (/JOIN clients/.test(sql)) return { rows: [row] };
    if (/slack_message_ts IS NOT NULL/.test(sql)) return { rows: [] };
    if (/UPDATE pending_replies/.test(sql)) {
      assert.equal(params[0], 'INTERESTED');
      assert.equal(params[2], row.id);
      return { rows: [{ ...row, classification: 'INTERESTED', draft_reply: params[1], status: 'pending' }] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
  const first = await postStoredHeyreachApprovalCard({
    replyId: row.id,
    draft: 'Thanks James — Tuesday or Wednesday?',
    query,
    postFn: async (args) => {
      posts += 1;
      assert.equal(args.card.inboundMessage, fullInbound);
      assert.equal(args.replyId, row.id);
      assert.equal(args.platform, 'heyreach');
      assert.equal(args.isDraft, true);
      return { ts: '111.222' };
    },
  });
  assert.equal(first.posted, true);
  assert.equal(first.slackMessageTs, '111.222');
  assert.equal(posts, 1);
  assert.equal(sqls.some((sql) => /INSERT INTO pending_replies/i.test(sql)), false);

  row.slack_message_ts = '111.222';
  const second = await postStoredHeyreachApprovalCard({
    replyId: row.id,
    draft: 'Thanks James — Tuesday or Wednesday?',
    query,
    postFn: async () => { posts += 1; return { ts: '999.000' }; },
  });
  assert.equal(second.posted, false);
  assert.equal(second.reason, 'card_already_posted');
  assert.equal(posts, 1);

  row.slack_message_ts = null;
  const duplicate = await postStoredHeyreachApprovalCard({
    replyId: row.id,
    draft: 'Thanks James — Tuesday or Wednesday?',
    query: async (sql) => {
      if (/JOIN clients/.test(sql)) return { rows: [{ ...row, slack_message_ts: null }] };
      if (/slack_message_ts IS NOT NULL/.test(sql)) {
        return { rows: [{ id: 'manual-card', slack_message_ts: '111.222' }] };
      }
      if (/UPDATE pending_replies/.test(sql)) throw new Error('must not update when a card already exists');
      throw new Error(`unexpected sql: ${sql}`);
    },
    postFn: async () => { posts += 1; return { ts: '333.444' }; },
  });
  assert.equal(duplicate.posted, false);
  assert.equal(duplicate.reason, 'duplicate_card');
  assert.equal(duplicate.existingReplyId, 'manual-card');
  assert.equal(posts, 1);

  const service = read('src/services/heyreach-approval-card.js');
  const admin = read('src/routes/admin.js');
  assert.doesNotMatch(service, /INSERT INTO pending_replies/i);
  assert.match(admin, /\/admin\/heyreach\/approval-card/);
  assert.doesNotMatch(admin, /requireAdminApiKey/);
});

test('a row with only a list id and LinkedIn URL is resolved first, not sent by list id', async () => {
  const events = [];
  const reply = {
    id: 'card-list-only',
    client_id: 'client-nutter',
    lead_id: 'lead-9',
    lead_name: 'James A Frenchik',
    linkedin_url: JAMES_URL,
    thread_context: { heyreach: { listId: 1024318, linkedinAccountId: 245028 } },
  };
  await sendHeyreachReply({ heyreach_api_key: 'k' }, reply, 'Hello', {
    lookupSibling: async () => null,
    findConversation: async () => { events.push('find'); return jamesConversation(); },
    query: async () => ({ rows: [] }),
    sendMessage: async (_key, payload) => {
      events.push('send');
      assert.equal(payload.conversationId, '2-Y29udmVyc2F0aW9u');
      assert.equal(payload.linkedInAccountId, 8811);
    },
  });
  assert.deepEqual(events, ['find', 'send']);
});

test('HeyReach 404 conversation does not exist re-resolves once and retries with the fresh ids', async () => {
  const events = [];
  const persisted = [];
  const reply = {
    id: 'card-stale',
    client_id: 'client-nutter',
    lead_id: 'lead-9',
    lead_name: 'James A Frenchik',
    linkedin_url: JAMES_URL,
    thread_context: { heyreach: { conversationId: 'stale-id', linkedinAccountId: 1 } },
  };
  await sendHeyreachReply({ heyreach_api_key: 'k' }, reply, 'Hello', {
    lookupSibling: async () => { throw new Error('should not look up a sibling'); },
    findConversation: async (_key, query) => {
      events.push('find');
      assert.equal(query.conversationId, null, 'stale id is not a search key');
      assert.equal(query.linkedinUrl, JAMES_URL);
      return jamesConversation();
    },
    query: async (sql, params) => {
      if (/thread_context #>>/.test(sql)) return { rows: [] };
      persisted.push(JSON.parse(params[0]).heyreach);
      return { rows: [] };
    },
    sendMessage: async (_key, payload) => {
      events.push(`send:${payload.conversationId}`);
      if (payload.conversationId === 'stale-id') {
        const err = new Error('HeyReach sendMessage failed (404): {"errorMessage":"This conversation does not exist"}');
        err.status = 404;
        throw err;
      }
    },
  });
  assert.deepEqual(events, ['send:stale-id', 'find', 'send:2-Y29udmVyc2F0aW9u']);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].conversationId, '2-Y29udmVyc2F0aW9u');
  assert.equal(persisted[0].linkedinAccountId, 8811);
});

test('HeyReach 404 with the same ids from the inbox fails with nothing sent', async () => {
  let sends = 0;
  const reply = {
    id: 'card-same',
    client_id: 'client-nutter',
    lead_name: 'James A Frenchik',
    linkedin_url: JAMES_URL,
    thread_context: { heyreach: { conversationId: '2-Y29udmVyc2F0aW9u', linkedinAccountId: 8811 } },
  };
  await assert.rejects(
    sendHeyreachReply({ heyreach_api_key: 'k' }, reply, 'Hello', {
      lookupSibling: async () => null,
      findConversation: async () => jamesConversation(),
      query: async () => ({ rows: [] }),
      sendMessage: async () => {
        sends += 1;
        const err = new Error('HeyReach sendMessage failed (404): conversation does not exist');
        err.status = 404;
        throw err;
      },
    }),
    /same ids\. Nothing was sent/,
  );
  assert.equal(sends, 1);
});

test('HeyReach 404 then lookup not found fails with nothing sent; a 500 is not retried', async () => {
  const base = {
    id: 'card-nf',
    client_id: 'client-nutter',
    lead_name: 'James A Frenchik',
    linkedin_url: JAMES_URL,
    thread_context: { heyreach: { conversationId: 'stale-id', linkedinAccountId: 1 } },
  };
  let sends = 0;
  await assert.rejects(
    sendHeyreachReply({ heyreach_api_key: 'k' }, { ...base }, 'Hello', {
      lookupSibling: async () => null,
      findConversation: async () => null,
      query: async () => ({ rows: [] }),
      sendMessage: async () => {
        sends += 1;
        const err = new Error('HeyReach sendMessage failed (404): This conversation does not exist');
        err.status = 404;
        throw err;
      },
    }),
    /Nothing was sent/,
  );
  assert.equal(sends, 1);

  let finds = 0;
  await assert.rejects(
    sendHeyreachReply({ heyreach_api_key: 'k' }, { ...base }, 'Hello', {
      lookupSibling: async () => null,
      findConversation: async () => { finds += 1; return jamesConversation(); },
      query: async () => ({ rows: [] }),
      sendMessage: async () => {
        const err = new Error('HeyReach sendMessage failed (500): boom');
        err.status = 500;
        throw err;
      },
    }),
    /500/,
  );
  assert.equal(finds, 0);
});

test('heyreach.sendMessage puts the HTTP status on the error', async () => {
  const f = installFetch(async () => ({ status: 404, body: '{"errorMessage":"This conversation does not exist"}' }));
  try {
    await assert.rejects(
      heyreach.sendMessage('k', { conversationId: 'c', linkedInAccountId: 1, message: 'hi' }),
      (err) => err.status === 404 && /does not exist/.test(err.message),
    );
  } finally {
    f.restore();
  }
});
