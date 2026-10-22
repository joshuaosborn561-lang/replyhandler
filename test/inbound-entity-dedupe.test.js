/**
 * Bill Hall, EMCOR, 2026-10-22 2:52 PM ET.
 *
 * The webhook stored a decoded dash. The SmartLead inbox poller stored
 * `&#8211;` in the same signature. The two normalized texts diverged at
 * character 112, inside the 120-character dedupe prefix, and both paths
 * posted a Slack card three seconds apart.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const {
  inboundPrefix,
  normalizeInboundText,
  decodeInboundForStorage,
  inboundAlreadyRecorded,
  inboundStatsBackupApplies,
  STORED_NORM_SQL,
  DASH_CODEPOINTS,
} = require('../src/services/reply-dedupe');
const { NAMED_HTML_ENTITIES } = require('../src/utils/html-entities');
const { stripHtmlToText } = require('../src/utils/smartlead-webhook-helpers');

function legacyNorm(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function billPair() {
  const intro = 'Adding my Office manager Rebecca ';
  const tailEntity = 'Bill Hall &#8211; Project Executive';
  const tailHyphen = 'Bill Hall - Project Executive';
  for (let n = 0; n < 200; n++) {
    const filler = 'n'.repeat(n);
    const entity = `${intro}${filler} ${tailEntity}`;
    const hyphen = `${intro}${filler} ${tailHyphen}`;
    const at = firstDiff(legacyNorm(entity), legacyNorm(hyphen));
    if (at === 112) return { entity, hyphen, filler };
  }
  throw new Error('could not place the Bill Hall dash at character 112');
}

test('Bill Hall entity renderings share a dedupe prefix', () => {
  const { entity, hyphen } = billPair();
  const enDash = hyphen.replace('Bill Hall - ', 'Bill Hall \u2013 ');
  const hex = entity.replace('&#8211;', '&#x2013;');
  const named = entity.replace('&#8211;', '&ndash;');
  const wrapped = entity.replace('&#8211;', '&amp;ndash;');
  const em = hyphen.replace('Bill Hall - ', 'Bill Hall \u2014 ');
  const curly = entity.replace('&#8211;', '&#8217;');
  const curlyChar = hyphen.replace('-', '\u2019');

  // The old whitespace-only normalizer diverges inside the prefix window.
  // That is the bug. The new key must not.
  const divergeAt = firstDiff(legacyNorm(entity), legacyNorm(hyphen));
  assert.strictEqual(divergeAt, 112);
  assert.ok(divergeAt < 120, 'the fixture must sit inside PREFIX_LEN or it would not have double-carded');
  assert.notStrictEqual(legacyNorm(entity).slice(0, 120), legacyNorm(hyphen).slice(0, 120));

  assert.strictEqual(inboundPrefix(entity), inboundPrefix(hyphen));
  assert.strictEqual(normalizeInboundText(entity), normalizeInboundText(hyphen));
  assert.strictEqual(normalizeInboundText(enDash), normalizeInboundText(hyphen));
  assert.strictEqual(normalizeInboundText(hex), normalizeInboundText(hyphen));
  assert.strictEqual(normalizeInboundText(named), normalizeInboundText(hyphen));
  assert.strictEqual(normalizeInboundText(wrapped), normalizeInboundText(hyphen));
  assert.strictEqual(normalizeInboundText(em), normalizeInboundText(hyphen));
  assert.strictEqual(normalizeInboundText(curly), normalizeInboundText(curlyChar));

  assert.ok(normalizeInboundText(entity).includes('bill hall - project executive'));
  assert.ok(!normalizeInboundText(entity).includes('&#8211;'));
  assert.ok(!normalizeInboundText(entity).includes('\u2013'));

  // Stored text is decoded, not folded, so the card still shows the en dash.
  const stored = decodeInboundForStorage(entity);
  assert.ok(stored.includes('Bill Hall \u2013 Project Executive'));
  assert.ok(!stored.includes('&#8211;'));
  assert.strictEqual(
    stripHtmlToText(`<p>${entity}</p>`).includes('Bill Hall \u2013 Project Executive'),
    true
  );

  // A genuinely different reply still does not collapse.
  assert.notStrictEqual(
    inboundPrefix('Sounds good, Tuesday works'),
    inboundPrefix('Sounds good, Wednesday works')
  );
  assert.notStrictEqual(normalizeInboundText('Yes'), normalizeInboundText('No'));
});

test('stored-column SQL folds the same dashes, quotes, and entities', () => {
  assert.match(STORED_NORM_SQL, /&#0\*8211;/);
  assert.match(STORED_NORM_SQL, /&#x0\*2013;/);
  assert.match(STORED_NORM_SQL, /&ndash;/);
  assert.match(STORED_NORM_SQL, /&mdash;/);
  assert.match(STORED_NORM_SQL, /&amp;/);
  assert.match(STORED_NORM_SQL, /chr\(160\)/);
  for (const code of DASH_CODEPOINTS) {
    assert.match(STORED_NORM_SQL, new RegExp(`chr\\(${code}\\)`), `SQL must fold dash codepoint ${code}`);
  }
  assert.match(STORED_NORM_SQL, /chr\(8217\)/);
  assert.match(STORED_NORM_SQL, /&rsquo;/);
});

test('a stats id is a 1-minute backup, not an identity', async () => {
  const { entity, hyphen } = billPair();
  assert.notStrictEqual(legacyNorm(entity), legacyNorm(hyphen));
  assert.strictEqual(normalizeInboundText(entity), normalizeInboundText(hyphen));

  // Three seconds apart, same person, campaign, and stats id: one inbound
  // even if some other rendering difference survives normalization.
  assert.strictEqual(inboundStatsBackupApplies({
    campaignId: 'emcor-1',
    otherCampaignId: 'emcor-1',
    emailStatsId: 'stats-bill-hall',
    otherEmailStatsId: 'stats-bill-hall',
    ageMs: 3 * 1000,
  }), true);

  let seen;
  const queryable = {
    async query(sql, params) {
      seen = { sql, params };
      return { rows: [{ id: 'existing-webhook', status: 'pending' }] };
    },
  };
  const row = await inboundAlreadyRecorded(queryable, {
    clientId: 'client-1',
    platform: 'smartlead',
    leadId: 'bill-hall',
    leadEmail: 'bill.hall@emcor.com',
    campaignId: 'emcor-1',
    emailStatsId: 'stats-bill-hall',
    inboundMessage: entity,
  });
  assert.strictEqual(row.id, 'existing-webhook');
  assert.match(seen.sql, /smartlead_email_stats_id = \$7/);
  assert.match(seen.sql, /campaign_id = \$8/);
  assert.doesNotMatch(seen.sql, /COALESCE\(smartlead_email_stats_id/);
  assert.match(seen.sql, /UNION ALL/);
  assert.match(seen.sql, /interval '1 minute'/);
  assert.match(seen.sql, /<> 'FOLLOW_UP'/);
  assert.match(seen.sql, /same person|lead_email|lead_id/);
  assert.ok(seen.params.includes('stats-bill-hall'));
  assert.ok(seen.params.includes('emcor-1'));
  assert.ok(
    seen.params.some((p) => String(p).includes('bill hall - project executive')),
    'the text key is still sent so a later different reply is not stats-only'
  );

  // The OR is what lets texts differ. Person is required for both branches.
  const orAt = seen.sql.indexOf('OR (');
  const personAt = seen.sql.indexOf('lead_id');
  assert.ok(personAt > -1 && personAt < orAt, 'person match is outside the stats OR');

  assert.strictEqual(inboundStatsBackupApplies({
    campaignId: 'emcor-1',
    otherCampaignId: 'emcor-1',
    emailStatsId: 'stats-bill-hall',
    otherEmailStatsId: 'stats-bill-hall',
    ageMs: 61 * 1000,
  }), false, 'a reply older than 1 minute that shares the SENT stats id must still come through');
  assert.strictEqual(inboundStatsBackupApplies({
    campaignId: 'emcor-1',
    otherCampaignId: 'emcor-1',
    emailStatsId: 'stats-bill-hall',
    otherEmailStatsId: 'stats-bill-hall',
    ageMs: 60 * 1000,
  }), true);
  assert.strictEqual(inboundStatsBackupApplies({
    campaignId: 'emcor-1',
    otherCampaignId: 'other-campaign',
    emailStatsId: 'stats-bill-hall',
    otherEmailStatsId: 'stats-bill-hall',
    ageMs: 3000,
  }), false);
  assert.strictEqual(inboundStatsBackupApplies({
    campaignId: '',
    otherCampaignId: '',
    emailStatsId: 'stats-bill-hall',
    otherEmailStatsId: 'stats-bill-hall',
    ageMs: 3000,
  }), false);
});

test('poller and webhook store decoded inbound text', () => {
  const poller = read('src/services/smartlead-poller.js');
  const webhook = read('src/routes/webhooks.js');
  assert.match(poller, /decodeInboundForStorage\(/);
  assert.ok(
    poller.indexOf('decodeInboundForStorage') < poller.indexOf('INSERT INTO pending_replies'),
    'the poller must decode before the insert'
  );
  assert.match(webhook, /decodeInboundForStorage\(/);
  const early = webhook.slice(
    webhook.indexOf('let inboundForPersist'),
    webhook.indexOf('const slEarly')
  );
  assert.match(early, /decodeInboundForStorage\(/);
  const asyncBody = webhook.slice(webhook.indexOf('let inboundEffective'));
  assert.match(asyncBody, /inboundEffective = decodeInboundForStorage\(inboundEffective\)/);
  assert.match(poller, /emailStatsId: smartleadEmailStatsId/);
  assert.match(webhook, /emailStatsId: earlyStatsId/);
  assert.match(webhook, /emailStatsId: statsId/);
});

test('migration 040 decodes recent inbound entities and runs on startup', () => {
  const sql = read('migrations/040_decode_inbound_html_entities.sql');
  const startup = read('scripts/run-migrations.js');
  const list = startup.slice(
    startup.indexOf('const MIGRATION_FILES'),
    startup.indexOf('async function clientsTableExists')
  );
  assert.ok(
    list.indexOf('039_follow_up_idempotency.sql') < list.indexOf('040_decode_inbound_html_entities.sql'),
    '040 must run after 039'
  );
  assert.match(sql, /inbound_message/);
  assert.match(sql, /interval '30 days'/);
  assert.match(sql, /IS DISTINCT FROM/);
  assert.match(sql, /&#\[0-9\]/);
  assert.match(sql, /&#\[xX\]/);
  assert.match(sql, /DROP FUNCTION replyhandler_decode_html_entities_040/);
  assert.match(sql, /idx_pending_replies_stats_dedupe/);
  assert.match(
    sql,
    /ON pending_replies \(client_id, platform, smartlead_email_stats_id, campaign_id, created_at\)/
  );
  for (const name of Object.keys(NAMED_HTML_ENTITIES)) {
    assert.match(sql, new RegExp(`&${name};`), `migration must decode &${name};`);
  }
  // Storage decode keeps the en dash. Do not rewrite the column to ASCII.
  assert.ok(!/chr\(8211\), '-'/.test(sql), 'migration must not fold dashes in stored text');
});
