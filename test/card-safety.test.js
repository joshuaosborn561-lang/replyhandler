/**
 * One open card per lead, clicks land on the row's own Slack message,
 * Reject never changes a lead category, and a failed send can be retried
 * once without a second provider send.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const slack = require('../src/services/slack');
const db = require('../src/db');
const smartlead = require('../src/services/smartlead');
const heyreach = require('../src/services/heyreach');
const slackRouter = require('../src/routes/slack');
const guard = require('../src/services/card-click-guard');
const {
  groupOpenRows,
  supersedeFooter,
  supersedeEarlierOpenCards,
  retireDuplicateOpenCards,
} = require('../src/services/supersede-cards');
const { sweepStuckSends } = require('../src/services/stuck-send-sweeper');
const { trackSend, drainInFlightSends, inFlightCount, isSendInFlight } = require('../src/services/send-inflight');
const { heyreachCanApprove, prepareHeyreachDraftCard } = require('../src/services/heyreach-card-gate');
const { rememberCard, forgetCardMemory, loadLatestCard } = require('../src/services/slack-reply-post');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const OLDER = '9101464e-0000-4000-8000-000000000001';
const NEWER = '946df2e7-0000-4000-8000-000000000002';
const OLDER_TS = '1793313695.519449';
const NEWER_TS = '1793313700.100001';
const OTHER_OLD = 'aaaaaaaa-0000-4000-8000-000000000003';
const OTHER_NEW = 'bbbbbbbb-0000-4000-8000-000000000004';
const CLIENT_ID = 'cccccccc-0000-4000-8000-000000000010';
const CLIENT_ID_2 = 'cccccccc-0000-4000-8000-000000000011';

function openRow(overrides) {
  return {
    id: OLDER,
    client_id: CLIENT_ID,
    platform: 'smartlead',
    campaign_id: 'camp-1',
    lead_id: 'lead-1',
    lead_email: 'lead@example.test',
    lead_name: 'Lead',
    classification: 'INTERESTED',
    inbound_message: 'yes',
    status: 'pending',
    slack_channel_id: 'C-ROW',
    slack_message_ts: OLDER_TS,
    created_at: '2026-10-30T12:00:00.000Z',
    ...overrides,
  };
}

function actionIds(blocks) {
  return blocks
    .filter((b) => b && b.type === 'actions')
    .flatMap((b) => (b.elements || []).map((el) => el.action_id));
}

describe('supersede older open cards', () => {
  it('groups rows that share a lead id or an email, and keeps the newest', () => {
    const groups = groupOpenRows([
      openRow({ id: OLDER, created_at: '2026-10-30T12:00:00.000Z', slack_message_ts: OLDER_TS }),
      openRow({ id: NEWER, created_at: '2026-10-31T12:00:00.000Z', slack_message_ts: NEWER_TS, lead_id: 'other-id' }),
      openRow({
        id: OTHER_OLD, client_id: CLIENT_ID_2, platform: 'heyreach', campaign_id: 'camp-2',
        lead_id: 'lead-2', lead_email: 'other@example.test', created_at: '2026-10-29T12:00:00.000Z',
        slack_message_ts: '1793313600.000001',
      }),
      openRow({
        id: OTHER_NEW, client_id: CLIENT_ID_2, platform: 'heyreach', campaign_id: 'camp-2',
        lead_id: 'lead-2b', lead_email: 'other@example.test', created_at: '2026-10-31T15:00:00.000Z',
        slack_message_ts: '1793313800.000001',
      }),
    ]);
    assert.equal(groups.length, 2);
    const ids = groups.map((g) => g.map((r) => r.id).sort());
    assert.deepEqual(ids.map((g) => g.join(',')).sort(), [
      [OLDER, NEWER].sort().join(','),
      [OTHER_OLD, OTHER_NEW].sort().join(','),
    ].sort());
  });

  it('dry-run lists older ids and writes nothing; a live run is idempotent', async () => {
    const rows = [
      openRow({ id: OLDER, slack_message_ts: OLDER_TS, created_at: '2026-10-30T12:00:00.000Z' }),
      openRow({ id: NEWER, slack_message_ts: NEWER_TS, created_at: '2026-10-31T12:00:00.000Z' }),
      openRow({
        id: OTHER_OLD, client_id: CLIENT_ID_2, platform: 'heyreach', campaign_id: 'camp-2',
        lead_id: 'lead-2', lead_email: 'other@example.test',
        slack_channel_id: 'C-OTHER', slack_message_ts: '1793313600.000001',
        created_at: '2026-10-29T12:00:00.000Z',
      }),
      openRow({
        id: OTHER_NEW, client_id: CLIENT_ID_2, platform: 'heyreach', campaign_id: 'camp-2',
        lead_id: 'lead-2', lead_email: 'other@example.test',
        slack_channel_id: 'C-OTHER', slack_message_ts: '1793313800.000001',
        created_at: '2026-10-31T15:00:00.000Z',
      }),
    ];
    const updates = [];
    const paints = [];
    const query = async (sql, params) => {
      if (/FROM pending_replies/.test(sql) && /status = ANY/.test(sql) && /SELECT/.test(sql)) {
        return {
          rows: rows.filter((r) => ['pending', 'flagged', 'alert_only', 'failed'].includes(r.status)),
        };
      }
      if (/FROM clients/.test(sql)) {
        return { rows: [{ id: params[0], slack_bot_token: 'xoxb-test', slack_channel_id: 'C-CLIENT' }] };
      }
      if (/status = 'superseded'/.test(sql)) {
        const row = rows.find((r) => r.id === params[0]);
        if (!row || !['pending', 'flagged', 'alert_only', 'failed'].includes(row.status)) {
          return { rowCount: 0 };
        }
        row.status = 'superseded';
        row.superseded_by = params[1];
        updates.push(row.id);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    };
    const updateCard = async (token, channel, ts, payload) => {
      paints.push({ token, channel, ts, payload });
    };
    const getPermalink = async (_token, channel, ts) => `https://slack.test/${channel}/${ts}`;

    const dry = await retireDuplicateOpenCards({ dryRun: true, query, updateCard, getPermalink });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.groups, 2);
    assert.deepEqual(dry.retire.sort(), [OLDER, OTHER_OLD].sort());
    assert.deepEqual(dry.keep.sort(), [NEWER, OTHER_NEW].sort());
    assert.equal(updates.length, 0);
    assert.equal(paints.length, 0);
    assert.ok(rows.every((r) => r.status === 'pending'));

    const live = await retireDuplicateOpenCards({
      dryRun: false, query, updateCard, getPermalink,
      cardContext: async () => ({ campaignDisplay: 'Camp' }),
    });
    assert.deepEqual(live.retire.sort(), [OLDER, OTHER_OLD].sort());
    assert.equal(paints.length, 2);
    const olderPaint = paints.find((p) => p.ts === OLDER_TS);
    assert.ok(olderPaint);
    assert.equal(olderPaint.channel, 'C-ROW');
    assert.equal(olderPaint.payload.actionKind, 'superseded');
    assert.match(olderPaint.payload.extraFooter, /Superseded by newer card/);
    assert.match(olderPaint.payload.extraFooter, new RegExp(NEWER_TS.replace('.', '\\.')));
    const blocks = slack.buildSentConfirmationBlocks(olderPaint.payload);
    assert.equal(blocks.some((b) => b.type === 'actions'), false);
    assert.match(JSON.stringify(blocks), /Superseded by newer card/);
    assert.match(JSON.stringify(blocks), /Open the newer card/);
    assert.equal(blocks[blocks.length - 1].type, 'context');

    paints.length = 0;
    const again = await retireDuplicateOpenCards({
      dryRun: false, query, updateCard, getPermalink,
    });
    assert.equal(again.groups, 0);
    assert.deepEqual(again.retire, []);
    assert.equal(paints.length, 0);
    assert.equal(updates.length, 2);
  });

  it('posting a newer card supersedes the earlier open row for that lead', async () => {
    const older = openRow({ id: OLDER, slack_message_ts: OLDER_TS });
    const paints = [];
    const query = async (sql, params) => {
      if (/FROM pending_replies/.test(sql) && /id <>/.test(sql)) {
        return { rows: [older] };
      }
      if (/FROM clients/.test(sql)) {
        return { rows: [{ id: params[0], slack_bot_token: 'xoxb-test', slack_channel_id: 'C-CLIENT' }] };
      }
      if (/status = 'superseded'/.test(sql)) {
        older.status = 'superseded';
        return { rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    };
    const result = await supersedeEarlierOpenCards({
      clientId: CLIENT_ID,
      platform: 'smartlead',
      campaignId: 'camp-1',
      leadId: 'lead-1',
      leadEmail: 'lead@example.test',
      keepId: NEWER,
      newTs: NEWER_TS,
      channelId: 'C-NEW',
      token: 'xoxb-test',
      query,
      updateCard: async (token, channel, ts, payload) => { paints.push({ channel, ts, payload }); },
      cardContext: async () => ({ campaignDisplay: 'Camp' }),
      getPermalink: async () => `https://slack.test/C-NEW/${NEWER_TS}`,
    });
    assert.deepEqual(result.retired, [OLDER]);
    assert.equal(paints[0].channel, 'C-ROW');
    assert.equal(paints[0].ts, OLDER_TS);
    assert.equal(paints[0].payload.actionKind, 'superseded');
    assert.match(supersedeFooter(paints[0].payload.extraFooter && 'https://slack.test/x'), /Superseded by newer card/);
    assert.match(paints[0].payload.extraFooter, /Open the newer card/);

    const second = await supersedeEarlierOpenCards({
      clientId: CLIENT_ID,
      platform: 'smartlead',
      campaignId: 'camp-1',
      leadId: 'lead-1',
      keepId: NEWER,
      newTs: NEWER_TS,
      channelId: 'C-NEW',
      token: 'xoxb-test',
      query: async (sql) => {
        if (/FROM pending_replies/.test(sql)) return { rows: [] };
        throw new Error(sql);
      },
      updateCard: async () => { throw new Error('should not paint'); },
      getPermalink: async () => 'https://slack.test/C-NEW/again',
    });
    assert.deepEqual(second.retired, []);
  });

  it('admin post and the HeyReach post both retire earlier cards; retire-duplicates stays open', () => {
    const admin = read('src/routes/admin.js');
    const post = read('src/services/slack-reply-post.js');
    const route = admin.slice(admin.indexOf("router.post('/admin/cards/retire-duplicates'"));
    const handler = route.slice(0, route.indexOf('router.post(' , 10));
    assert.match(admin, /supersedeEarlierOpenCards\(/);
    assert.match(post, /supersedeEarlierOpenCards\(/);
    assert.match(post, /platform === 'heyreach'/);
    assert.match(handler, /retireDuplicateOpenCards/);
    assert.match(handler, /parseDryRun/);
    assert.doesNotMatch(handler, /requireAdminApiKey/);
    assert.match(read('scripts/run-migrations.js'), /053_card_supersede_payload\.sql/);
  });
});

describe('clicks update the row message and never blank it', () => {
  it('cardTarget is the stored channel and ts, not the clicked message', () => {
    const { cardTarget } = slackRouter.cardHelpers;
    const target = cardTarget(
      { slack_channel_id: 'C-ROW', slack_message_ts: OLDER_TS },
      { slack_channel_id: 'C-CLIENT' }
    );
    assert.deepEqual(target, { channelId: 'C-ROW', ts: OLDER_TS });
    assert.equal(
      cardTarget({ slack_message_ts: OLDER_TS }, { slack_channel_id: 'C-CLIENT' }).channelId,
      'C-CLIENT'
    );
    assert.equal(cardTarget({ slack_channel_id: 'C-ROW', slack_message_ts: 'claiming:1' }, {}), null);
  });

  it('setCardStatus keeps the body and swaps buttons for a status line', async () => {
    const src = read('src/routes/slack.js');
    const fn = src.slice(src.indexOf('async function setCardStatus'), src.indexOf('async function paintConfirmation'));
    assert.match(fn, /cardTarget\(reply, client\)/);
    assert.match(fn, /replaceActionsWithStatus/);
    assert.match(fn, /updateMessageKeepingBlocks/);
    assert.doesNotMatch(fn, /blocks:\s*\[\]/);
    assert.doesNotMatch(fn, /updateMessage\(/);
    const body = [
      { type: 'section', text: { type: 'mrkdwn', text: 'They replied yes' } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'approve_reply', text: { type: 'plain_text', text: 'Approve' } }] },
    ];
    const next = slack.replaceActionsWithStatus(body, '⏳ Sending...');
    assert.equal(next.some((b) => b.type === 'actions'), false);
    assert.match(JSON.stringify(next), /They replied yes/);
    assert.match(JSON.stringify(next), /Sending/);
    assert.equal(await slack.updateMessageKeepingBlocks('tok', 'C', '1.2', 'x', []), null);
  });

  it('a second click on a closed card is an ephemeral notice', async () => {
    const notices = [];
    const closed = await guard.noticeIfClosed(
      { action_id: 'reject_reply', value: OLDER },
      { response_url: 'https://hooks.slack.test/response', message: { ts: '999.1' } },
      {
        query: async () => ({ rows: [{ status: 'superseded' }] }),
        fetchImpl: async (_url, opts) => {
          notices.push(JSON.parse(opts.body));
          return { ok: true };
        },
      }
    );
    assert.equal(closed, true);
    assert.equal(notices[0].response_type, 'ephemeral');
    assert.match(notices[0].text, /superseded by a newer card/);
    const route = read('src/routes/slack.js');
    const actions = route.slice(route.indexOf("router.post('/slack/actions'"));
    assert.ok(actions.indexOf('noticeIfClosed') < actions.indexOf("action.action_id === 'reject_reply'"));
    assert.doesNotMatch(actions, /startsWith\('approve_reply'\)/);
  });
});

describe('Reject makes no Smartlead or HeyReach category or status call', { concurrency: 1 }, () => {
  const orig = {};
  const categoryCalls = [];
  const httpCalls = [];

  beforeEach(() => {
    orig.query = db.query;
    orig.update = slack.updateSentConfirmationCard;
    orig.fetch = global.fetch;
    for (const name of ['markLeadNotInterested', 'updateLeadCategory', 'fetchLeadCategories', 'sendReply']) {
      orig[name] = smartlead[name];
      smartlead[name] = async () => {
        categoryCalls.push(`smartlead.${name}`);
        throw new Error(`unexpected smartlead.${name}`);
      };
    }
    for (const name of ['sendMessage', 'verifyCampaignAccess']) {
      orig[name] = heyreach[name];
      heyreach[name] = async () => {
        categoryCalls.push(`heyreach.${name}`);
        throw new Error(`unexpected heyreach.${name}`);
      };
    }
    global.fetch = async (url) => {
      httpCalls.push(String(url));
      throw new Error(`unexpected fetch ${url}`);
    };
    categoryCalls.length = 0;
    httpCalls.length = 0;
  });

  afterEach(() => {
    db.query = orig.query;
    slack.updateSentConfirmationCard = orig.update;
    global.fetch = orig.fetch;
    for (const name of ['markLeadNotInterested', 'updateLeadCategory', 'fetchLeadCategories', 'sendReply']) {
      smartlead[name] = orig[name];
    }
    for (const name of ['sendMessage', 'verifyCampaignAccess']) {
      heyreach[name] = orig[name];
    }
  });

  async function rejectOne(platform) {
    const paints = [];
    const sqls = [];
    const reply = {
      id: OLDER,
      client_id: CLIENT_ID,
      platform,
      campaign_id: 'camp-1',
      campaign_name: 'Camp',
      lead_id: 'lead-1',
      lead_email: 'lead@example.test',
      lead_name: 'Lead',
      classification: 'INTERESTED',
      inbound_message: 'yes',
      status: 'pending',
      slack_channel_id: 'C-ROW',
      slack_message_ts: OLDER_TS,
      thread_context: platform === 'heyreach' ? { heyreach: { campaignName: 'Camp' }, messages: [] } : { history: [] },
    };
    db.query = async (sql, params) => {
      sqls.push(String(sql));
      if (/SELECT \* FROM pending_replies WHERE id/.test(sql) && /pending', 'flagged'/.test(sql)) {
        return { rows: [reply] };
      }
      if (/SET status = 'rejected'/.test(sql)) {
        assert.equal(params[0], OLDER);
        return { rows: [{ ...reply, status: 'rejected' }], rowCount: 1 };
      }
      if (/FROM clients WHERE id/.test(sql)) {
        return { rows: [{ id: CLIENT_ID, slack_bot_token: 'xoxb-test', slack_channel_id: 'C-CLIENT', smartlead_api_key: 'sl-key', heyreach_api_key: 'hr-key' }] };
      }
      if (/UPDATE outbound_follow_ups/.test(sql)) return { rowCount: 0 };
      throw new Error(`unexpected sql: ${sql}`);
    };
    slack.updateSentConfirmationCard = async (token, channel, ts, payload) => {
      paints.push({ token, channel, ts, payload });
      return { ok: true };
    };
    await slackRouter.cardHelpers.handleReject(OLDER, {
      user: { id: 'U1' },
      channel: { id: 'C-STALE' },
      message: { ts: '111.222', blocks: [] },
      response_url: 'https://hooks.slack.test/should-not-post',
    });
    return { paints, sqls };
  }

  for (const platform of ['smartlead', 'heyreach']) {
    it(`closes the ${platform} card on the stored message and leaves the lead alone`, async () => {
      const { paints, sqls } = await rejectOne(platform);
      assert.deepEqual(categoryCalls, []);
      assert.deepEqual(httpCalls, []);
      assert.equal(paints.length, 1);
      assert.equal(paints[0].channel, 'C-ROW');
      assert.equal(paints[0].ts, OLDER_TS);
      assert.notEqual(paints[0].ts, '111.222');
      assert.notEqual(paints[0].channel, 'C-STALE');
      assert.equal(paints[0].payload.actionKind, 'rejected');
      assert.ok(sqls.some((sql) => /status = 'rejected'/.test(sql)));
      assert.ok(sqls.every((sql) => !/NOT_INTERESTED|category|heyreach/i.test(sql)));
      const joined = sqls.join('\n');
      assert.doesNotMatch(joined, /classification = 'NOT_INTERESTED'/);
    });
  }

  it('the reject function source has no category or status call', () => {
    const src = read('src/routes/slack.js');
    const fn = src.slice(src.indexOf('async function handleReject'), src.indexOf('async function handleDisqualify'));
    assert.doesNotMatch(fn, /markLeadNotInterested|updateLeadCategory|fetch-categories|\/category/);
    assert.doesNotMatch(fn, /heyreach\.|sendMessage|updateCampaignStatus|pauseLead|resumeLead/);
    assert.match(fn, /status = 'rejected'/);
    assert.match(fn, /cancelPendingForThread/);
    assert.doesNotMatch(fn.slice(0, fn.indexOf("status = 'rejected'")), /cancelPendingForThread/);
  });
});

describe('failed sends retry once and do not double-send', () => {
  it('a failed confirmation keeps the body and puts Retry last', () => {
    const blocks = slack.buildSentConfirmationBlocks({
      replyId: OLDER,
      leadName: 'Lead',
      leadEmail: 'lead@example.test',
      platform: 'smartlead',
      classification: 'INTERESTED',
      inboundMessage: 'yes, send times',
      sentReply: 'Thursday works.',
      actionKind: 'failed',
      extraFooter: 'timeout',
    });
    assert.equal(blocks[0].text.text, '⚠️ Send failed');
    assert.match(JSON.stringify(blocks), /yes, send times/);
    const last = blocks[blocks.length - 1];
    assert.equal(last.type, 'actions');
    assert.equal(last.elements.length, 1);
    assert.equal(last.elements[0].action_id, 'retry_send');
    assert.equal(last.elements[0].value, OLDER);
    assert.equal(blocks.filter((b) => b.type === 'actions').length, 1);
  });

  it('the sweeper does not send again for a claimed or already-sent row', async () => {
    const now = Date.now();
    const rows = [
      {
        id: 'sent-already', status: 'approved', updated_at: new Date(now - 10 * 60 * 1000).toISOString(),
        client_id: CLIENT_ID, platform: 'smartlead', draft_reply: 'Hello', sent_reply: 'Hello',
        slack_channel_id: 'C-ROW', slack_message_ts: OLDER_TS,
      },
      {
        id: 'stuck-sending', status: 'sending', updated_at: new Date(now - 20 * 60 * 1000).toISOString(),
        client_id: CLIENT_ID, platform: 'heyreach', draft_reply: 'Hello again',
        slack_channel_id: 'C-ROW', slack_message_ts: NEWER_TS,
      },
      {
        id: 'stuck-approved', status: 'approved', updated_at: new Date(now - 5 * 60 * 1000).toISOString(),
        client_id: CLIENT_ID, platform: 'smartlead', draft_reply: 'First try',
        slack_channel_id: 'C-ROW', slack_message_ts: '1793313900.000001',
      },
    ];
    const sends = [];
    const query = async (sql, params) => {
      if (/SELECT \*/.test(sql) && /status IN \('approved', 'sending'\)/.test(sql)) {
        return { rows: rows.filter((r) => r.status === 'approved' || r.status === 'sending') };
      }
      if (/FROM clients/.test(sql)) {
        return { rows: [{ id: params[0], slack_bot_token: 'xoxb-test', slack_channel_id: 'C-CLIENT' }] };
      }
      if (/SET status = 'sent'/.test(sql)) {
        const row = rows.find((r) => r.id === params[0]);
        if (!row || (row.status !== 'approved' && row.status !== 'sending')) return { rowCount: 0 };
        row.status = 'sent';
        row.sent_reply = row.sent_reply || params[1];
        return { rowCount: 1 };
      }
      if (/SET status = 'failed'/.test(sql)) {
        const row = rows.find((r) => r.id === params[0]);
        if (!row || (row.status !== 'approved' && row.status !== 'sending')) return { rowCount: 0 };
        row.status = 'failed';
        row.send_error = params[1];
        return { rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    };
    const deps = {
      query,
      now,
      alreadySent: async (row) => row.id === 'sent-already',
      retrySend: async (row) => {
        sends.push(row.id);
        return { ok: true };
      },
      isInFlight: () => false,
      updateCard: async () => {},
      cardContext: async () => ({ campaignDisplay: 'Camp' }),
    };
    const first = await sweepStuckSends(deps);
    assert.equal(first.markedSent, 1);
    assert.equal(first.failed, 1);
    assert.equal(first.retried, 1);
    assert.deepEqual(sends, ['stuck-approved']);
    assert.equal(rows.find((r) => r.id === 'stuck-sending').status, 'failed');
    assert.match(rows.find((r) => r.id === 'stuck-sending').send_error, /Nothing was sent again/);

    const second = await sweepStuckSends(deps);
    assert.equal(second.retried, 0);
    assert.equal(second.failed, 0);
    assert.equal(second.markedSent, 0);
    assert.deepEqual(sends, ['stuck-approved']);
  });

  it('an in-flight send is left alone, and a drain waits for it', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    trackSend('inflight-row', pending);
    const result = await sweepStuckSends({
      now: Date.now(),
      query: async () => ({
        rows: [{
          id: 'inflight-row', status: 'sending',
          updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        }],
      }),
      retrySend: async () => { throw new Error('must not retry an in-flight send'); },
      alreadySent: async () => { throw new Error('must not check an in-flight send'); },
    });
    assert.equal(result.skipped, 1);
    assert.equal(result.retried, 0);
    assert.equal(isSendInFlight('inflight-row'), true);
    const draining = drainInFlightSends(1000);
    release({ ok: true });
    const drained = await draining;
    assert.equal(drained.timedOut, false);
    assert.ok(drained.drained >= 1);
    assert.equal(isSendInFlight('inflight-row'), false);
    const src = read('src/index.js');
    assert.match(src, /SIGTERM/);
    assert.match(src, /drainInFlightSends\(25000\)/);
    assert.match(read('src/cron.js'), /sweepStuckSends/);
  });
});

