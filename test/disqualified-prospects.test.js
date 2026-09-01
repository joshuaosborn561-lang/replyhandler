const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('disqualified-prospects wiring', () => {
  it('exposes DQ on draft and alert Slack cards', () => {
    const slack = read('src/services/slack.js');
    const actionsIdx = slack.indexOf('function draftApprovalActionsBlock');
    const draftIdx = slack.indexOf('async function postDraftApproval');
    const alertIdx = slack.indexOf('async function postAlert');
    assert.ok(actionsIdx >= 0 && draftIdx > actionsIdx && alertIdx > draftIdx);
    const actionsBlock = slack.slice(actionsIdx, draftIdx);
    const draftBlock = slack.slice(draftIdx, alertIdx);
    const alertBlock = slack.slice(alertIdx, slack.indexOf('async function postError'));
    assert.match(actionsBlock, /dq_prospect/, 'draft cards share the DQ button via draftApprovalActionsBlock');
    assert.match(draftBlock, /draftApprovalActionsBlock/, 'postDraftApproval must attach the shared action row');
    assert.match(alertBlock, /dq_prospect/, 'alert-only cards still expose DQ');
  });

  it('persists DQ via migration and service', () => {
    assert.match(read('migrations/022_disqualified_prospects.sql'), /disqualified_prospects/);
    assert.match(read('src/services/disqualified-prospects.js'), /markDisqualified/);
    assert.match(read('src/services/disqualified-prospects.js'), /isDisqualified/);
  });

  it('thread key helper prefers heyreach conversation id', () => {
    const { threadKeys } = require('../src/services/disqualified-prospects');
    const keys = threadKeys({
      platform: 'heyreach',
      campaign_id: '1',
      lead_id: 'lead-9',
      lead_email: 'Pat@Example.IO',
      linkedin_url: 'https://linkedin.com/in/x',
      lead_name: 'Pat',
      thread_context: { heyreach: { conversationId: 'conv-1' } },
    });
    assert.equal(keys.conversationId, 'conv-1');
    assert.equal(keys.leadEmail, 'pat@example.io');
    assert.equal(keys.leadId, 'lead-9');
  });
});
