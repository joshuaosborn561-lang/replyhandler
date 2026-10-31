const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function sliceBetween(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `missing slice ${start}`);
  return src.slice(i, j);
}

describe('inactive clients are skipped by pollers and crons', () => {
  it('Deep Roots is deactivated, not deleted', () => {
    const sql = read('migrations/055_deactivate_deep_roots.sql');
    assert.match(sql, /SET active = false/);
    assert.match(sql, /name ILIKE 'deep roots%'/);
    assert.match(sql, /active IS DISTINCT FROM false/);
    const body = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    assert.doesNotMatch(body, /\bDELETE\b/i);
    assert.doesNotMatch(body, /smartlead/i);
    assert.doesNotMatch(body, /hubspot/i);
  });

  it('the Deep Roots migration is registered so it runs on deploy', () => {
    assert.match(read('scripts/run-migrations.js'), /055_deactivate_deep_roots\.sql/);
  });

  it('the meeting reminder, digest, nurture, and stuck-send jobs skip inactive clients', () => {
    const cron = read('src/cron.js');
    const reminder = sliceBetween(cron, 'Meeting reminders', 'if (attentionDigestsEnabled');
    assert.match(reminder, /c\.active IS DISTINCT FROM false/);

    const digest = read('src/services/client-reply-digest.js');
    assert.match(digest, /client\.active === false/);

    const nurture = read('src/services/nurture-day30.js');
    const enroll = sliceBetween(nurture, 'async function scanEntries', 'async function syncExits');
    assert.match(enroll, /c\.active IS DISTINCT FROM false/);
    const due = sliceBetween(nurture, 'async function dueLeads', 'async function buildCard');
    assert.match(due, /c\.active IS DISTINCT FROM false/);
    const exits = sliceBetween(nurture, 'async function syncExits', 'function replySummary');
    assert.match(exits, /client\.active === false/);
    const hubspot = sliceBetween(nurture, 'async function flushAllHubSpot', 'async function closeOpenTouches');
    assert.match(hubspot, /client\.active === false/);

    const stuck = read('src/services/stuck-send-sweeper.js');
    const retry = sliceBetween(stuck, 'SELECT active FROM clients', 'const result = await retrySend');
    assert.match(retry, /activeRow\.active === false/);

    assert.match(read('src/services/smartlead-poller.js'), /active IS DISTINCT FROM false/);
    assert.match(read('src/services/heyreach-poller.js'), /active IS DISTINCT FROM false/);
    assert.match(read('src/services/follow-up-runner.js'), /c\.active IS DISTINCT FROM false/);
    assert.match(read('src/services/followup-sequence.js'), /client\.active === false/);
  });
});
