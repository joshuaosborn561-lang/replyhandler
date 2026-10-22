const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { classifyDuringOutage } = require('../src/utils/classifier-outage');
const { classifyReply } = require('../src/services/classifier');
const { isGeminiFallbackEnabled } = require('../src/services/jev-classifier');
const { slackChannelSuppressionReason } = require('../src/utils/slack-channel-policy');

const SALESGLIDER_THREAD = {
  history: [
    {
      type: 'SENT',
      email_body: 'I made a video documenting the entire process. Can I send it over?',
    },
    { type: 'REPLY', email_body: 'Can you send some info on what you do?' },
  ],
};

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function classifiersDown() {
  return {
    classifyWithJev: async () => {
      throw new Error('jev 401 {"error":{"message":"User not found.","code":401}}');
    },
    classifyWithGemini: async () => ({
      classification: 'OTHER',
      pitchToUsProb: null,
      source: 'gemini_failed',
      unavailable: true,
    }),
  };
}

test('outage heuristic drafts the SalesGlider replies that posted unclassified', () => {
  assert.equal(
    classifyDuringOutage(SALESGLIDER_THREAD, 'Can you send some info on what you do?'),
    'QUESTION',
  );
  assert.equal(
    classifyDuringOutage(SALESGLIDER_THREAD, 'Just the video'),
    'INTERESTED',
  );

  const linkedin = [
    { role: 'us', message: 'Curious how you think about outbound since 2019.' },
    { role: 'prospect', message: "That's an interesting take/thought. Feels accurate too even from my experience from 2019 to now." },
  ];
  assert.equal(
    classifyDuringOutage(linkedin, "That's an interesting take/thought. Feels accurate too even from my experience from 2019 to now."),
    'INTERESTED',
  );
  assert.equal(classifyDuringOutage(linkedin, 'I sit in the middle'), 'INTERESTED');

  for (const label of ['QUESTION', 'INTERESTED']) {
    assert.equal(
      slackChannelSuppressionReason({ classification: label, inboundMessage: 'hi' }),
      null,
    );
  }
});

test('outage heuristic still drops declines, OOO, and cold pitches', () => {
  assert.equal(
    classifyDuringOutage(SALESGLIDER_THREAD, 'Thanks, but I am not interested'),
    'NOT_INTERESTED',
  );
  assert.equal(classifyDuringOutage(SALESGLIDER_THREAD, 'no'), 'NOT_INTERESTED');
  assert.equal(
    classifyDuringOutage(SALESGLIDER_THREAD, 'I am currently out of the office until Monday'),
    'OOO',
  );
  const recruiter = 'Hi Joshua, I hope you are doing well! My name is Robert, and I am a Talent Acquisition Specialist. I would love to schedule a call.';
  assert.equal(classifyDuringOutage([], recruiter), null);
  assert.equal(classifyDuringOutage(SALESGLIDER_THREAD, ''), null);
});

test('classifyReply uses the heuristic only when Gemini is unavailable', async () => {
  await withEnv({ CLASSIFIER_FALLBACK_GEMINI: undefined }, async () => {
    assert.equal(isGeminiFallbackEnabled(), true);
    const rescued = await classifyReply(
      SALESGLIDER_THREAD,
      'Can you send some info on what you do?',
      classifiersDown(),
    );
    assert.equal(rescued.classification, 'QUESTION');
    assert.equal(rescued.source, 'outage_heuristic');
    assert.equal(rescued.unavailable, false);

    const video = await classifyReply(SALESGLIDER_THREAD, 'Just the video', classifiersDown());
    assert.equal(video.classification, 'INTERESTED');
    assert.equal(video.source, 'outage_heuristic');

    const modelOther = await classifyReply(
      SALESGLIDER_THREAD,
      'Can you send some info on what you do?',
      {
        classifyWithJev: async () => { throw new Error('jev 401'); },
        classifyWithGemini: async () => ({
          classification: 'OTHER',
          pitchToUsProb: null,
          source: 'gemini_fallback',
          unavailable: false,
        }),
      },
    );
    assert.equal(modelOther.classification, 'OTHER');
    assert.equal(modelOther.source, 'gemini_fallback');
  });
});

test('CLASSIFIER_FALLBACK_GEMINI off still does not invent a label', async () => {
  await withEnv({ CLASSIFIER_FALLBACK_GEMINI: '0' }, async () => {
    const result = await classifyReply(SALESGLIDER_THREAD, 'Just the video', {
      classifyWithJev: async () => { throw new Error('jev 401'); },
      classifyWithGemini: async () => {
        throw new Error('gemini should not run');
      },
    });
    assert.equal(result.classification, 'OTHER');
    assert.equal(result.source, 'jev_failed');
  });
});

test('Nutter LinkedIn replies use the same outage fallback', () => {
  const thread = [
    { role: 'us', message: 'Worth a look for your board?' },
  ];
  assert.equal(
    classifyDuringOutage(
      thread,
      'Understood. I do some board work but nothing in healthcare. Good luck with the search.',
    ),
    'NOT_INTERESTED',
  );
  assert.equal(
    slackChannelSuppressionReason({
      classification: 'NOT_INTERESTED',
      inboundMessage: 'Good luck with the search.',
    }),
    'not_interested',
  );
  assert.equal(
    classifyDuringOutage(thread, 'I see. thanks for reaching out. will speak internally to our board.'),
    'INTERESTED',
  );
  assert.equal(
    classifyDuringOutage(thread, 'I was with AITP board for a few years'),
    'INTERESTED',
  );
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/classifier-outage.js'), 'utf8');
  assert.doesNotMatch(src, /salesglider|clientId|client_id/i);
});

test('a short LinkedIn reply is drafted even when the thread omitted our send', () => {
  const onlyInbound = [{ role: 'prospect', message: 'I sit in the middle' }];
  assert.equal(classifyDuringOutage(onlyInbound, 'I sit in the middle'), 'INTERESTED');
});

test('Claude still drafts when the Gemini embedding lookup throws', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/claude-reply-draft.js'), 'utf8');
  const fn = src.slice(
    src.indexOf('async function generateClaudeReply'),
    src.indexOf('const FOLLOW_UP_RULES'),
  );
  assert.match(fn, /RAG match failed — drafting without examples/);
  assert.match(fn, /catch \(err\)/);
  const webhooks = fs.readFileSync(path.join(__dirname, '../src/routes/webhooks.js'), 'utf8');
  assert.match(webhooks, /withKnownOutbound\(threadContext, lastOutboundSl\)/);
  assert.match(webhooks, /withKnownOutbound\(threadContext, lastOutboundHr\)/);
});
