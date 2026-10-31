const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveReplyIcp,
  resolveClientTag,
  domainFromWebsite,
  composeReason,
  confidencePct,
  fromLlmRow,
  unknownVerdict,
  icpCeilingUsd,
  icpEstimateUsd,
  icpVerdictEquals,
  parseStoredIcp,
  clearIcpMemoryCache,
  buildGradePrompt,
  FORBIDDEN_WRITE_COLUMNS,
} = require('../src/services/reply-icp');
const { variantSpec, PASS, DEFAULT_CLIENT_VARIANTS } = require('../src/services/reply-icp-variants');
const { icpVerdictLine, leadFieldText } = require('../src/services/slack');
const { completeCardLinks, applyCardLinks } = require('../src/services/slack-reply-post');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('client tags map onto topup.icp_variants', () => {
  assert.equal(resolveClientTag('Bolder Cyber Partners'), 'bcp');
  assert.equal(resolveClientTag('Deep Roots Capital'), 'deep_roots');
  assert.equal(resolveClientTag('Deep Roots'), 'deep_roots');
  assert.equal(resolveClientTag('SalesGlider'), 'salesglider');
  assert.equal(DEFAULT_CLIENT_VARIANTS.bcp.jev_variant, 'bcp');
  assert.equal(PASS.bcp, 'private_equity_firm');
  assert.equal(variantSpec('bcp').pass, 'private_equity_firm');
});

test('domainFromWebsite ignores free-mail hosts', () => {
  assert.equal(domainFromWebsite('https://www.Acme.com/about'), 'acme.com');
  assert.equal(domainFromWebsite('acme.com'), 'acme.com');
  assert.equal(domainFromWebsite('https://gmail.com'), '');
  assert.equal(domainFromWebsite(''), '');
});

test('Jev P(PASS) becomes the displayed confidence', () => {
  assert.equal(confidencePct('qualified', 0.99), 99);
  assert.equal(confidencePct('disqualified', 0.2), 80);
  assert.equal(
    composeReason('disqualified', 'venture_capital_firm', 'private_equity_firm'),
    'website says venture capital firm; client only works with private equity firm',
  );
  const row = fromLlmRow(
    { fit: 'no', prob: 0.2, reason: 'venture_capital_firm', answers: { category: { choice: 'venture_capital_firm' } } },
    variantSpec('bcp'),
    { domain: 'vc.example', clientTag: 'bcp' },
  );
  assert.equal(row.status, 'disqualified');
  assert.equal(row.confidence, 80);
  assert.match(row.reason, /venture capital firm/);
  assert.match(row.reason, /private equity firm/);
});

test('card line formats qualified, disqualified, and unknown', () => {
  assert.match(icpVerdictLine({ status: 'unknown', reason: 'no website' }), /ICP: unknown \(no website\)/);
  assert.match(icpVerdictLine({ status: 'unknown', reason: 'no ICP' }), /ICP: not on file/);
  assert.match(
    icpVerdictLine({
      status: 'disqualified',
      confidence: 80,
      reason: 'website says VC firm; client only works with PE',
    }),
    /🎯 80% disqualified: website says VC firm; client only works with PE/,
  );
  const lead = leadFieldText({
    leadName: 'Pat',
    leadWebsite: 'https://acme.com',
    leadIcpVerdict: { status: 'qualified', confidence: 72, reason: 'buyer with own facility' },
  });
  assert.match(lead, /72% qualified/);
  assert.match(lead, /<https:\/\/acme\.com\|/);
});

test('no website or no ICP is unknown without grading', async () => {
  clearIcpMemoryCache();
  const noSite = await resolveReplyIcp({ website: '', grade: true, gradeFn: async () => { throw new Error('should not grade'); } });
  assert.equal(noSite.status, 'unknown');
  assert.equal(noSite.reason, 'no website');

  const noIcp = await resolveReplyIcp({
    website: 'https://acme.com',
    clientName: 'Vasco Warranty',
    grade: true,
    gradeFn: async () => { throw new Error('should not grade'); },
  });
  assert.equal(noIcp.status, 'unknown');
  assert.equal(noIcp.reason, 'no ICP');
});

