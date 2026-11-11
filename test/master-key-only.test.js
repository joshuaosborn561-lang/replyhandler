/**
 * Per-client Smartlead key cut (Josh, Nov 11 2026).
 *
 * Every clients.smartlead_api_key is null, '' or a revoked leftover. Only the
 * env agency key (SMARTLEAD_MASTER_API_KEY) is valid. Each Smartlead path must
 * use that key and attribute the campaign by its `sg-owner:<slug>` tag.
 *
 * No network: global.fetch is a fake Smartlead that answers 401 to any key but
 * the master key, and every other host / http(s) request throws.
 */
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers/master-key-harness');

H.setMasterEnv();
H.blockRealNetwork();

const routing = require('../src/services/campaign-routing');

const ROSTER = H.buildRoster();
const bySlug = (slug) => ROSTER.find((c) => c.id === `client-${slug}`);

function campaignsForAll() {
  const m = new Map();
  H.CLIENT_FIXTURES.forEach(([slug], i) => {
    // Untitled names: ownership must come from the tag, not the title heuristic.
    m.set(String(5000 + i), { name: `Sequence ${5000 + i}`, tags: [{ id: i, name: `sg-owner:${slug}` }] });
  });
  return m;
}

function assertOnlyMaster(sl, label) {
  const calls = sl.smartleadCalls();
  for (const c of calls) {
    assert.strictEqual(c.apiKey, H.MASTER, `${label}: Smartlead ${c.method} ${c.path} used a non-master key`);
  }
  assert.ok(!sl.calls.some((c) => c.blocked), `${label}: a non-Smartlead host was contacted: ${JSON.stringify(sl.calls.filter((c) => c.blocked))}`);
  return calls;
}

// ─── 1. Key selection (unit) ─────────────────────────────────────────────────

test('withSmartleadKey: every client row (null, empty, missing, revoked key; flag true or false) gets the master key', () => {
  for (const c of ROSTER) {
    const k = routing.withSmartleadKey(c);
    assert.strictEqual(k.smartlead_api_key, H.MASTER, c.name);
    assert.strictEqual(k.slack_channel_id, c.slack_channel_id);
  }
  // Rows themselves are not modified (no key is written or cleared).
  assert.ok(ROSTER.some((c) => String(c.smartlead_api_key || '').startsWith(H.REVOKED_PREFIX)));
  // smartlead_use_master_key is not consulted.
  const brandNew = { id: 'new', name: 'Brand New Co', smartlead_use_master_key: false };
  assert.strictEqual(routing.withSmartleadKey(brandNew).smartlead_api_key, H.MASTER);
});

test('applyAgencyKey returns the master key for any campaign, tagged or not, without calling Smartlead', async () => {
  const sl = H.installSmartleadFetch();
  try {
    for (const c of ROSTER) {
      for (const cid of ['5001', '999999', null]) {
        const k = await routing.applyAgencyKey(c, cid);
        assert.strictEqual(k.smartlead_api_key, H.MASTER);
        assert.strictEqual(k.id, c.id);
      }
    }
    assert.strictEqual(sl.smartleadCalls().length, 0);
  } finally { sl.restore(); }
});

test('poll targets: exactly one agency-inbox scan; revoked stored keys are never scanned', () => {
  const targets = routing.pollTargetsFromClients(ROSTER);
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].mode, 'master');
  assert.strictEqual(targets[0].apiKey, H.MASTER);
});

test('legacy agency-inbox owner: none after the cut unless SMARTLEAD_MASTER_OWNER_SLUG names one', () => {
  assert.strictEqual(routing.legacyOwnerFor(ROSTER, H.MASTER, {}), null);
  const sg = routing.legacyOwnerFor(ROSTER, H.MASTER, { SMARTLEAD_MASTER_OWNER_SLUG: 'salesglider' });
  assert.strictEqual(sg.id, 'client-salesglider');
  const t = routing.pollTargetsFromClients(ROSTER, { SMARTLEAD_MASTER_API_KEY: H.MASTER, SMARTLEAD_MASTER_OWNER_SLUG: 'salesglider' });
  assert.strictEqual(t[0].client._legacyOwner.id, 'client-salesglider');
  assert.strictEqual(t[0].client.smartlead_api_key, H.MASTER);
});

