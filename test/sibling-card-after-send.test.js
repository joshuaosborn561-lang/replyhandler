const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('after a successful send, open sibling cards are superseded', () => {
  const slack = read('src/routes/slack.js');
  assert.match(slack, /supersedeStaleOpenCardsAfterSend/);
  assert.match(slack, /supersedeOpenSiblingsAfterSend/);
  assert.ok(
    slack.indexOf('supersedeStaleOpenCardsAfterSend(client, sentReply)')
    < slack.indexOf("console.log('[Slack] Reply approved and sent'"),
    'supersede runs after approve send bookkeeping',
  );
});

test('Reject on a stale card supersede when the same lead already has a sent row', () => {
  const slack = read('src/routes/slack.js');
  assert.match(slack, /findSentSiblingForLead\(pending/);
  assert.match(slack, /supersedeWhenLeadAlreadySent/);
  assert.doesNotMatch(
    slack.slice(slack.indexOf('async function handleReject'), slack.indexOf('async function handleDisqualify')),
    /actionKind: 'rejected'[\s\S]*findSentSiblingForLead/,
    'sent-sibling check must run before painting rejected',
  );
});

test('findSentSiblingForLead matches sent rows for the same lead', async () => {
  const { findSentSiblingForLead } = require('../src/services/supersede-cards');
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (/status = 'sent'/.test(sql)) {
      return { rows: [{ id: 'sent-1', slack_message_ts: '1.2', slack_channel_id: 'C1' }] };
    }
    return { rows: [] };
  };
  const hit = await findSentSiblingForLead({
    id: 'open-1',
    client_id: 'c1',
    platform: 'smartlead',
    campaign_id: '4289735',
    lead_id: '48111',
    lead_email: 'rabbi@example.com',
  }, { query, exceptReplyId: 'open-1' });
  assert.equal(hit.id, 'sent-1');
  assert.ok(queries.some((q) => /status = 'sent'/.test(q.sql)));
});

test('Slack confirmation cards retry chat.update on rate limit', () => {
  const slack = read('src/services/slack.js');
  assert.match(slack, /chatUpdateWithRetry/);
  const fn = slack.slice(slack.indexOf('async function updateSentConfirmationCard'));
  assert.ok(fn.indexOf('chatUpdateWithRetry') < fn.indexOf('overflowBlocks'));
});
