'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { geminiModel, DEFAULT_GEMINI_MODEL } = require('../src/services/gemini-model');

test('GEMINI_MODEL defaults to gemini-3.8-flash', () => {
  assert.strictEqual(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash');
  assert.strictEqual(geminiModel({}), 'gemini-3.8-flash');
  assert.strictEqual(geminiModel({ GEMINI_MODEL: '  ' }), 'gemini-3.8-flash');
});

test('GEMINI_MODEL env overrides the default', () => {
  assert.strictEqual(geminiModel({ GEMINI_MODEL: 'gemini-x' }), 'gemini-x');
});