test('title-routed campaign on a client-mode source still uses the master key (not a stored key)', async () => {
  const src = { ...bySlug('nutter'), smartlead_api_key: `${H.REVOKED_PREFIX}nutter` };
  const r = await routing.routeClientForCampaign(src, '42', {
    tags: [], routes: new Map(), clients: ROSTER, mode: 'client', campaignName: 'BPLTG | Owners',
  });
  assert.strictEqual(r.id, 'client-bpltg');
  assert.strictEqual(r.smartlead_api_key, H.MASTER);
});

// ─── 2. Fixture: tag → client + Slack channel, for every slug in the repo ────

test('fixture: every repo client slug resolves client + Slack channel from its sg-owner tag (key null, wrong webhook URL)', async () => {
  const campaigns = campaignsForAll();
  const sl = H.installSmartleadFetch({ campaigns });
  const smartlead = require('../src/services/smartlead');
  try {
    // Webhook URL belongs to SalesGlider, whose key is gone too.
    const urlClient = routing.withSmartleadKey(bySlug('salesglider'));
    for (const [cid, camp] of campaigns) {
      const slug = camp.tags[0].name.split(':')[1];
      const r = await routing.routeClientForCampaign(urlClient, cid, {
        mode: 'webhook',
        clients: ROSTER,
        routes: new Map(),
        campaignName: camp.name,
        fetchTags: (id) => smartlead.campaignOwnerTags(routing.masterKey(), id),
      });
      assert.ok(r && r.id, `${slug}: unresolved`);
      assert.strictEqual(r.id, `client-${slug}`, `${slug}: wrong client`);
      assert.strictEqual(r.slack_channel_id, H.slugChannel(slug), `${slug}: wrong Slack channel`);
      assert.strictEqual(r.smartlead_api_key, H.MASTER, `${slug}: wrong key`);
    }
    assert.ok(assertOnlyMaster(sl, 'tag fetch').length >= campaigns.size);
  } finally { sl.restore(); }
});

test('fixture: TechEvolution client row matches sg-owner:techevo', () => {
  const c = routing.clientForSlug('techevo', [{ id: 't', name: 'TechEvolution', active: true }]);
  assert.strictEqual(c && c.id, 't');
});

// ─── 3. Startup EMAIL_REPLY registration ─────────────────────────────────────

test('startup webhook registration: agency key only, each tagged campaign hooked to its owner URL', async () => {
  process.env.RAILWAY_PUBLIC_DOMAIN = 'rh.example';
  process.env.SMARTLEAD_WEBHOOK_CHECK_GAP_MS = '200';
  const campaigns = campaignsForAll();
  const sl = H.installSmartleadFetch({ campaigns });
  H.installDb(ROSTER);
  try {
    const { ensureEmailReplyWebhooks } = require('../src/services/email-reply-webhooks');
    const summary = await ensureEmailReplyWebhooks();
    assert.strictEqual(summary.clients, 1, 'only the agency scan');
    assert.strictEqual(summary.campaigns, campaigns.size);
    assert.deepStrictEqual(summary.errors, []);
    const calls = assertOnlyMaster(sl, 'registration');
    const creates = calls.filter((c) => c.path.endsWith('/webhook/create') && c.method === 'POST');
    assert.strictEqual(creates.length, campaigns.size);
    const hooked = new Map(creates.map((c) => {
      const b = JSON.parse(c.body);
      return [String(b.email_campaign_id), b.webhook_url];
    }));
    for (const [cid, camp] of campaigns) {
      const slug = camp.tags[0].name.split(':')[1];
      assert.strictEqual(hooked.get(cid), `https://rh.example/webhook/smartlead/client-${slug}`, slug);
    }
  } finally { sl.restore(); }
});

// ─── 4. Poller backstop ──────────────────────────────────────────────────────

