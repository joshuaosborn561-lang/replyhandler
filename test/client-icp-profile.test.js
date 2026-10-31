const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  emptyProfile,
  clientSearchHints,
  callMatchesClient,
  hasDefaultVariant,
  clientHasIcp,
  profileHasFacts,
  groundIcpProfile,
  profileToVariantSpec,
  buildExtractPrompt,
  ensureClientIcp,
  backfillMissingClientIcp,
  summarizeIcpResult,
  needsIcpWork,
  parseManualIcpBody,
  saveManualIcpProfile,
} = require('../src/services/client-icp-profile');
const { loadVariant, resolveReplyIcp, clearIcpMemoryCache } = require('../src/services/reply-icp');
const fireflies = require('../src/services/fireflies');
const { FACT_GROUNDING_RULES } = require('../src/utils/draft-fact-check');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('Fireflies reports FIREFLIES_API_KEY when unset', () => {
  assert.equal(fireflies.requiredEnvVar(), 'FIREFLIES_API_KEY');
  assert.equal(fireflies.isConfigured({}), false);
  assert.equal(fireflies.isConfigured({ FIREFLIES_API_KEY: 'x' }), true);
});

test('known variant clients already have an ICP', () => {
  assert.equal(hasDefaultVariant({ name: 'bcp' }), true);
  assert.equal(hasDefaultVariant({ name: 'New Co LLC' }), false);
  assert.equal(clientHasIcp({ name: 'New Co LLC' }), false);
});

test('client search hints take domain from booking / email, not generic hosts', () => {
  const hints = clientSearchHints({
    name: 'New Co LLC',
    booking_link: 'https://www.newcoexample.com/book',
    contact_email: 'ops@newcoexample.com',
    cc_emails: 'josh@salesglidergrowth.com',
    notify_emails: 'team@notifyexample.com',
  });
  assert.deepEqual(hints.domains, ['newcoexample.com', 'notifyexample.com']);
});

test('grounding drops industries that are not in the transcript', () => {
  const source = [
    'We only sell to independent HVAC contractors in the Midwest.',
    'Buyer is usually the owner or the service manager.',
    'Skip national chains and anything residential-only.',
  ].join(' ');
  const extracted = {
    industries: ['independent HVAC contractors', 'biotech'],
    titles: ['owner', 'service manager'],
    company_size: [],
    geos: ['Midwest', 'Denver'],
    offer: ['sell to independent HVAC contractors'],
    exclusions: ['national chains', 'residential-only'],
  };
  const grounded = groundIcpProfile(extracted, source);
  assert.ok(grounded.industries.includes('independent HVAC contractors'));
  assert.ok(!grounded.industries.includes('biotech'));
  assert.ok(!grounded.geos.includes('Denver'));
  assert.ok(grounded.geos.includes('Midwest'));
  assert.ok(profileHasFacts(grounded));
});

test('extract prompt carries PR #97 fact-grounding rules', () => {
  const prompt = buildExtractPrompt('transcript text');
  assert.match(prompt, /FACT|facts present|Never state or guess/i);
  assert.ok(prompt.includes(FACT_GROUNDING_RULES.split('\n')[0].slice(2, 20)));
});

test('stored profile becomes a variant the grader can read', () => {
  const spec = profileToVariantSpec({
    industries: ['independent HVAC contractors'],
    titles: ['owner'],
    company_size: ['10-50'],
    geos: ['Midwest'],
    offer: ['outbound for HVAC shops'],
    exclusions: ['national chains'],
  });
  assert.equal(spec.pass, 'icp_fit');
  assert.match(spec.criteria.icp_fit, /HVAC/);
  assert.match(spec.criteria.not_icp, /national chains/);
});

