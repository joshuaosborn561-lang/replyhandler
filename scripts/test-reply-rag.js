#!/usr/bin/env node

const assert = require('assert');
const {
  JOSH_VOICE_STYLE_GUIDE,
  summarizeThread,
} = require('../src/services/claude-reply-draft');
const {
  l2Normalize,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
} = require('../src/services/reply-examples');

assert.ok(JOSH_VOICE_STYLE_GUIDE.startsWith("JOSH'S VOICE — RULES:"));
assert.ok(JOSH_VOICE_STYLE_GUIDE.includes('"Hey [Name], thanks for getting back to me"'));
assert.ok(JOSH_VOICE_STYLE_GUIDE.includes('Oh no, put my foot in my mouth already! Haha'));
assert.ok(JOSH_VOICE_STYLE_GUIDE.includes('Sign-off is just a first name'));

const thread = summarizeThread({
  history: [
    { type: 'SENT', email_body: '<p>Hey Tony</p>' },
    { type: 'REPLY', email_body: '<p>Sure, send the link.</p>' },
  ],
});
assert.ok(thread.includes('Josh: Hey Tony'));
assert.ok(thread.includes('Prospect: Sure, send the link.'));

const normalized = l2Normalize([3, 4]);
assert.ok(Math.abs(normalized[0] - 0.6) < 1e-9);
assert.ok(Math.abs(normalized[1] - 0.8) < 1e-9);
assert.strictEqual(EMBEDDING_DIMENSIONS, 768);
assert.strictEqual(EMBEDDING_MODEL, 'gemini-embedding-001');

console.log('ok — manual-reply retrieval + Claude prompt');
