const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  shouldUseAnthropicDrafts,
  isBulkDraftMode,
  DRAFT_CLASSIFICATIONS,
  assertDraftableClassification,
} = require('../src/services/classifier');

describe('Claude never runs on bulk / backfill', () => {
  it('bulk draftMode never enables Anthropic', () => {
    assert.equal(isBulkDraftMode('bulk'), true);
    assert.equal(isBulkDraftMode('realtime'), false);
    assert.equal(shouldUseAnthropicDrafts({ draftMode: 'bulk' }), false);
  });

  it('pollers and backfill scripts pass draftMode bulk', () => {
    const sl = fs.readFileSync(path.join(__dirname, '../src/services/smartlead-poller.js'), 'utf8');
    const hr = fs.readFileSync(path.join(__dirname, '../src/services/heyreach-poller.js'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../scripts/smartlead-positive-followups.js'), 'utf8');
    assert.match(sl, /draftMode:\s*'bulk'/);
    assert.match(hr, /draftMode:\s*'bulk'/);
    assert.match(script, /draftMode:\s*'bulk'/);
  });

  it('Claude generateClaudeReply rejects bulk mode', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/claude-reply-draft.js'),
      'utf8'
    );
    assert.match(src, /hard-disabled for bulk/);
  });

  it('only INTERESTED / MEETING_PROPOSED / QUESTION are draftable', () => {
    assert.deepEqual([...DRAFT_CLASSIFICATIONS].sort(), ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION'].sort());
    assert.equal(assertDraftableClassification('INTERESTED'), true);
    assert.equal(assertDraftableClassification('QUESTION'), true);
    assert.equal(assertDraftableClassification('MEETING_PROPOSED'), true);
    assert.equal(assertDraftableClassification('NOT_INTERESTED'), false);
    assert.equal(assertDraftableClassification('OOO'), false);
    assert.equal(assertDraftableClassification('OTHER'), false);
    assert.equal(assertDraftableClassification('OBJECTION'), false);
  });

  it('there is no env opt-in to re-enable Claude on bulk', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/classifier.js'), 'utf8');
    assert.doesNotMatch(src, /ANTHROPIC_BULK_DRAFTS_ENABLED/);
    assert.match(src, /intentionally no env opt-in/);
  });
});