test('ensureClientIcp flags needs_review when the Fireflies key is missing', async () => {
  const writes = [];
  const db = {
    query: async (sql, params) => {
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
  const result = await ensureClientIcp(
    { id: '00000000-0000-0000-0000-000000000001', name: 'New Co LLC' },
    { db, env: {}, firefliesApi: fireflies },
  );
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'missing_credentials');
  assert.equal(result.env_needed, 'FIREFLIES_API_KEY');
  const summary = summarizeIcpResult(result);
  assert.equal(summary.env_needed, 'FIREFLIES_API_KEY');
  assert.ok(writes.some((w) => /icp_status/.test(w.sql)));
});

test('ensureClientIcp flags needs_review when no calls match', async () => {
  const api = {
    isConfigured: () => true,
    requiredEnvVar: () => 'FIREFLIES_API_KEY',
    searchTranscripts: async () => [],
    transcriptMatches: () => false,
    getTranscript: async () => null,
    sentencesToText: () => '',
  };
  const result = await ensureClientIcp(
    { id: '00000000-0000-0000-0000-000000000002', name: 'New Co LLC' },
    { db: { query: async () => ({ rows: [] }) }, firefliesApi: api, env: { FIREFLIES_API_KEY: 'x' } },
  );
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'no_calls');
  assert.equal(result.transcript_count, 0);
});

test('ensureClientIcp stores a grounded profile from matching transcripts', async () => {
  const transcript = [
    'Target is independent HVAC contractors in the Midwest.',
    'Talk to the owner. Skip national chains.',
  ].join(' ');
  const api = {
    isConfigured: () => true,
    requiredEnvVar: () => 'FIREFLIES_API_KEY',
    searchTranscripts: async () => [{ id: 't1', title: 'kickoff', meeting_attendees: [] }],
    transcriptMatches: () => true,
    getTranscript: async () => ({ id: 't1', sentences: [{ text: transcript }] }),
    sentencesToText: () => transcript,
  };
  const result = await ensureClientIcp(
    { id: '00000000-0000-0000-0000-000000000003', name: 'New Co LLC' },
    {
      db: { query: async () => ({ rows: [] }) },
      firefliesApi: api,
      extractFn: async () => ({
        industries: ['independent HVAC contractors'],
        titles: ['owner'],
        company_size: [],
        geos: ['Midwest'],
        offer: [],
        exclusions: ['national chains'],
      }),
      env: { FIREFLIES_API_KEY: 'x' },
    },
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'fireflies');
  assert.ok(result.profile.industries.includes('independent HVAC contractors'));
  assert.equal(result.transcript_count, 1);
});

