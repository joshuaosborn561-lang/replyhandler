'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveSignOffName, applySignOff, firstNameFromMailbox, isGabeCallsCampaign,
} = require('../src/utils/draft-sign-off');
const { DEFAULT_ANTHROPIC_MODEL, anthropicModel } = require('../src/services/anthropic-model');

const history = (from, extra = {}) => ({
  history: [
    { type: 'SENT', from, to: 'lead@acme.com', email_body: 'hi', ...extra },
    { type: 'REPLY', from: 'lead@acme.com', to: from, email_body: 'sure' },
  ],
});

test('signs as the sending inbox person (from_name)', () => {
  const name = resolveSignOffName({
    threadContext: history('al.k@vectorenergy.co', { from_name: 'Al Kowalski' }),
    leadEmail: 'lead@acme.com',
  });
  assert.equal(name, 'Al');
});

test('falls back to email local part when no from_name', () => {
  assert.equal(resolveSignOffName({
    threadContext: history('josh.osborn@gosalesglider.com'), leadEmail: 'lead@acme.com',
  }), 'Josh');
  assert.equal(resolveSignOffName({
    threadContext: history('"Cayden Ross" <cayden@sg.com>'), leadEmail: 'lead@acme.com',
  }), 'Cayden');
});

test('Gabe Calls campaigns always sign as Gabe', () => {
  assert.equal(isGabeCallsCampaign({ campaignId: 4085159 }), true);
  assert.equal(resolveSignOffName({
    campaignName: 'Gabe Calls | New Client',
    threadContext: history('josh@gosalesglider.com'),
  }), 'Gabe');
});

test('generic inbox falls back to voice prompt name, else none', () => {
  assert.equal(firstNameFromMailbox({ fromEmail: 'info@x.com' }), null);
  assert.equal(resolveSignOffName({
    threadContext: history('info@x.com'), voicePrompt: 'Sign off as Tyler.',
  }), 'Tyler');
  assert.equal(resolveSignOffName({ threadContext: history('info@x.com') }), null);
});

test('never uses the lead address as the sender', () => {
  const ctx = { history: [{ type: 'SENT', from: 'lead@acme.com' }] };
  assert.equal(resolveSignOffName({ threadContext: ctx, leadEmail: 'lead@acme.com' }), null);
});

test('applySignOff replaces an existing name line and is a no-op without a name', () => {
  assert.equal(applySignOff('Hey Sam, Tuesday works.\n\nJosh', 'Al'), 'Hey Sam, Tuesday works.\n\nAl');
  assert.equal(applySignOff('Hey Sam.', null), 'Hey Sam.');
});

test('Sonnet is the default reply model', () => {
  assert.match(DEFAULT_ANTHROPIC_MODEL, /^claude-sonnet-/);
  assert.equal(anthropicModel({}), DEFAULT_ANTHROPIC_MODEL);
  assert.equal(anthropicModel({ ANTHROPIC_REPLY_MODEL: 'x' }), 'x');
});

test('Claude classify fallback parses one word and returns null on error', async () => {
  const { classifyOnlyClaude } = require('../src/services/classifier');
  const ok = await classifyOnlyClaude([], 'yes tell me more', {
    fetch: async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'INTERESTED' }] }) }),
  });
  assert.equal(ok, 'INTERESTED');
  const bad = await classifyOnlyClaude([], 'x', { fetch: async () => ({ ok: false, status: 500 }) });
  assert.equal(bad, null);
});
