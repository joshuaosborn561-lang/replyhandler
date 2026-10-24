const test = require('node:test');
const assert = require('node:assert');
const { leadVerdict } = require('../src/services/lead-verdict');
const { resolveReplyEnrichCeiling } = require('../src/services/reply-enrich-policy');

const db = { query: async () => ({ rows: [{ id: 1, name: 'Acme Client', icp_profile: { titles: ['Owner'] } }] }) };

test('sales rep is never a decision maker, without a model call', async () => {
  let called = false;
  const out = await leadVerdict(db, { client_tag: 'acme_client', title: 'Account Executive' }, {
    dmModel: { generateContent: async () => { called = true; return {}; } },
  });
  assert.equal(out.dm_verdict, 'no');
  assert.equal(called, false);
});

test('AI decides other titles', async () => {
  const out = await leadVerdict(db, { client_tag: 'acme_client', title: 'Director of Operations' }, {
    dmModel: { generateContent: async () => ({ response: { text: () => '{"verdict":"yes","reason":"runs ops budget"}' } }) },
  });
  assert.equal(out.dm_verdict, 'yes');
  assert.equal(out.icp_verdict, 'unknown');
  assert.match(out.icp_reason, /no company domain/);
});

test('hot ceiling can never go above $5', () => {
  const r = resolveReplyEnrichCeiling({ classification: 'INTERESTED', client: { reply_enrich_ceiling_hot_usd: 40 } });
  assert.equal(r.ceilingUsd, 5);
});
