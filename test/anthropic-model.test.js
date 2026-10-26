'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_ANTHROPIC_MODEL, anthropicModel } = require('../src/services/anthropic-model');

test('Sonnet is the default reply model', () => {
  assert.equal(DEFAULT_ANTHROPIC_MODEL, 'claude-sonnet-5-5');
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
