/**
 * Marbella Porcayo's 10:32 AM ET reply was dropped. Startup posts one card
 * for that Message-ID, with Cayden's fixed confirmation, and does not send.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MARBELLA_DRAFT,
  MARBELLA_MESSAGE_ID,
  MARBELLA_INBOUND,
  MARBELLA_CAMPAIGN_ID,
  ensureMarbellaReplyCard,
} = require('../src/services/marbella-reply-card');
const { canonicalInboundMessageId } = require('../src/utils/inbound-message-id');

const ROOT = path.join(__dirname, '..');
const MESSAGE_ID = canonicalInboundMessageId(MARBELLA_MESSAGE_ID);
const CLIENT = {
  id: 'client-vector',
  name: 'Vector',
  slack_bot_token: 'xoxb-test',
  slack_channel_id: 'C-vector',
};

function harness(seed = []) {
  const store = seed.map((row) => ({ ...row }));
  const posts = [];
  let claims = 0;

  async function query(sql, params = []) {
    const s = String(sql);
    if (/INSERT INTO pending_replies/i.test(s)) {
      const row = {
        id: 'marbella-1',
        client_id: params[0],
        campaign_id: params[1],
        lead_id: params[3],
        lead_name: params[4],
        lead_email: params[5],
        inbound_message: params[6],
        thread_context: params[7],
        classification: 'MEETING_PROPOSED',
        draft_reply: params[8],
        status: 'pending',
        inbound_message_id: params[9],
        slack_message_ts: null,
      };
      store.push(row);
      return { rows: [row] };
    }
    if (/UPDATE pending_replies/i.test(s)) {
      const row = store.find((r) => r.id === params[1]);
      if (row && !row.slack_message_ts) {
        row.draft_reply = params[0];
        row.classification = 'MEETING_PROPOSED';
        if (row.status === 'suppressed') row.status = 'pending';
      }
      return { rows: row ? [row] : [] };
    }
    if (/inbound_message_id/i.test(s)) {
      const mid = String(params[0] || '').toLowerCase();
      return {
        rows: store.filter((r) => String(r.inbound_message_id || '').toLowerCase() === mid),
      };
    }
    throw new Error(`unexpected sql: ${s.slice(0, 120)}`);
  }

  async function claim(keys, insertFn) {
    claims += 1;
    const existing = store.find((r) => String(r.inbound_message_id || '').toLowerCase() === String(keys.messageId || '').toLowerCase());
    if (existing) return { duplicate: true, existing };
    const reply = await insertFn({ query });
    return { duplicate: false, reply };
  }

  async function postCard(args) {
    posts.push(args);
    const row = store.find((r) => r.id === args.replyId);
    if (row) row.slack_message_ts = '1761580000.000100';
    return { ts: '1761580000.000100' };
  }

  return {
    store,
    posts,
    claimCount: () => claims,
    run: () => ensureMarbellaReplyCard({
      query,
      loadClient: async () => CLIENT,
      claim,
      postCard,
    }),
  };
}

test('startup posts one card with the fixed confirmation and a second boot does nothing', async () => {
  const h = harness();
  const first = await h.run();
  assert.equal(first.action, 'posted');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].card.draft, MARBELLA_DRAFT);
  assert.equal(h.posts[0].card.draft, 'Hey Marbella, that time works for us. We look forward to meeting with you Wednesday, Oct 28 at 11:00 AM PDT!');
  assert.equal(h.posts[0].isDraft, true);
  assert.equal(h.posts[0].channelId, 'C-vector');
  assert.equal(h.posts[0].campaignId, MARBELLA_CAMPAIGN_ID);
  assert.equal(h.store.length, 1);
  assert.equal(h.store[0].inbound_message_id, MESSAGE_ID);
  assert.equal(h.store[0].inbound_message, MARBELLA_INBOUND);
  assert.equal(h.store[0].draft_reply, MARBELLA_DRAFT);
  assert.equal(h.store[0].classification, 'MEETING_PROPOSED');

  const second = await h.run();
  assert.equal(second.action, 'already_posted');
  assert.equal(h.posts.length, 1);
  assert.equal(h.store.length, 1);
  assert.equal(h.claimCount(), 1);
});

test('a card already stored for that Message-ID is left alone', async () => {
  const h = harness([{
    id: 'existing',
    inbound_message_id: MESSAGE_ID,
    slack_message_ts: '1761570000.000100',
    status: 'pending',
    draft_reply: 'something else',
    classification: 'MEETING_PROPOSED',
  }]);
  const out = await h.run();
  assert.equal(out.action, 'already_posted');
  assert.equal(h.posts.length, 0);
  assert.equal(h.claimCount(), 0);
  assert.equal(h.store[0].draft_reply, 'something else');
});

test('an unposted row for that Message-ID is posted once with the fixed draft', async () => {
  const h = harness([{
    id: 'existing',
    inbound_message_id: MARBELLA_MESSAGE_ID,
    slack_message_ts: null,
    status: 'pending',
    draft_reply: '',
    classification: 'OTHER',
    inbound_message: MARBELLA_INBOUND,
  }]);
  const out = await h.run();
  assert.equal(out.action, 'posted');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].card.draft, MARBELLA_DRAFT);
  assert.equal(h.store.length, 1);
  assert.equal(h.store[0].draft_reply, MARBELLA_DRAFT);
  assert.equal(h.claimCount(), 0);
  const again = await h.run();
  assert.equal(again.action, 'already_posted');
  assert.equal(h.posts.length, 1);
});

test('startup wires the one-shot and the draft is not model-written or sent', () => {
  const cron = fs.readFileSync(path.join(ROOT, 'src/cron.js'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'src/services/marbella-reply-card.js'), 'utf8');
  assert.match(cron, /ensureMarbellaReplyCard/);
  assert.match(src, /C472638D-01F3-4902-B61B-C0C8AE0A923A@pacocean\.net/);
  assert.match(src, /Hey Marbella, that time works for us\. We look forward to meeting with you Wednesday, Oct 28 at 11:00 AM PDT!/);
  assert.doesNotMatch(src, /classifyAndDraft|draftOnly|sendReply|reply-send/);
});
