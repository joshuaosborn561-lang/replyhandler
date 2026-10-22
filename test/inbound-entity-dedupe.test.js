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

test('different text is never deduped, including when the stats id matches', async () => {
  const { entity, hyphen } = billPair();
  assert.strictEqual(normalizeInboundText(entity), normalizeInboundText(hyphen));

  const tuesday = 'Sounds good, Tuesday works for a walkthrough at the site';
  const wednesday = 'Sounds good, Wednesday works for a walkthrough at the site';
  assert.notStrictEqual(normalizeInboundText(tuesday), normalizeInboundText(wednesday));
  assert.notStrictEqual(inboundPrefix(tuesday), inboundPrefix(wednesday));

  let seen;
  const queryable = {
    async query(sql, params) {
      seen = { sql, params };
      return { rows: [] };
    },
  };
  const row = await inboundAlreadyRecorded(queryable, {
    clientId: 'client-1',
    platform: 'smartlead',
    leadId: 'bill-hall',
    leadEmail: 'bill.hall@emcor.com',
    campaignId: 'emcor-1',
    emailStatsId: 'stats-bill-hall',
    inboundMessage: wednesday,
  });
  assert.strictEqual(row, null);
  assert.match(seen.sql, /lead_id/);
  assert.match(seen.sql, /<> 'FOLLOW_UP'/);
  assert.doesNotMatch(seen.sql, /smartlead_email_stats_id/);
  assert.doesNotMatch(seen.sql, /campaign_id/);
  assert.doesNotMatch(seen.sql, /UNION ALL/);
  assert.doesNotMatch(seen.sql, /interval '/);
  assert.ok(!seen.params.includes('stats-bill-hall'));
  assert.ok(!seen.params.includes('emcor-1'));
  assert.ok(
    seen.params.some((p) => String(p).includes('wednesday works')),
    'only the text of this reply is sent to the dedupe query'
  );
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
  const dedupe = read('src/services/reply-dedupe.js');
  assert.ok(
    !/smartlead_email_stats_id/.test(dedupe),
    'dedupe must not match on a SmartLead stats id'
  );
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
  assert.ok(
    !/idx_pending_replies_stats_dedupe/.test(sql),
    '040 must not add a stats-id dedupe index'
  );
  for (const name of Object.keys(NAMED_HTML_ENTITIES)) {
    assert.match(sql, new RegExp(`&${name};`), `migration must decode &${name};`);
  }
  // Storage decode keeps the en dash. Do not rewrite the column to ASCII.
  assert.ok(!/chr\(8211\), '-'/.test(sql), 'migration must not fold dashes in stored text');
});
