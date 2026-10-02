const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPortalSecret,
  parseClientAction,
  applyClientAction,
} = require('../src/services/client-claimed');
const { sendReplyToPlatform } = require('../src/services/reply-send');
const clientClaimed = require('../src/services/client-claimed');

function fakeReq(headerValue) {
  return {
    get: (name) => (String(name).toLowerCase() === 'x-portal-secret' ? headerValue : ''),
    headers: { 'x-portal-secret': headerValue },
  };
}

function memoryDeps() {
  const claims = new Map();
  const cancelled = [];
  const slack = [];
  const notes = [];
  return {
    claims,
    cancelled,
    slack,
    notes,
    getClaim: async (email, camp) => claims.get(`${email}|${camp}`) || null,
    upsertClaim: async (row) => {
      const key = `${row.leadEmail}|${row.campaignId}`;
      const prev = claims.get(key) || {};
      claims.set(key, {
        lead_email: row.leadEmail,
        campaign_id: row.campaignId,
        claimed: !!row.claimed,
        status: row.status,
        last_note: row.lastNote != null ? row.lastNote : prev.last_note,
        client_id: row.clientId,
      });
    },
    cancelWork: async ({ leadEmail, campaignId }) => {
      cancelled.push({ leadEmail, campaignId });
      return { followUps: 1, drafts: 1 };
    },
    findClient: async () => ({
      id: 'c1',
      name: 'Acme',
      slack_bot_token: 'xoxb-test',
      slack_channel_id: 'C123',
    }),
    leadName: async () => 'Pat Lefler',
    attachNoteToDrafts: async ({ note }) => {
      notes.push(note);
      return [{ id: 'r1', slack_message_ts: '111.222' }];
    },
    notifyCayden: async (_client, text) => { slack.push({ text }); },
    postDraftThread: async (_t, _c, text) => { slack.push({ thread: text }); },
  };
}

describe('POST /client-action secret', () => {
  it('rejects when PORTAL_WEBHOOK_SECRET is unset', () => {
    const prev = process.env.PORTAL_WEBHOOK_SECRET;
    delete process.env.PORTAL_WEBHOOK_SECRET;
    try {
      const r = assertPortalSecret(fakeReq('anything'));
      assert.equal(r.ok, false);
      assert.equal(r.status, 503);
    } finally {
      if (prev == null) delete process.env.PORTAL_WEBHOOK_SECRET;
      else process.env.PORTAL_WEBHOOK_SECRET = prev;
    }
  });

  it('rejects a wrong x-portal-secret', () => {
    const prev = process.env.PORTAL_WEBHOOK_SECRET;
    process.env.PORTAL_WEBHOOK_SECRET = 'expected-secret';
    try {
      const r = assertPortalSecret(fakeReq('wrong-secret'));
      assert.equal(r.ok, false);
      assert.equal(r.status, 401);
    } finally {
      if (prev == null) delete process.env.PORTAL_WEBHOOK_SECRET;
      else process.env.PORTAL_WEBHOOK_SECRET = prev;
    }
  });

  it('accepts a matching x-portal-secret', () => {
    const prev = process.env.PORTAL_WEBHOOK_SECRET;
    process.env.PORTAL_WEBHOOK_SECRET = 'expected-secret';
    try {
      const r = assertPortalSecret(fakeReq('expected-secret'));
      assert.equal(r.ok, true);
    } finally {
      if (prev == null) delete process.env.PORTAL_WEBHOOK_SECRET;
      else process.env.PORTAL_WEBHOOK_SECRET = prev;
    }
  });
});

describe('client-action idempotency', () => {
  it('a second identical claim changes nothing', async () => {
    const deps = memoryDeps();
    const action = parseClientAction({
      email: 'Pat@Example.com',
      campaign_id: '4005226',
      status: 'client_has_it',
    });
    assert.equal(action.leadEmail, 'pat@example.com');

    const first = await applyClientAction(action, deps);
    assert.equal(first.unchanged, false);
    assert.equal(deps.cancelled.length, 1);
    assert.equal(deps.slack.length, 1);

    const second = await applyClientAction(action, deps);
    assert.equal(second.unchanged, true);
    assert.equal(deps.cancelled.length, 1);
    assert.equal(deps.slack.length, 1);
  });

  it('open twice after a claim only notifies once', async () => {
    const deps = memoryDeps();
    await applyClientAction(parseClientAction({
      email: 'a@b.com', campaign_id: '9', status: 'client_has_it',
    }), deps);
    const firstOpen = await applyClientAction(parseClientAction({
      email: 'a@b.com', campaign_id: '9', status: 'open',
    }), deps);
    assert.equal(firstOpen.unchanged, false);
    const slackAfterOpen = deps.slack.length;
    const secondOpen = await applyClientAction(parseClientAction({
      email: 'a@b.com', campaign_id: '9', status: 'open',
    }), deps);
    assert.equal(secondOpen.unchanged, true);
    assert.equal(deps.slack.length, slackAfterOpen);
  });

  it('the same note twice is a no-op', async () => {
    const deps = memoryDeps();
    const note = parseClientAction({
      email: 'a@b.com', campaign_id: '9', type: 'note', note: 'Call him tomorrow',
    });
    const first = await applyClientAction(note, deps);
    assert.equal(first.unchanged, false);
    assert.equal(deps.notes.length, 1);
    const second = await applyClientAction(note, deps);
    assert.equal(second.unchanged, true);
    assert.equal(deps.notes.length, 1);
  });
});

describe('send / follow-up guard', () => {
  it('skips an approved send when the lead is claimed', async () => {
    const origCheck = clientClaimed.assertNotClaimedOrThrow;
    let cancelled = false;
    clientClaimed.assertNotClaimedOrThrow = async () => {
      cancelled = true;
      const err = new Error('client_claimed');
      err.code = 'client_claimed';
      throw err;
    };
    try {
      await assert.rejects(
        () => sendReplyToPlatform(
          { smartlead_api_key: 'k' },
          { id: 'r1', platform: 'smartlead', lead_email: 'a@b.com', campaign_id: '9', lead_id: '1' },
          'Hey',
        ),
        (err) => err.code === 'client_claimed',
      );
      assert.equal(cancelled, true);
    } finally {
      clientClaimed.assertNotClaimedOrThrow = origCheck;
    }
  });

  it('skips a scheduled follow-up when the lead is claimed', async () => {
    const fs = require('fs');
    const path = require('path');
    const runner = fs.readFileSync(path.join(__dirname, '../src/services/follow-up-runner.js'), 'utf8');
    const claimIdx = runner.indexOf('isLeadClaimed');
    const postIdx = runner.indexOf('await postFollowUpCard');
    assert.ok(claimIdx > 0, 'runner must check isLeadClaimed');
    assert.ok(postIdx > claimIdx, 'claimed check must run before posting the follow-up card');
    assert.match(runner, /skip_reason = 'client_claimed'|skipped', 'client_claimed'/);

    const deps = memoryDeps();
    await applyClientAction(parseClientAction({
      email: 'claimed@x.com', campaign_id: '99', status: 'client_has_it',
    }), deps);
    const row = await deps.getClaim('claimed@x.com', '99');
    assert.equal(row.claimed, true);
    assert.equal(deps.cancelled.length, 1);
    assert.equal(deps.cancelled[0].campaignId, '99');
  });
});
