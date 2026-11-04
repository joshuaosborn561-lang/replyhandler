const test = require('node:test');
const assert = require('node:assert');
const { followUpSkipBlock } = require('../src/utils/human-card-skip');

const row = { slack_message_ts: '1793628003.308819' };

test('a follow-up card is not skipped unless a person clicks Reject on that card', () => {
  assert.equal(followUpSkipBlock(null, row), 'no_person');
  assert.equal(followUpSkipBlock({ user: { id: 'U1', is_bot: true }, type: 'block_actions' }, row), 'no_person');
  assert.equal(followUpSkipBlock({ type: 'view_submission', user: { id: 'U1' } }, row), 'not_a_click');
  assert.equal(
    followUpSkipBlock({
      type: 'block_actions',
      user: { id: 'U1' },
      message: { ts: '111.222' },
      actions: [{ action_ts: '1793628010.000000' }],
    }, row),
    'different_message',
  );
  assert.equal(
    followUpSkipBlock({
      type: 'block_actions',
      user: { id: 'U1' },
      message: { ts: row.slack_message_ts },
      actions: [{ action_ts: '1793628004.000000' }],
    }, row),
    'too_soon',
  );
  assert.equal(
    followUpSkipBlock({
      type: 'block_actions',
      user: { id: 'U1' },
      message: { ts: row.slack_message_ts },
      actions: [{ action_ts: '1793628006.000000' }],
    }, row),
    null,
  );
});
