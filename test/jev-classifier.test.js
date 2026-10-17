const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseJevResponse,
  buildJevRequest,
  assertJevConfigured,
  isJevConfigured,
  isGeminiFallbackEnabled,
  missingJevEnv,
  JEV_CATEGORIES,
  JEV_MODEL_DEFAULT,
} = require('../src/services/jev-classifier');
const { classifyReply, CLASSIFICATIONS } = require('../src/services/classifier');

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

test('Jev categories cover the replyhandler enum', () => {
  for (const c of JEV_CATEGORIES) {
    assert.ok(CLASSIFICATIONS.includes(c), `${c} missing from classifier CLASSIFICATIONS`);
  }
});

test('fail-fast preflight requires JEV_API_URL and JEV_API_KEY', async () => {
  await withEnv({ JEV_API_URL: undefined, JEV_API_KEY: undefined }, () => {
    assert.equal(isJevConfigured(), false);
    assert.deepEqual(missingJevEnv().sort(), ['JEV_API_KEY', 'JEV_API_URL']);
    assert.throws(() => assertJevConfigured(), /missing required env JEV_API_URL, JEV_API_KEY/);
  });
  await withEnv({ JEV_API_URL: 'https://example.test/decisions', JEV_API_KEY: 'k' }, () => {
    assert.equal(isJevConfigured(), true);
    assert.doesNotThrow(() => assertJevConfigured());
  });
});

test('parseJevResponse reads category choice and pitch noul', () => {
  const parsed = parseJevResponse({
    answers: {
      category: { choice: 'QUESTION', probabilities: { QUESTION: 0.9 } },
      pitch_to_us: { noul: 0.53 },
    },
    usage: { cost: 0.0001 },
  });
  assert.equal(parsed.classification, 'QUESTION');
  assert.equal(parsed.pitchToUsProb, 0.53);
  assert.equal(parsed.source, 'jev');
});

test('parseJevResponse throws on an empty payload', () => {
  assert.throws(() => parseJevResponse({}), /missing answers/);
  assert.throws(() => parseJevResponse({ answers: { category: {} } }), /missing category.choice/);
});

test('buildJevRequest uses env model and never hardcodes the URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/jev-classifier.js'), 'utf8');
  assert.equal(src.includes('openrouter.ai'), false);
  assert.match(src, /JEV_API_URL/);
  assert.match(src, /JEV_API_KEY/);
  assert.match(src, /assertJevConfigured/);
  return withEnv({ JEV_MODEL: undefined }, () => {
    const body = buildJevRequest({
      threadContext: [{ role: 'us', message: 'Want the tickets?' }],
      inboundMessage: 'What game?',
    });
    assert.equal(body.model, JEV_MODEL_DEFAULT);
    assert.equal(body.state.latest_prospect_reply, 'What game?');
    assert.match(body.state.last_outbound_from_us, /tickets/i);
    assert.equal(body.questions.category.type, 'choice');
    assert.equal(body.questions.pitch_to_us.type, 'noul');
    assert.match(body.questions.category.instructions, /What sport\? What game\?/);
    assert.match(body.questions.category.instructions, /they may have written first/);
    assert.match(body.questions.pitch_to_us.instructions, /resurfacing this thread/i);
    assert.match(body.questions.pitch_to_us.instructions, /writing those by hand/i);
  });
});

test('classifyReply uses Jev and keeps pitch_to_us_prob', async () => {
  const result = await classifyReply('thread', 'Sure, tell me more.', {
    classifyWithJev: async () => ({ classification: 'INTERESTED', pitchToUsProb: 0.12, source: 'jev' }),
    classifyWithGemini: async () => {
      throw new Error('gemini should not run');
    },
  });
  assert.equal(result.classification, 'INTERESTED');
  assert.equal(result.pitchToUsProb, 0.12);
  assert.equal(result.source, 'jev');
});

test('classifyReply falls back to Gemini when Jev fails and the flag is on', async () => {
  await withEnv({ CLASSIFIER_FALLBACK_GEMINI: undefined }, async () => {
    assert.equal(isGeminiFallbackEnabled(), true);
    let geminiCalled = false;
    const result = await classifyReply('thread', 'hello', {
      classifyWithJev: async () => {
        throw new Error('jev 503');
      },
      classifyWithGemini: async () => {
        geminiCalled = true;
        return { classification: 'QUESTION', pitchToUsProb: null, source: 'gemini_fallback' };
      },
    });
    assert.equal(geminiCalled, true);
    assert.equal(result.classification, 'QUESTION');
    assert.equal(result.source, 'gemini_fallback');
    assert.equal(result.pitchToUsProb, null);
  });
});

test('classifyReply does not call Gemini when CLASSIFIER_FALLBACK_GEMINI is off', async () => {
  await withEnv({ CLASSIFIER_FALLBACK_GEMINI: '0' }, async () => {
    assert.equal(isGeminiFallbackEnabled(), false);
    let geminiCalled = false;
    const result = await classifyReply('thread', 'hello', {
      classifyWithJev: async () => {
        throw new Error('jev timeout');
      },
      classifyWithGemini: async () => {
        geminiCalled = true;
        return { classification: 'QUESTION', pitchToUsProb: null, source: 'gemini_fallback' };
      },
    });
    assert.equal(geminiCalled, false);
    assert.equal(result.classification, 'OTHER');
    assert.equal(result.source, 'jev_failed');
  });
});
