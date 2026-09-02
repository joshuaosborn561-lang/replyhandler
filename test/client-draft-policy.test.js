const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  emailTld,
  isParlayClient,
  draftSkipReason,
  applyClientDraftPolicy,
} = require('../src/utils/client-draft-policy');

const PARLAY = {
  id: '9760132c-1dd3-4e97-8f29-c5d4d01f5054',
  name: 'Parlay Tech',
};
const OTHER = { id: '00000000-0000-0000-0000-000000000001', name: 'SalesGlider' };

describe('client-draft-policy', () => {
  it('detects Parlay by id or name', () => {
    assert.ok(isParlayClient(PARLAY));
    assert.ok(isParlayClient({ name: 'Parlay Tech' }));
    assert.ok(!isParlayClient(OTHER));
  });

  it('reads the email TLD', () => {
    assert.equal(emailTld('bob@startup.io'), 'io');
    assert.equal(emailTld('a@foo.ai'), 'ai');
    assert.equal(emailTld('chris@capmri.com'), 'com');
    assert.equal(emailTld(''), null);
  });

  it('DQs Parlay .io and .ai from drafting', () => {
    assert.match(draftSkipReason(PARLAY, 'pat@vuerobotics.io'), /\.io/);
    assert.match(draftSkipReason(PARLAY, 'ceo@agent.ai'), /\.ai/);
    assert.equal(draftSkipReason(PARLAY, 'doug@parlaytech.com'), null);
    assert.equal(draftSkipReason(OTHER, 'pat@vuerobotics.io'), null);
  });

  it('forces alert_only and clears draft for Parlay .io', () => {
    const out = applyClientDraftPolicy(PARLAY, 'pat@vuerobotics.io', {
      classification: 'INTERESTED',
      draft: 'Hey Pat, Tuesday work?',
      reasoning: 'Sounded interested',
    });
    assert.equal(out.isDraft, false);
    assert.equal(out.status, 'alert_only');
    assert.equal(out.draft, null);
    assert.ok(out.skippedDraft);
    assert.match(out.reasoning, /Parlay DQ/);
  });

  it('leaves non-Parlay .io drafts alone', () => {
    const out = applyClientDraftPolicy(OTHER, 'pat@vuerobotics.io', {
      classification: 'INTERESTED',
      draft: 'Hey Pat',
      reasoning: 'ok',
    });
    assert.equal(out.isDraft, true);
    assert.equal(out.draft, 'Hey Pat');
    assert.equal(out.status, 'pending');
  });
});
