/**
 * Repaint of an existing Slack card (chat.update only) must refresh the
 * manual-enroll label and a phone that appears in the prospect's own reply.
 * No database: the db module is stubbed before the service loads.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const replies = new Map();
const updates = [];
const db = {
  async query(sql, params) {
    updates.push(sql);
    if (/FROM clients WHERE id/.test(sql)) {
      return { rows: [{ name: 'Vector', slack_bot_token: 'xoxb-test', slack_channel_id: 'C1' }] };
    }
    if (/SELECT \* FROM pending_replies WHERE id/.test(sql)) {
      const row = replies.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/SELECT lead_phone, lead_phone_provider, inbound_message/.test(sql)) {
      const row = replies.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/SET lead_phone/.test(sql)) {
      const row = replies.get(params[1]);
      if (row && !row.lead_phone) {
        row.lead_phone = params[0];
        row.lead_phone_provider = params[2];
      }
      return { rows: [] };
    }
    if (/SET card_payload/.test(sql)) return { rows: [] };
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  },
};

const dbPath = path.join(__dirname, '../src/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
const svc = require('../src/services/card-status-admin');

function fakeSlack() {
  const calls = [];
  return {
    calls,
    slackApi: {
      updateDraftApprovalCard: async (...a) => { calls.push(a); },
      updateAlertCard: async (...a) => { calls.push(a); },
    },
  };
}

test('repaint replaces the stored manual-ghost label on the existing message', async () => {
  const id = '015619b7-c442-4eaa-a46e-45770b78fdb3';
  replies.set(id, {
    id, client_id: 'c1', status: 'pending', classification: 'FOLLOW_UP',
    campaign_id: 'manual-ghost', campaign_name: 'Manual ghosted meeting',
    inbound_message: 'Manual ghosted meeting (manual-ghost)',
    draft_reply: 'Draft', slack_message_ts: '1793628003.308819', slack_channel_id: 'C0BRRS8DV19',
  });
  const f = fakeSlack();
  const out = await svc.setCardStatus(id, { status: 'pending', repaintCard: true }, {
    ...f,
    loadCard: async () => ({
      replyId: id,
      draft: 'Draft',
      classification: 'FOLLOW_UP',
      campaignDisplay: 'Manual ghosted meeting (manual-ghost)',
      inboundMessage: 'Manual ghosted meeting (manual-ghost)',
    }),
  });
  assert.equal(out.body.cardRepainted, 'repainted');
  assert.equal(out.body.classification, 'FOLLOW_UP');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], 'C0BRRS8DV19');
  assert.equal(f.calls[0][2], '1793628003.308819');
  assert.equal(f.calls[0][3].campaignDisplay, 'Manual enroll (from call)');
  assert.equal(f.calls[0][3].inboundMessage, 'Manual enroll (from call)');
  assert.ok(!updates.some((sql) => /postMessage|INSERT INTO pending_replies/i.test(sql)));
});

test('repaint overlays a phone from the prospect reply and ignores quoted history', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  replies.set(id, {
    id, client_id: 'c1', status: 'pending', classification: 'INTERESTED',
    campaign_id: '4242297', draft_reply: 'Draft',
    slack_message_ts: '1793313695.519449', slack_channel_id: 'C0CC420V1TK',
    inbound_message: [
      'What is the cost per charger?',
      'cell: (951) 823-9296',
      'On Tue, Nov 3, 2026 Sam wrote:',
      'call 404-555-0177',
    ].join('\n'),
  });
  const f = fakeSlack();
  const out = await svc.setCardStatus(id, { status: 'pending', repaintCard: true }, {
    ...f,
    loadCard: async () => ({
      replyId: id,
      draft: 'Draft',
      inboundMessage: 'What is the cost per charger?',
      enrichmentReceipt: { phoneLookup: { outcome: 'not_run' } },
    }),
  });
  assert.equal(out.body.changed, false);
  assert.equal(out.body.cardRepainted, 'repainted');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0][3].leadPhone, /951/);
  assert.doesNotMatch(String(f.calls[0][3].leadPhone), /404/);
  assert.equal(f.calls[0][3].phoneProvider, 'reply_text');
  assert.match(replies.get(id).lead_phone, /951/);
  assert.equal(replies.get(id).lead_phone_provider, 'reply_text');
});
