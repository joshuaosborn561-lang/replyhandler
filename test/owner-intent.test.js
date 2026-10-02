/**
 * Owner intent.
 *
 * Every assertion here is a product decision Josh made explicitly, not an
 * engineering judgement. They are separated from invariants.test.js on
 * purpose: those are safety rules anyone should keep, these are *his calls*.
 *
 * If one of these fails, the change is not a bug fix — it is a reversal of a
 * decision. Ask him before touching it. Several of these were reversed once
 * already during the conversation that produced them, so the current state is
 * the settled one, not the first draft.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Failure text for an owner decision.
 *
 * A red test here is not a bug report — it means someone is about to reverse a
 * call Josh made. Say so plainly, name the decision, and ask them to check with
 * him rather than leaving them to guess or delete the guard.
 */
function reversal(decision, detail) {
  return [
    '',
    'STOP — this reverses one of Josh\'s decisions.',
    '',
    `  Decision: ${decision}`,
    `  Problem:  ${detail}`,
    '',
    '  This is not a bug. Josh chose this deliberately — see DECISIONS.md for',
    '  the reasoning and the tradeoff he accepted. Several of these were already',
    '  reversed once before settling, so the current state is the considered one.',
    '',
    '  Check with Josh before changing it. Do not delete this guard to go green.',
    '',
  ].join('\n');
}

// ── Decision: AI reply channels are interested-only ───────────────────
// "i only want interested replies to come through there. no OOO and no
// not interested" — supersedes the older "NOT_INTERESTED reaches Slack".
test('Slack channels are interested-only — OOO and NOT_INTERESTED suppressed', () => {
  const {
    slackChannelSuppressionReason,
    SLACK_CHANNEL_CLASSIFICATIONS,
  } = require('../src/utils/slack-channel-policy');
  const { DRAFT_CLASSIFICATIONS } = require('../src/services/classifier');

  assert.ok(SLACK_CHANNEL_CLASSIFICATIONS.has('INTERESTED'));
  assert.ok(SLACK_CHANNEL_CLASSIFICATIONS.has('MEETING_PROPOSED'));
  assert.ok(SLACK_CHANNEL_CLASSIFICATIONS.has('QUESTION'));
  assert.strictEqual(
    slackChannelSuppressionReason({ classification: 'OOO', inboundMessage: 'out of office' }),
    'ooo',
    reversal('Slack channels are interested-only', 'OOO is posting again'),
  );
  assert.strictEqual(
    slackChannelSuppressionReason({ classification: 'NOT_INTERESTED', inboundMessage: 'not interested' }),
    'not_interested',
    reversal('Slack channels are interested-only', 'NOT_INTERESTED is posting again'),
  );
  assert.strictEqual(
    slackChannelSuppressionReason({ classification: 'INTERESTED', inboundMessage: 'Sure' }),
    null,
  );
  assert.ok(!DRAFT_CLASSIFICATIONS.includes('NOT_INTERESTED'),
    reversal('Slack channels are interested-only', 'NOT_INTERESTED is drafting again'));
  assert.ok(!DRAFT_CLASSIFICATIONS.includes('OOO'));
  assert.deepEqual([...DRAFT_CLASSIFICATIONS].sort(), ['INTERESTED', 'MEETING_PROPOSED', 'QUESTION'].sort());
});
