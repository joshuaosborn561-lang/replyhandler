const test = require('node:test');
const assert = require('node:assert');
const { pingCaller, _resetForTests } = require('../src/services/speed-to-lead');

function fakeSlack() {
  const posts = [];
  return { posts, postClientActionNotice: async (t, c, text, ts) => { posts.push({ text, ts }); } };
}
const base = { token: 't', channelId: 'C1', threadTs: '1.1', replyId: 'r1', classification: 'INTERESTED', leadName: 'Pat' };
const env = { SPEED_TO_LEAD_MENTION: '<@U1>' };

test('off when SPEED_TO_LEAD_MENTION unset', async () => {
  _resetForTests(); const s = fakeSlack();
  assert.equal(await pingCaller({ ...base, slackApi: s, phone: '+15555550100' }, {}), false);
  assert.equal(s.posts.length, 0);
});

test('pings once in thread for a positive reply with phone', async () => {
  _resetForTests(); const s = fakeSlack();
  assert.equal(await pingCaller({ ...base, slackApi: s, phone: '+15555550100' }, env), true);
  assert.equal(await pingCaller({ ...base, slackApi: s, phone: '+15555550100' }, env), false);
  assert.equal(s.posts.length, 1);
  assert.match(s.posts[0].text, /<@U1>.*Call now: \+15555550100/);
  assert.equal(s.posts[0].ts, '1.1');
});

test('late phone pings a second time only when the first had none', async () => {
  _resetForTests(); const s = fakeSlack();
  await pingCaller({ ...base, slackApi: s }, env);
  assert.equal(await pingCaller({ ...base, slackApi: s, phone: '+15555550100', late: true }, env), true);
  assert.equal(await pingCaller({ ...base, slackApi: s, phone: '+15555550100', late: true }, env), false);
  assert.equal(s.posts.length, 2);
});

test('skips non-positive classifications', async () => {
  _resetForTests(); const s = fakeSlack();
  assert.equal(await pingCaller({ ...base, slackApi: s, classification: 'QUESTION' }, env), false);
  assert.equal(await pingCaller({ ...base, slackApi: s, classification: 'FOLLOW_UP' }, env), false);
});
