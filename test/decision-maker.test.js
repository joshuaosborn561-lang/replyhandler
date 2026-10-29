const test = require('node:test');
const assert = require('node:assert/strict');
const dm = require('../src/services/decision-maker');
const { icpVerdictLine } = require('../src/services/slack');
const { parseLinkedinSearchResult, parseAiArkPerson } = require('../src/services/person-profile-lookup');
const { icpVerdictEquals, parseStoredIcp } = require('../src/services/reply-icp');

const OPS = ['Owner', 'Operations Manager', 'Facilities Director'];

test('sales rep is not a decision maker for an owner/ops buyer', () => {
  for (const t of ['Account Executive', 'Sales Representative', 'BDR', 'Business Development Manager', 'Inside Sales']) {
    const r = dm.judgeDecisionMaker(t, OPS);
    assert.equal(r.status, 'no', t);
    assert.equal(r.reason, 'sales role');
  }
  assert.equal(dm.decisionMakerText(dm.judgeDecisionMaker('Account Executive', OPS)),
    'Decision maker: No, sales role (Account Executive)');
});

test('matching personas and owners are decision makers', () => {
  assert.equal(dm.judgeDecisionMaker('Director of Facilities', OPS).status, 'yes');
  assert.equal(dm.judgeDecisionMaker('VP Operations', OPS).status, 'yes');
  assert.equal(dm.judgeDecisionMaker('Co-Founder & CEO', OPS).status, 'yes');
  assert.equal(dm.judgeDecisionMaker('Facilities Coordinator', OPS).status, 'no');
  assert.equal(dm.judgeDecisionMaker('Marketing Specialist', OPS).status, 'no');
});

test('sales leader is a fit when the client sells to sales leaders', () => {
  assert.equal(dm.judgeDecisionMaker('VP of Sales', ['VP Sales', 'CRO']).status, 'yes');
});

test('unknown title says so instead of guessing', () => {
  const r = dm.judgeDecisionMaker('', OPS);
  assert.equal(r.status, 'unknown');
  assert.equal(dm.decisionMakerText(r), 'Decision maker: unknown (title not found)');
});

test('no ICP titles: owners yes, sales no, unclear titles unknown', () => {
  assert.equal(dm.judgeDecisionMaker('Owner', []).status, 'yes');
  assert.equal(dm.judgeDecisionMaker('Account Manager', []).status, 'no');
  assert.equal(dm.judgeDecisionMaker('Project Lead', []).status, 'unknown');
});

test('title extraction from lead fields and LinkedIn', () => {
  assert.equal(dm.extractLeadTitle({}, { custom_fields: { job_title: 'Owner' } }), 'Owner');
  assert.equal(dm.extractLeadTitle(null, { position: 'COO' }), 'COO');
  assert.equal(dm.titleFromLinkedinHeadline('Jane Doe - Account Executive - Acme | LinkedIn'), 'Account Executive');
  assert.equal(dm.titleFromLinkedinHeadline('Jane Doe | LinkedIn'), null);
  const hit = parseLinkedinSearchResult({ link: 'https://www.linkedin.com/in/x', title: 'Jane Doe - Owner - Co | LinkedIn' });
  assert.equal(hit.title, 'Owner');
  assert.equal(parseAiArkPerson({ profile: { full_name: 'A B', title: 'President' } }).title, 'President');
});

test('personas come from the stored client ICP', async () => {
  assert.deepEqual(dm.targetPersonas({ titles: ['Owner', ' GM '] }), ['Owner', 'GM']);
  assert.deepEqual(dm.targetPersonas(null), []);
  const db = { query: async () => ({ rows: [{ icp_profile: { titles: ['Plant Manager'] } }] }) };
  assert.deepEqual(await dm.loadClientPersonas(db, 7), ['Plant Manager']);
});

test('card shows decision maker line and overall fit reflects it', () => {
  const v = { status: 'qualified', confidence: 90, reason: 'HVAC contractor',
    decision_maker: dm.judgeDecisionMaker('Account Executive', OPS) };
  const line = icpVerdictLine(v);
  assert.match(line, /Not a fit: company fits/);
  assert.match(line, /Decision maker: No, sales role \(Account Executive\)/);
  const yes = icpVerdictLine({ ...v, decision_maker: dm.judgeDecisionMaker('Owner', OPS) });
  assert.match(yes, /90% qualified/);
  assert.match(yes, /Decision maker: Yes/);
  const unk = icpVerdictLine({ ...v, decision_maker: dm.judgeDecisionMaker(null, OPS) });
  assert.match(unk, /decision maker unconfirmed/);
  assert.equal(icpVerdictLine({ status: 'qualified', confidence: 90, reason: 'x' }), '\n🎯 90% qualified: x');
});

test('decision maker survives storage and changes trigger card update', () => {
  const d = { status: 'no', title: 'AE', reason: 'sales role' };
  assert.deepEqual(parseStoredIcp({ status: 'qualified', decision_maker: d }).decision_maker, d);
  assert.equal(icpVerdictEquals({ status: 'qualified' }, { status: 'qualified', decision_maker: d }), false);
});

test('SalesGlider buyers: owners, founders, CEOs, presidents, partners, heads of sales/growth', async () => {
  const db = {
    query: async () => ({
      rows: [{ name: 'SalesGlider', icp_profile: { titles: ['Plant Manager'] } }],
    }),
  };
  const personas = await dm.loadClientPersonas(db, 'sg');
  assert.ok(personas.includes('Head of Sales') && personas.includes('Head of Growth'));
  assert.ok(!personas.includes('Plant Manager'), 'code-owned titles win for SalesGlider');
  for (const t of ['Owner', 'Founder', 'CEO', 'President', 'Managing Partner', 'Head of Sales', 'Head of Growth', 'VP of Sales']) {
    assert.equal(dm.judgeDecisionMaker(t, personas).status, 'yes', t);
  }
  for (const t of ['Account Executive', 'Sales Representative', 'Marketing Coordinator', 'Recruiter']) {
    assert.equal(dm.judgeDecisionMaker(t, personas).status, 'no', t);
  }
});