test('poller: one agency inbox fetch with the master key; every tagged row attributes to a client (never unresolved)', async () => {
  const campaigns = campaignsForAll();
  const old = '2020-01-01T00:00:00.000Z';
  const inboxRows = [...campaigns.keys()].map((cid, i) => ({
    email_campaign_id: Number(cid),
    email_campaign_name: campaigns.get(cid).name,
    email_lead_id: 9000 + i,
    lead_email: `p${i}@example.org`,
    last_reply_time: old,
    email_history: [
      { type: 'SENT', time: old, email_body: 'hi' },
      { type: 'REPLY', time: old, email_body: 'yes please', from: `p${i}@example.org` },
    ],
  }));
  const sl = H.installSmartleadFetch({ campaigns, inboxRows });
  H.installDb(ROSTER);
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a); };
  process.env.SMARTLEAD_POLL_MAX_REPLIES = String(inboxRows.length);
  try {
    const { pollSmartleadReplies } = require('../src/services/smartlead-poller');
    await pollSmartleadReplies();
  } finally { console.log = origLog; sl.restore(); }
  const calls = assertOnlyMaster(sl, 'poller');
  assert.ok(calls.some((c) => c.path.endsWith('/master-inbox/inbox-replies')));
  const scans = logs.filter((a) => a[0] === '[SmartLeadPoll] Client scan complete');
  assert.strictEqual(scans.length, 1, 'one agency scan');
  const skips = scans[0][1].skipReasons;
  assert.ok(!skips.unresolved_campaign_owner, `unresolved rows: ${JSON.stringify(skips)}`);
  assert.strictEqual(skips.older_than_lookback, inboxRows.length);
});

// ─── 5. Interested sweep ─────────────────────────────────────────────────────

test('interested sweep: master key only, every row attributed to its tag owner', async () => {
  const campaigns = campaignsForAll();
  const now = new Date().toISOString();
  const inboxRows = [...campaigns.keys()].map((cid, i) => ({
    email_campaign_id: Number(cid),
    email_campaign_name: campaigns.get(cid).name,
    email_lead_id: 7000 + i,
    lead_email: `s${i}@example.org`,
    lead_first_name: 'S',
    lead_last_name: String(i),
    lead_category: 'Interested',
    last_reply_time: now,
    email_history: [{ type: 'REPLY', time: now, email_body: 'Sounds good', from: `s${i}@example.org` }],
  }));
  const sl = H.installSmartleadFetch({ campaigns, inboxRows });
  H.installDb(ROSTER);
  const booking = require('../src/services/booking-check');
  const realBooked = booking.looksAlreadyBooked;
  booking.looksAlreadyBooked = async () => null;
  delete require.cache[require.resolve('../src/services/interested-sweep')];
  try {
    const { sweepInterested } = require('../src/services/interested-sweep');
    const r = await sweepInterested({ hours: 24, pages: 2, pageSize: 20 });
    const all = [...r.likelyBooked, ...r.interestedNoBookingEvidence];
    assert.strictEqual(r.clientsScanned, 1);
    assert.strictEqual(all.length, campaigns.size, 'every interested row is attributed');
    const byEmail = new Map(all.map((e) => [e.email, e.client]));
    H.CLIENT_FIXTURES.forEach(([, name], i) => {
      assert.strictEqual(byEmail.get(`s${i}@example.org`), name);
    });
    assertOnlyMaster(sl, 'sweep');
  } finally { booking.looksAlreadyBooked = realBooked; sl.restore(); }
});

// ─── 6. Lead suppression (Smartlead DNC) ─────────────────────────────────────

test('lead suppression: Smartlead DNC lookup uses the master key for a client with a revoked key', async () => {
  const seenKeys = [];
  const reason = await require('../src/services/lead-suppression').leadSuppressionReason(
    { id: 'client-nutter', smartlead_api_key: `${H.REVOKED_PREFIX}nutter` },
    { platform: 'smartlead', leadEmail: 'x@example.org' },
    {
      isDisqualified: async () => false,
      siblingDisqualified: async () => false,
      smartleadDnc: async (k) => { seenKeys.push(k); return false; },
      env: { SMARTLEAD_MASTER_API_KEY: H.MASTER },
    },
  );
  assert.strictEqual(reason, null);
  assert.deepStrictEqual(seenKeys, [H.MASTER]);
});