describe('card payload lives in the database', () => {
  it('a cache miss reloads card_payload and does not bump updated_at', async () => {
    const id = 'dddddddd-0000-4000-8000-000000000099';
    const stored = new Map();
    const fakeDb = {
      query: async (sql, params) => {
        if (/SET card_payload/.test(sql)) {
          assert.doesNotMatch(sql, /updated_at/);
          stored.set(params[1], JSON.parse(params[0]));
          return { rowCount: 1 };
        }
        if (/SELECT card_payload/.test(sql)) {
          const payload = stored.get(params[0]);
          return { rows: payload ? [{ card_payload: payload }] : [] };
        }
        throw new Error(sql);
      },
    };
    rememberCard(id, { draft: 'Hi there', leadName: 'Lead', platform: 'smartlead' }, fakeDb);
    forgetCardMemory(id);
    const loaded = await loadLatestCard(id, fakeDb);
    assert.equal(loaded.draft, 'Hi there');
    assert.equal(loaded.leadName, 'Lead');
  });
});

describe('HeyReach Approve only when a send can succeed', () => {
  const linkedin = 'https://www.linkedin.com/in/example-person';
  const base = {
    leadName: 'Lead',
    platform: 'heyreach',
    classification: 'INTERESTED',
    draft: 'Happy to connect.',
    inboundMessage: 'sure',
    linkedinReplyUrl: linkedin,
    conversationId: 'conv-1',
    linkedInAccountId: 42,
    hasHeyreachApiKey: true,
  };

  function buttons(card) {
    const { blocks } = slack.buildDraftApprovalCard(card);
    assert.equal(blocks[blocks.length - 1].type, 'actions', 'buttons stay at the bottom');
    return actionIds(blocks);
  }

  it('hides Approve for a derived id, a missing id, or a missing API key', () => {
    assert.equal(heyreachCanApprove({
      replyId: 'hr-derived:thread',
      leadId: 'hr-derived:thread',
      conversationId: 'conv-1',
      linkedInAccountId: 42,
      hasApiKey: true,
    }), false);
    assert.equal(heyreachCanApprove({
      replyId: 'real-1', leadId: 'lead-1', conversationId: '', linkedInAccountId: 42, hasApiKey: true,
    }), false);
    assert.equal(heyreachCanApprove({
      replyId: 'real-1', leadId: 'lead-1', conversationId: 'conv-1', linkedInAccountId: 42, hasApiKey: false,
    }), false);

    for (const card of [
      { ...base, replyId: 'hr-derived:thread', leadId: 'hr-derived:thread' },
      { ...base, replyId: 'real-1', leadId: 'lead-1', conversationId: null },
      { ...base, replyId: 'real-1', leadId: 'lead-1', hasHeyreachApiKey: false },
    ]) {
      const ids = buttons(card);
      assert.deepEqual(ids.filter((id) => id !== 'reply_on_linkedin'), ['dq_prospect', 'meeting_booked']);
      assert.ok(ids.includes('reply_on_linkedin'));
      assert.ok(!ids.includes('approve_reply'));
      assert.ok(!ids.includes('reject_reply'));
    }
  });

  it('shows Approve when the ids and the key are present, and keeps a derived row limited', () => {
    const full = buttons({ ...base, replyId: 'real-1', leadId: 'lead-1' });
    assert.ok(full.includes('approve_reply'));
    assert.ok(!full.includes('reply_on_linkedin'));
    const stillDerived = buttons({
      ...base,
      replyId: 'hr-derived:later',
      leadId: 'hr-derived:later',
      heyreachCanSend: false,
    });
    assert.ok(!stillDerived.includes('approve_reply'));
  });

  it('alert cards get the LinkedIn link under the other buttons', () => {
    const { blocks } = slack.buildAlertCard({
      replyId: 'real-1',
      leadName: 'Lead',
      platform: 'heyreach',
      classification: 'OTHER',
      inboundMessage: 'not now',
      linkedinReplyUrl: linkedin,
    });
    assert.equal(blocks[blocks.length - 1].type, 'actions');
    const ids = actionIds(blocks);
    assert.deepEqual(ids, ['dq_prospect', 'meeting_booked', 'reply_on_linkedin']);
    const link = blocks[blocks.length - 1].elements.find((el) => el.action_id === 'reply_on_linkedin');
    assert.equal(link.url, linkedin);
    assert.ok(!ids.includes('approve_reply'));
  });

  it('resolves missing ids before the card is posted and never returns the API key', async () => {
    const writes = [];
    const secret = 'hr-secret-should-not-leak';
    const replyId = 'eeeeeeee-0000-4000-8000-000000000021';
    const dbClient = {
      query: async (sql, params) => {
        if (/SELECT pr.id/.test(sql)) {
          return {
            rows: [{
              id: replyId,
              lead_id: 'lead-9',
              lead_name: 'Lead',
              linkedin_url: null,
              thread_context: {},
              client_id: CLIENT_ID,
              heyreach_api_key: secret,
            }],
          };
        }
        if (/thread_context/.test(sql)) {
          writes.push(params);
          assert.equal(JSON.stringify(params).includes(secret), false);
          return { rowCount: 1 };
        }
        throw new Error(sql);
      },
    };
    const result = await prepareHeyreachDraftCard({
      replyId,
      card: { leadLinkedinUrl: linkedin },
      dbClient,
      lookupSibling: async () => null,
      findConversation: async (key) => {
        assert.equal(key, secret);
        return { id: 'conv-9', linkedInAccountId: 77, profileUrl: linkedin };
      },
    });
    assert.equal(result.canSend, true);
    assert.equal(result.conversationId, 'conv-9');
    assert.equal(result.linkedInAccountId, 77);
    assert.equal(result.hasApiKey, true);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'heyreach_api_key'), false);
    assert.equal(writes.length, 1);
    const stored = JSON.parse(writes[0][0]);
    assert.equal(stored.heyreach.conversationId, 'conv-9');
    assert.equal(stored.heyreach.linkedinAccountId, 77);
  });
});