test('shared topup llm row is used before Gemini', async () => {
  clearIcpMemoryCache();
  const reads = [];
  const orig = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { supabaseRequest } = require('../src/services/reply-examples');
  const real = supabaseRequest;
  // reply-examples.supabaseRequest is used inside resolveReplyIcp via the
  // already-required module. Stub at the module cache.
  const examples = require('../src/services/reply-examples');
  examples.supabaseRequest = async (path) => {
    reads.push(path);
    if (path.includes('icp_variants')) {
      return [{ jev_variant: 'bcp', disco_icp: 'bcp' }];
    }
    if (path.includes('icp_llm_results')) {
      return [{
        fit: 'no',
        prob: 0.2,
        reason: 'venture_capital_firm',
        model: 'jev:typesafe/jev-1.13|bcp',
        answers: { category: { choice: 'venture_capital_firm' } },
      }];
    }
    return [];
  };

  try {
    const v = await resolveReplyIcp({
      website: 'https://sequoia.com',
      clientName: 'Bolder Cyber Partners',
      grade: true,
      gradeFn: async () => { throw new Error('cache hit must not grade'); },
    });
    assert.equal(v.status, 'disqualified');
    assert.equal(v.confidence, 80);
    assert.equal(v.source, 'topup_llm_results');
    assert.ok(reads.some((p) => p.includes('icp_llm_results')));
  } finally {
    examples.supabaseRequest = real;
    if (orig == null) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = orig;
    if (origKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
  }
});

test('local domain+client cache skips a second grade', async () => {
  clearIcpMemoryCache();
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let grades = 0;
  const rows = new Map();
  const db = {
    query: async (sql, params) => {
      if (/FROM reply_icp_verdicts/.test(sql)) {
        const hit = rows.get(`${params[0]}::${params[1]}`);
        return { rows: hit ? [hit] : [] };
      }
      if (/INSERT INTO reply_icp_verdicts/.test(sql)) {
        rows.set(`${params[0]}::${params[1]}`, {
          verdict: params[2],
          confidence: params[3],
          reason: params[4],
          label: params[5],
          pass_label: params[6],
          source: params[7],
          cost_usd: params[8],
        });
        return { rows: [] };
      }
      if (/UPDATE pending_replies/.test(sql)) return { rows: [] };
      if (/SELECT name FROM clients/.test(sql)) return { rows: [{ name: 'Bolder Cyber Partners' }] };
      return { rows: [] };
    },
  };
  const gradeFn = async () => {
    grades += 1;
    return {
      fit: 'yes',
      prob: 0.91,
      reason: 'private_equity_firm',
      answers: { category: { choice: 'private_equity_firm' } },
    };
  };

  try {
    const first = await resolveReplyIcp({
      website: 'https://pe.example',
      clientName: 'Bolder Cyber Partners',
      db,
      grade: true,
      fetchImpl: async () => ({ ok: true, text: async () => '<html><body>We acquire majority stakes in established companies and talk about EBITDA and value creation.</body></html>' }),
      gradeFn,
    });
    assert.equal(first.status, 'qualified');
    assert.equal(grades, 1);

    const second = await resolveReplyIcp({
      website: 'https://pe.example',
      clientName: 'Bolder Cyber Partners',
      db,
      grade: true,
      gradeFn: async () => { throw new Error('second call must use cache'); },
    });
    assert.equal(second.status, 'qualified');
    assert.equal(grades, 1);
  } finally {
    if (prevUrl == null) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('estimate-first ceiling refuses a grade over $0.02', async () => {
  assert.equal(icpCeilingUsd({}), 0.02);
  assert.ok(icpEstimateUsd({}) <= icpCeilingUsd({}));

  const prev = process.env.REPLY_ICP_ESTIMATE_USD;
  process.env.REPLY_ICP_ESTIMATE_USD = '0.05';
  clearIcpMemoryCache();
  try {
    assert.ok(icpEstimateUsd() > icpCeilingUsd());
    const v = await resolveReplyIcp({
      website: 'https://acme.com',
      clientName: 'SalesGlider',
      grade: true,
      fetchImpl: async () => ({ ok: true, text: async () => 'x'.repeat(400) }),
      gradeFn: async () => { throw new Error('over ceiling'); },
    });
    assert.equal(v.status, 'unknown');
    assert.equal(v.reason, 'ceiling');
  } finally {
    if (prev == null) delete process.env.REPLY_ICP_ESTIMATE_USD;
    else process.env.REPLY_ICP_ESTIMATE_USD = prev;
  }
});

test('grade prompt is the ported icp-llm category question', () => {
  const spec = variantSpec('bcp');
  const prompt = buildGradePrompt(spec, 'vc.example', 'We are a seed-stage venture fund.');
  assert.match(prompt, /joshuaosborn561-lang\/topup/);
  assert.match(prompt, /private_equity_firm/);
  assert.match(prompt, /venture_capital_firm/);
  assert.match(prompt, /Qualified \(fit=yes\) only when the category is private_equity_firm/);
});

test('completeCardLinks chat.updates when the ICP verdict arrives late', async () => {
  const updates = [];
  const slackApi = {
    updateDraftApprovalCard: async (token, channel, ts, payload) => {
      updates.push({ ts, payload });
      return { ok: true };
    },
    updateAlertCard: async () => ({ ok: true }),
  };
  const result = await completeCardLinks({
    token: 'x',
    channelId: 'C1',
    postedTs: '1.2',
    isDraft: true,
    payload: {
      leadName: 'Pat',
      leadWebsite: 'https://vc.example',
      leadIcpVerdict: { status: 'unknown', reason: 'checking' },
      clientName: 'Bolder Cyber Partners',
    },
    card: { leadName: 'Pat', leadWebsite: 'https://vc.example', clientName: 'Bolder Cyber Partners' },
    replyId: 'r1',
    slackApi,
    enrichFn: async () => null,
    linkLookup: async () => ({}),
    identity: { website: 'https://vc.example', linkedinUrl: null, email: 'p@vc.example' },
    dbClient: { query: async () => ({ rows: [] }) },
    clientId: 'c1',
    evaluateIcp: async () => ({
      status: 'disqualified',
      confidence: 80,
      reason: 'website says venture capital firm; client only works with private equity firm',
      source: 'topup_llm_results',
    }),
  });
  assert.equal(result.updated, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ts, '1.2');
  assert.equal(updates[0].payload.leadIcpVerdict.status, 'disqualified');
  assert.equal(updates[0].payload.leadIcpVerdict.confidence, 80);
});

test('applyCardLinks forwards the ICP verdict', () => {
  const card = applyCardLinks(
    { leadWebsite: 'https://acme.com' },
    {},
    { icp: { status: 'qualified', confidence: 90, reason: 'trade contractor' } },
  );
  assert.equal(card.leadIcpVerdict.status, 'qualified');
});

test('icp helpers never write forbidden suppression columns', () => {
  const src = read('src/services/reply-icp.js');
  assert.deepEqual(FORBIDDEN_WRITE_COLUMNS, ['dl_status', 'sg_exclude', 'skip_*']);
  assert.doesNotMatch(src, /\bdl_status\s*=/);
  assert.doesNotMatch(src, /\bsg_exclude\s*=/);
  assert.doesNotMatch(src, /\bskip_[a-z0-9_]+\s*=/);
  assert.ok(!icpVerdictEquals(
    { status: 'unknown', reason: 'checking' },
    { status: 'disqualified', confidence: 80, reason: 'vc' },
  ));
  assert.equal(parseStoredIcp({ status: 'qualified', confidence: 1 }).status, 'qualified');
});

test('SalesGlider grades against any high-ticket B2B business, not only trade contractors', async () => {
  clearIcpMemoryCache();
  const { DEFAULT_CLIENT_VARIANTS: V, PASS: P } = require('../src/services/reply-icp-variants');
  assert.equal(V.salesglider.jev_variant, 'b2b_service');
  assert.equal(P.b2b_service, 'b2b_service_business');
  const spec = variantSpec('b2b_service');
  assert.ok(spec.criteria.b2b_service_business, 'pass label has a criterion');
  assert.match(spec.instructions, /any high-ticket B2B business/i);
  assert.match(spec.criteria.b2b_service_business, /any high-ticket B2B business/i);
  assert.match(spec.criteria.b2b_service_business, /staffing/i);
  assert.match(spec.criteria.low_value_or_solo, /not a high-ticket B2B business/i);
  assert.match(V.salesglider.note, /any high-ticket B2B business/i);
  assert.doesNotMatch(`${spec.instructions}\n${spec.criteria.b2b_service_business}\n${spec.criteria.low_value_or_solo}\n${V.salesglider.note}`, /\$36|36K/i);

  const orig = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const examples = require('../src/services/reply-examples');
  const real = examples.supabaseRequest;
  const reads = [];
  examples.supabaseRequest = async (path) => {
    reads.push(path);
    // topup still says `choice` for salesglider, and has a stale trade-contractor
    // (and an unrelated other-client) verdict for the domain.
    if (path.includes('icp_variants')) return [{ jev_variant: 'choice', disco_icp: 'salesglider' }];
    if (path.includes('icp_llm_results')) {
      return [
        { fit: 'no', prob: 0.01, reason: 'other_not_contractor', model: 'jev:typesafe/jev-1.13|choice', answers: { category: { choice: 'other_not_contractor' } } },
        { fit: 'no', prob: 0.1, reason: 'x', model: 'jev:typesafe/jev-1.13|bcp', answers: { category: { choice: 'operating_company_not_investor' } } },
      ];
    }
    if (path.includes('icp_site_text')) return [{ body: 'We place staffing and recruiting talent for B2B companies. '.repeat(20), http_status: 200, chars: 1200 }];
    return [];
  };
  try {
    let graded = null;
    const v = await resolveReplyIcp({
      website: 'https://staffing-co.example',
      clientName: 'SalesGlider',
      grade: true,
      gradeFn: async (s) => {
        graded = s;
        return { fit: 'yes', prob: 0.9, reason: 'staffing firm', answers: { category: { choice: 'b2b_service_business' } } };
      },
    });
    assert.equal(graded.pass, 'b2b_service_business', 'local variant beats the topup `choice` row');
    assert.equal(v.status, 'qualified');
    assert.equal(v.source, 'gemini_icp_llm_port', 'stale choice/other-client cache rows are ignored');
  } finally {
    examples.supabaseRequest = real;
    if (orig == null) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = orig;
    if (origKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
    clearIcpMemoryCache();
  }
});

test('a cached verdict graded against an older pass label is ignored', async () => {
  clearIcpMemoryCache();
  const prevUrl = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  const stale = {
    query: async (sql) => {
      if (/FROM clients/.test(sql)) return { rows: [{ name: 'SalesGlider' }] };
      if (/FROM reply_icp_verdicts/.test(sql)) {
        return { rows: [{ verdict: 'disqualified', confidence: 100, reason: 'old', label: 'other_not_contractor', pass_label: 'commercial_trade_contractor', source: 'x', cost_usd: 0 }] };
      }
      return { rows: [] };
    },
  };
  try {
    const v = await resolveReplyIcp({
      website: 'https://staffing-co.example',
      clientName: 'SalesGlider',
      db: stale,
      grade: false,
    });
    assert.notEqual(v.status, 'disqualified', 'old DQ is not served');
  } finally {
    if (prevUrl != null) process.env.SUPABASE_URL = prevUrl;
    clearIcpMemoryCache();
  }
});