test('lead suppression: still runs the DNC check for a client with no key at all', async () => {
  const seenKeys = [];
  await require('../src/services/lead-suppression').leadSuppressionReason(
    { id: 'client-bpltg', smartlead_api_key: null },
    { platform: 'smartlead', leadEmail: 'x@example.org' },
    {
      isDisqualified: async () => false,
      siblingDisqualified: async () => false,
      smartleadDnc: async (k) => { seenKeys.push(k); return false; },
      env: { SMARTLEAD_MASTER_API_KEY: H.MASTER },
    },
  );
  assert.deepStrictEqual(seenKeys, [H.MASTER]);
});

// ─── 7. Booked-meeting brief ─────────────────────────────────────────────────

test('booked brief: master key is tried first; a revoked client key is never the first call', async () => {
  const tried = [];
  const { loadSmartleadContext } = require('../src/services/booked-brief-data');
  void loadSmartleadContext;
  const sl = {
    lookupLeadByEmail: async (k) => { tried.push(k); return k === H.MASTER ? { leadId: '1', campaignIds: ['5001'], lead: {} } : null; },
    pickLeadCampaign: (a, ids) => a || ids[0],
    getThreadHistory: async (k) => { tried.push(k); return null; },
    resolveCampaignName: async (k) => { tried.push(k); return 'x'; },
  };
  const { gatherBrief } = require('../src/services/booked-brief-data');
  try {
    await gatherBrief(
      { client: 'Nutter Group', prospect: { email: 'p@example.org', name: 'P' }, smartleadCampaignId: '5001' },
      { clients: [{ id: 'client-nutter', name: 'Nutter Group', smartlead_api_key: `${H.REVOKED_PREFIX}nutter` }] },
      { sl, env: { SMARTLEAD_MASTER_API_KEY: H.MASTER }, fetchImpl: async () => { throw new Error('blocked'); } },
    );
  } catch { /* later research steps may fail offline; the Smartlead keys are what is checked */ }
  assert.ok(tried.length >= 1);
  assert.strictEqual(tried[0], H.MASTER);
  assert.ok(!tried.some((k) => String(k).startsWith(H.REVOKED_PREFIX)), `revoked key used: ${tried}`);
});

// ─── 8. Onboarding ───────────────────────────────────────────────────────────

test('onboarding: existing client with a leftover key gets a master-key webhook and a campaign route', async () => {
  process.env.RAILWAY_PUBLIC_DOMAIN = 'rh.example';
  const existing = { ...bySlug('parlay'), smartlead_api_key: `${H.REVOKED_PREFIX}parlay` };
  const sqls = [];
  const q = async (sql, p) => {
    sqls.push([sql, p]);
    if (/lower\(name\)/.test(sql) || /WHERE id = \$1/.test(sql)) return { rows: [existing] };
    if (/^UPDATE clients SET name/.test(sql)) return { rows: [{ ...existing }] };
    if (/smartlead_use_master_key = true/.test(sql)) return { rows: [{ ...existing, smartlead_use_master_key: true }] };
    return { rows: [] };
  };
  const hooks = [];
  const slMock = {
    listCampaignWebhooks: async (k) => { hooks.push(['list', k]); return []; },
    webhookHasEmailReply: () => false,
    createEmailReplyWebhook: async (k, c, u) => { hooks.push(['create', k, c, u]); },
  };
  const { upsertOnboardingClient } = require('../src/routes/onboarding');
  const r = await upsertOnboardingClient(
    { client_id: existing.id, name: existing.name, slack_channel_id: existing.slack_channel_id, smartlead_campaign_id: '5001' },
    { query: q, smartlead: slMock, env: { SMARTLEAD_MASTER_API_KEY: H.MASTER } },
  );
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json));
  assert.ok(hooks.length >= 1);
  for (const h of hooks) assert.strictEqual(h[1], H.MASTER);
  assert.ok(sqls.some(([s]) => /INSERT INTO smartlead_campaign_routes/.test(s)));
  assert.ok(!sqls.some(([, p]) => (p || []).includes(H.MASTER)), 'master key must never be stored');
  // The leftover key is neither cleared nor replaced.
  const upd = sqls.find(([s]) => /^UPDATE clients SET name/.test(s));
  if (upd) assert.strictEqual(upd[1][5], `${H.REVOKED_PREFIX}parlay`);
});