test('loadVariant reads clients.icp_profile when no topup variant exists', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const db = {
      query: async (sql) => {
        if (/icp_profile/.test(sql)) {
          return {
            rows: [{
              icp_status: 'ready',
              icp_profile: {
                industries: ['independent HVAC contractors'],
                titles: ['owner'],
                company_size: [],
                geos: ['Midwest'],
                offer: ['outbound for HVAC shops'],
                exclusions: ['national chains'],
              },
            }],
          };
        }
        return { rows: [] };
      },
    };
    const variant = await loadVariant('new_co_llc', {
      db,
      clientId: '00000000-0000-0000-0000-000000000004',
    });
    assert.equal(variant.jev_variant, 'client_profile');
    assert.equal(variant.spec.pass, 'icp_fit');
  } finally {
    if (prevUrl == null) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('resolveReplyIcp uses the stored client profile instead of no ICP', async () => {
  clearIcpMemoryCache();
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const db = {
      query: async (sql) => {
        if (/FROM clients/.test(sql) && /icp_profile/.test(sql)) {
          return {
            rows: [{
              icp_status: 'ready',
              icp_profile: {
                industries: ['independent HVAC contractors'],
                titles: [],
                company_size: [],
                geos: [],
                offer: ['maintenance'],
                exclusions: [],
              },
            }],
          };
        }
        if (/FROM reply_icp_verdicts/.test(sql)) return { rows: [] };
        if (/INSERT INTO reply_icp_verdicts/.test(sql)) return { rows: [] };
        return { rows: [] };
      },
    };
    const verdict = await resolveReplyIcp({
      website: 'https://hvacshop.example',
      clientName: 'New Co LLC',
      clientId: '00000000-0000-0000-0000-000000000005',
      db,
      grade: true,
      fetchImpl: async () => ({
        ok: true,
        text: async () => '<html><body>We are an independent HVAC contractor serving commercial buildings across the region for twenty years.</body></html>',
      }),
      gradeFn: async (spec) => ({
        fit: spec.pass === 'icp_fit' ? 'yes' : 'no',
        prob: 0.9,
        reason: 'fits',
        answers: { category: { choice: spec.pass } },
      }),
    });
    assert.equal(verdict.status, 'qualified');
    assert.notEqual(verdict.reason, 'no ICP');
  } finally {
    if (prevUrl == null) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

test('backfill counts only and skips clients that already have an ICP', async () => {
  const db = {
    query: async (sql) => {
      if (/FROM clients/.test(sql)) {
        return {
          rows: [
            { id: '1', name: 'bcp', active: true },
            { id: '2', name: 'New Co LLC', active: true, icp_status: null },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const counts = await backfillMissingClientIcp({
    db,
    dryRun: true,
    env: {},
    firefliesApi: fireflies,
  });
  assert.equal(counts.total, 2);
  assert.equal(counts.skipped_existing, 1);
  assert.equal(counts.needs_review, 1);
  assert.equal(counts.missing_credentials, 1);
  assert.ok(!JSON.stringify(counts).includes('New Co'));
  assert.ok(!/\b[A-Z][a-z]+ [A-Z]/.test(JSON.stringify(counts)));
});

test('backfill persists skipped_existing for default-variant clients', async () => {
  const writes = [];
  const db = {
    query: async (sql, params) => {
      if (/FROM clients/.test(sql) && /SELECT/.test(sql)) {
        return { rows: [{ id: '1', name: 'bcp', active: true, icp_status: null }] };
      }
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
  const counts = await backfillMissingClientIcp({
    db,
    dryRun: false,
    env: {},
    firefliesApi: fireflies,
  });
  assert.equal(counts.skipped_existing, 1);
  assert.ok(writes.some((w) => /icp_status/.test(w.sql) && w.params && w.params[1] === 'skipped_existing'));
});

test('needsIcpWork retries stale needs_review and ignores fresh ones', () => {
  const now = Date.parse('2026-10-15T18:00:00Z');
  assert.equal(needsIcpWork({ id: '1', name: 'New Co', icp_status: null, active: true }), true);
  assert.equal(needsIcpWork({ id: '1', name: 'bcp', icp_status: 'skipped_existing', active: true }), false);
  assert.equal(needsIcpWork({
    id: '1', name: 'New Co', icp_status: 'needs_review', icp_built_at: '2026-10-15T12:00:00Z', active: true,
  }, { includeNeedsReview: true, now }), false);
  assert.equal(needsIcpWork({
    id: '1', name: 'New Co', icp_status: 'needs_review', icp_built_at: '2026-10-14T12:00:00Z', active: true,
  }, { includeNeedsReview: true, now }), true);
  assert.equal(needsIcpWork({
    id: '1', name: 'New Co', icp_status: 'needs_review', icp_built_at: '2026-10-14T12:00:00Z', active: true,
  }, { includeNeedsReview: false, now }), false);
});

test('a hand-entered ICP accepts the six fields and rejects a bad shape', () => {
  const ok = parseManualIcpBody({
    icp_profile: {
      industries: ['independent HVAC contractors'],
      titles: 'owner, service manager',
      company_size: ['10-50'],
      geos: ['Midwest'],
      offer: ['outbound for HVAC shops'],
      exclusions: ['national chains'],
    },
    icp_transcript_count: '2',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'ready');
  assert.equal(ok.source, 'manual');
  assert.equal(ok.transcript_count, 2);
  assert.deepEqual(ok.profile.titles, ['owner', 'service manager']);

  const empty = parseManualIcpBody({ icp_profile: {} });
  assert.equal(empty.status, 'needs_review');

  assert.equal(parseManualIcpBody({ icp_profile: { city: ['Denver'] } }).ok, false);
  assert.equal(parseManualIcpBody({ icp_profile: { industries: [1] } }).ok, false);
  assert.equal(parseManualIcpBody({ icp_profile: { industries: ['hvac'] }, icp_status: 'published' }).ok, false);
  assert.equal(parseManualIcpBody({ icp_profile: {}, icp_transcript_count: -1 }).ok, false);
  assert.equal(parseManualIcpBody({ icp_profile: {}, icp_source: 'x'.repeat(65) }).ok, false);
  assert.equal(parseManualIcpBody({ icp_profile: {}, smartlead_api_key: 'secret' }).ok, false);
});

test('saveManualIcpProfile writes the ICP columns and does not return the client row', async () => {
  const writes = [];
  const db = {
    query: async (sql, params) => {
      writes.push({ sql, params });
      if (/SELECT id FROM clients/.test(sql)) return { rows: [{ id: 'c1' }] };
      return {
        rows: [{
          icp_profile: JSON.parse(params[0]),
          icp_status: params[1],
          icp_source: params[2],
          icp_transcript_count: params[3],
          smartlead_api_key: 'should-not-leak',
          name: 'New Co LLC',
        }],
      };
    },
  };
  const saved = await saveManualIcpProfile(db, 'c1', {
    icp_profile: { industries: ['independent HVAC contractors'], titles: ['owner'] },
    icp_status: 'ready',
    icp_source: 'onboarding-notes',
    icp_transcript_count: 1,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.icp_status, 'ready');
  assert.equal(saved.icp_source, 'onboarding-notes');
  assert.deepEqual(Object.keys(saved).sort(), [
    'icp_profile', 'icp_source', 'icp_status', 'icp_transcript_count', 'ok',
  ]);
  assert.equal(saved.smartlead_api_key, undefined);
  assert.equal(saved.name, undefined);
  const update = writes.find((w) => /UPDATE clients SET/.test(w.sql));
  assert.match(update.sql, /icp_profile/);
  assert.match(update.sql, /icp_built_at = now\(\)/);
  assert.equal(update.params[4], 'c1');

  const missing = await saveManualIcpProfile({
    query: async () => ({ rows: [] }),
  }, 'missing', { icp_profile: { industries: ['hvac'] } });
  assert.equal(missing.ok, false);
  assert.equal(missing.statusCode, 404);
});

test('admin create and backfill are wired to ensureClientIcp', () => {
  const admin = read('src/routes/admin.js');
  assert.match(admin, /ensureClientIcp/);
  assert.match(admin, /backfill-icp/);
  assert.match(admin, /backfillMissingClientIcp/);
  const migrate = read('scripts/run-migrations.js');
  assert.match(migrate, /033_client_icp_profile\.sql/);
  const route = admin.slice(admin.indexOf("router.post('/admin/clients/:clientId/icp-profile'"));
  const routeBody = route.slice(0, route.indexOf("router.patch('/admin/clients/:clientId'"));
  assert.match(routeBody, /saveManualIcpProfile/);
  assert.doesNotMatch(routeBody, /formatClient|requireAdminApiKey|smartlead_api_key/);
});

test('client search hints take first names from person emails and skip role mailboxes', () => {
  const hints = clientSearchHints({
    name: 'New Co LLC',
    contact_email: 'jane.smith@newcoexample.com',
    cc_email: 'info@newcoexample.com',
    cc_emails: 'ops@newcoexample.com, josh@salesglidergrowth.com',
    booking_link: 'https://www.newcoexample.com/book?host=pat.lee@newcoexample.com',
  });
  assert.deepEqual(hints.domains, ['newcoexample.com']);
  assert.ok(hints.emails.includes('jane.smith@newcoexample.com'));
  assert.ok(hints.emails.includes('pat.lee@newcoexample.com'));
  assert.ok(!hints.emails.some((e) => e.endsWith('@salesglidergrowth.com')));
  assert.deepEqual(hints.firstNames, ['Jane', 'Pat']);
});

test('a call matches on attendee domain or Onboarding/Discovery plus a first name', () => {
  const hints = {
    name: 'New Co LLC',
    domains: ['newcoexample.com'],
    emails: ['jane@newcoexample.com'],
    firstNames: ['Jane'],
  };
  const noName = { transcriptMatches: () => false };
  assert.equal(callMatchesClient({
    id: 'a',
    title: 'Weekly sync',
    meeting_attendees: [{ email: 'jane@newcoexample.com' }],
  }, hints, noName), true);
  assert.equal(callMatchesClient({
    id: 'b',
    title: 'Onboarding with Jane',
    meeting_attendees: [],
  }, { ...hints, domains: [] }, noName), true);
  assert.equal(callMatchesClient({
    id: 'c',
    title: 'Discovery Call - Jane Smith',
    participants: [],
  }, { ...hints, domains: [] }, noName), true);
  assert.equal(callMatchesClient({
    id: 'd',
    title: 'Onboarding with Bob',
    meeting_attendees: [],
  }, { ...hints, domains: [] }, noName), false);
  assert.equal(callMatchesClient({
    id: 'e',
    title: 'Weekly sync with Jane',
    meeting_attendees: [],
  }, { ...hints, domains: [] }, noName), false);
  assert.equal(callMatchesClient({
    id: 'f',
    title: 'Weekly sync',
    meeting_attendees: [{ email: 'josh@salesglidergrowth.com' }],
  }, { ...hints, domains: [] }, noName), false);
});

test('ensureClientIcp accepts a call by attendee domain and still drops invented facts', async () => {
  const transcript = [
    'Target is independent HVAC contractors in the Midwest.',
    'Talk to the owner. Skip national chains.',
  ].join(' ');
  const queries = [];
  const api = {
    isConfigured: () => true,
    requiredEnvVar: () => 'FIREFLIES_API_KEY',
    searchTranscripts: async (q) => {
      queries.push(q);
      if (q === 'New Co LLC') {
        return [{
          id: 't-domain',
          title: 'Weekly sync',
          meeting_attendees: [{ email: 'jane@newcoexample.com' }],
        }];
      }
      return [];
    },
    transcriptMatches: () => false,
    getTranscript: async () => ({ id: 't-domain' }),
    sentencesToText: () => transcript,
  };
  const result = await ensureClientIcp(
    {
      id: '00000000-0000-0000-0000-000000000011',
      name: 'New Co LLC',
      contact_email: 'jane.smith@newcoexample.com',
    },
    {
      db: { query: async () => ({ rows: [] }) },
      firefliesApi: api,
      extractFn: async () => ({
        industries: ['independent HVAC contractors'],
        titles: ['owner'],
        geos: ['Midwest', 'Denver'],
        exclusions: ['national chains'],
      }),
      env: { FIREFLIES_API_KEY: 'x' },
    },
  );
  assert.equal(result.status, 'ready');
  assert.ok(result.profile.industries.includes('independent HVAC contractors'));
  assert.ok(!result.profile.geos.includes('Denver'));
  assert.ok(queries.includes('onboarding Jane'));
  assert.ok(queries.includes('discovery Jane'));
});

test('ensureClientIcp stays needs_review when domain and title matches miss', async () => {
  const api = {
    isConfigured: () => true,
    requiredEnvVar: () => 'FIREFLIES_API_KEY',
    searchTranscripts: async () => [{
      id: 't-miss',
      title: 'Onboarding with Bob',
      meeting_attendees: [{ email: 'bob@other.example' }],
    }],
    transcriptMatches: () => false,
    getTranscript: async () => null,
    sentencesToText: () => '',
  };
  const result = await ensureClientIcp(
    {
      id: '00000000-0000-0000-0000-000000000012',
      name: 'New Co LLC',
      contact_email: 'jane.smith@newcoexample.com',
    },
    { db: { query: async () => ({ rows: [] }) }, firefliesApi: api, env: { FIREFLIES_API_KEY: 'x' } },
  );
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'no_calls');
});

test('a lookback window includes matching calls the keyword search missed', async () => {
  const transcript = 'We sell to independent HVAC contractors. Buyer is the owner.';
  let windowed = false;
  const api = {
    isConfigured: () => true,
    requiredEnvVar: () => 'FIREFLIES_API_KEY',
    searchTranscripts: async () => [],
    listTranscriptsBetween: async () => {
      windowed = true;
      return [{
        id: 't-window',
        title: 'Discovery with Jane',
        meeting_attendees: [],
      }];
    },
    transcriptMatches: () => false,
    getTranscript: async () => ({ id: 't-window' }),
    sentencesToText: () => transcript,
  };
  const result = await ensureClientIcp(
    {
      id: '00000000-0000-0000-0000-000000000013',
      name: 'Quiet Co',
      contact_email: 'jane@quietco.example',
    },
    {
      db: { query: async () => ({ rows: [] }) },
      firefliesApi: api,
      extractFn: async () => ({
        industries: ['independent HVAC contractors'],
        titles: ['owner'],
      }),
      env: { FIREFLIES_API_KEY: 'x' },
      callLookbackMs: 90 * 24 * 60 * 60 * 1000,
      now: Date.parse('2026-10-15T18:00:00Z'),
    },
  );
  assert.equal(windowed, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.transcript_count, 1);
});