test('onboarding: brand-new client with no key and SMARTLEAD_API_KEY only (no MASTER var) still works', async () => {
  process.env.RAILWAY_PUBLIC_DOMAIN = 'rh.example';
  let row;
  const q = async (sql, p) => {
    if (/SELECT slack_bot_token/.test(sql)) return { rows: [{ slack_bot_token: 'xoxb-d' }] };
    if (/lower\(name\)/.test(sql)) return { rows: [] };
    if (/^INSERT INTO clients/.test(sql)) { row = { id: 'n1', name: p[0], smartlead_api_key: p[5], active: true }; return { rows: [row] }; }
    if (/smartlead_use_master_key = true/.test(sql)) return { rows: [{ ...row, smartlead_use_master_key: true }] };
    return { rows: [] };
  };
  const hooks = [];
  const slMock = { listCampaignWebhooks: async (k) => { hooks.push(k); return []; }, webhookHasEmailReply: () => false, createEmailReplyWebhook: async (k) => { hooks.push(k); } };
  const { upsertOnboardingClient } = require('../src/routes/onboarding');
  const r = await upsertOnboardingClient(
    { name: 'Brand New Co', slack_channel_id: 'C_NEW', smartlead_campaign_id: '777' },
    { query: q, smartlead: slMock, env: { SMARTLEAD_API_KEY: 'AGENCY-ALT' } },
  );
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.deepStrictEqual([...new Set(hooks)], ['AGENCY-ALT']);
});

// ─── 9. Optional real payloads + real roster (coordinator fixtures) ──────────

const REAL = H.loadRealPayloads();
const REAL_ROSTER = H.loadRealRoster();
test('real payloads (/workspace/keycut/fixtures/rh_payloads.json): tag → expected client + Slack channel, keys null/revoked', { skip: REAL && REAL_ROSTER ? false : 'fixture files not present' }, async () => {
  const smartlead = require('../src/services/smartlead');
  let checked = 0;
  for (const entry of REAL) {
    const cid = String(entry.campaign_id);
    const campaigns = new Map([[cid, { name: entry.campaign_name, tags: entry.tags }]]);
    const sl = H.installSmartleadFetch({ campaigns });
    try {
      const want = H.expectedRealClient(entry, REAL_ROSTER);
      // Agency inbox (poller) view: no URL client, nothing to fall back on.
      const viaMaster = await routing.routeClientForCampaign(
        { id: null, name: '(smartlead master)', smartlead_api_key: H.MASTER, _pollMode: 'master' }, cid,
        {
          mode: 'master', clients: REAL_ROSTER, routes: new Map(), legacyOwner: null,
          campaignName: entry.campaign_name,
          fetchTags: (id) => smartlead.campaignOwnerTags(routing.masterKey(), id),
        },
      );
      if (want) {
        assert.ok(viaMaster, `${entry.sg_owner} ${cid}: unresolved`);
        assert.strictEqual(viaMaster.id, want.id, `${entry.sg_owner} ${cid}`);
        assert.strictEqual(viaMaster.slack_channel_id, entry.expected_slack_channel, `${entry.sg_owner} ${cid}`);
        assert.strictEqual(viaMaster.smartlead_api_key, H.MASTER);
        assert.strictEqual(viaMaster._ownerVia, 'tag');
        checked += 1;
      } else {
        // No active client for this tag (inactive or missing row): never a guessed channel.
        assert.strictEqual(viaMaster, null, `${entry.sg_owner} ${cid}: posted to ${viaMaster && viaMaster.name}`);
      }
      assertOnlyMaster(sl, `real payload ${cid}`);
    } finally { sl.restore(); }
  }
  assert.ok(checked > 0);
});
