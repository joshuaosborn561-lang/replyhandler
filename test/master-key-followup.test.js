/**
 * Follow-up to the per-client Smartlead key cut (live findings, Nov 11 2026).
 *
 * 1. Tags only come back with include_tags=true.
 * 2. Every live sg-owner tag resolves through an explicit owner table.
 * 3. A TAGGED campaign whose owner is inactive / unknown is dropped — never
 *    carded into the fetching client's channel (Ciotola → SalesGlider, 8:06am CT).
 * 4. Nurture uses the master key, not NURTURE_SMARTLEAD_API_KEY.
 * 5. Every client key null + flag false → exactly one master poll target.
 * 7. Master inbox scan budget 200 rows / cycle in pages of 20.
 *
 * Offline: fake Smartlead over global.fetch, http(s) blocked, in-memory db.
 */
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers/master-key-harness');

H.setMasterEnv();
H.blockRealNetwork();
H.stubSlackWebClient();

const routing = require('../src/services/campaign-routing');
const smartlead = require('../src/services/smartlead');

const LIVE = H.loadRealRoster(); // test/fixtures/rh_clients_live.json (names, active, channel only)
const byName = (name) => LIVE.find((c) => c.name === name && c.active !== false);
const SG = byName('SalesGlider');

// ─── 1. include_tags ─────────────────────────────────────────────────────────

test('campaignOwnerTags requests include_tags=true with the given (master) key and parses the live tag shape', async () => {
  const live = new Map([['4242293', { name: 'Vector | Owners', tags: [{ tag_id: 547631, tag_name: 'sg-owner:vector', tag_color: '#DB2777' }] }]]);
  const sl = H.installSmartleadFetch({ campaigns: live });
  try {
    const tags = await smartlead.campaignOwnerTags(H.MASTER, 4242293);
    assert.deepStrictEqual(tags, [{ tag_id: 547631, tag_name: 'sg-owner:vector', tag_color: '#DB2777' }]);
    assert.deepStrictEqual(routing.ownerSlugsFromTags(tags), ['vector']);
    const [call] = sl.smartleadCalls();
    assert.strictEqual(call.path, '/api/v1/campaigns/4242293');
    assert.strictEqual(call.includeTags, true);
    assert.strictEqual(call.apiKey, H.MASTER);
    assert.strictEqual(routing.clientForSlug(routing.ownerSlugsFromTags(tags)[0], LIVE).name, 'Vector Energy Group');
  } finally { sl.restore(); }
});

test('without include_tags the live API omits tags: the old URL would have yielded [] (regression guard)', async () => {
  const live = new Map([['4242294', { name: 'x', tags: [{ tag_name: 'sg-owner:vector' }] }]]);
  const sl = H.installSmartleadFetch({ campaigns: live });
  try {
    const plain = await smartlead.getCampaign(H.MASTER, 4242294);
    assert.strictEqual(plain.tags, undefined, 'fake mirrors live: no tags without include_tags');
    assert.ok(!sl.smartleadCalls()[0].includeTags, 'plain getCampaign callers are unchanged');
    const withTags = await smartlead.getCampaign(H.MASTER, 4242294, { includeTags: true });
    assert.strictEqual(withTags.tags[0].tag_name, 'sg-owner:vector');
  } finally { sl.restore(); }
});

test('campaignOwnerTags returns null (unknown), not [], when the lookup fails', async () => {
  const sl = H.installSmartleadFetch({ campaigns: new Map() }); // 404
  try {
    assert.strictEqual(await smartlead.campaignOwnerTags(H.MASTER, 9999991), null);
    assert.strictEqual(await smartlead.campaignOwnerTags('REVOKED', 9999992), null); // 401
  } finally { sl.restore(); }
});

test('listCampaigns asks for include_tags=true and returns tags on every campaign', async () => {
  const live = new Map([
    ['1', { name: 'a', tags: [{ tag_name: 'sg-owner:bcp' }] }],
    ['2', { name: 'b', tags: [{ tag_name: 'sg-owner:emcor' }] }],
  ]);
  const sl = H.installSmartleadFetch({ campaigns: live });
  try {
    const list = await smartlead.listCampaigns(H.MASTER);
    assert.strictEqual(sl.smartleadCalls()[0].includeTags, true);
    assert.deepStrictEqual(list.map((c) => routing.ownerSlugsFromTags(routing.tagsFromRecord(c))[0]), ['bcp', 'emcor']);
  } finally { sl.restore(); }
});

test('HeyReach Smartlead context lists campaigns with include_tags=true', async () => {
  const ctx = require('../src/services/heyreach-smartlead-context');
  const seen = [];
  await ctx.findSmartleadColdEmails({
    apiKey: H.MASTER,
    email: 'p@example.org',
    name: 'Pat Riley',
    clientId: SG.id,
    gapMs: 0,
    query: async () => ({ rows: [] }),
    fetchJson: async (req) => {
      seen.push(req);
      if (req.path === '/campaigns/') return { status: 200, ok: true, json: [] };
      return { status: 200, ok: true, json: [] };
    },
  }).catch(() => null);
  const list = seen.find((r) => r.path === '/campaigns/');
  assert.ok(list, `campaign list not requested: ${seen.map((r) => r.path)}`);
  assert.strictEqual(list.query.include_tags, 'true');
});

// ─── 2. Explicit owner table for every live tag ──────────────────────────────

const EXPECTED_LIVE = {
  bcp: 'Bolder Cyber Partners',
  bpltg: 'BPLTG',
  ciotola: 'inactive',
  cornerstone: 'inactive',
  culture_fits: 'Culture Fits',
  emcor: 'Emcor',
  goliath: 'Goliath',
  insight: 'SalesGlider', // ASSUMPTION: #salesglider-insight-ai-replies
  nexus: 'no_client',
  nutter: 'Nutter',
  parlay: 'Parlay Tech',
  peterson: 'Roofs By Peterson',
  powergryd: 'PowerGryd',
  salesglider: 'SalesGlider',
  techevo: 'TechEvolution',
  vector: 'Vector Energy Group',
  virtual_pulsar: 'no_client',
  deeproots: 'inactive',
  nieto: 'inactive',
  msrs: 'inactive',
  positive: 'no_client',
  vasco: 'inactive',
};

test('every live sg-owner tag is in the explicit owner table', () => {
  const keys = new Set(Object.keys(routing.OWNER_SLUG_CLIENTS));
  for (const tag of H.LIVE_TAGS) assert.ok(keys.has(tag), `missing ${tag}`);
  assert.deepStrictEqual(Object.keys(EXPECTED_LIVE).sort(), [...H.LIVE_TAGS].sort());
});

test('every live tag resolves against the live client roster as expected', () => {
  for (const [tag, want] of Object.entries(EXPECTED_LIVE)) {
    const r = routing.resolveOwnerSlug(tag, LIVE);
    if (want === 'inactive' || want === 'no_client') {
      assert.strictEqual(r.client, null, `${tag} must not resolve (got ${r.client && r.client.name})`);
      assert.strictEqual(r.status, want, tag);
    } else {
      assert.ok(r.client, `${tag} → nothing`);
      assert.strictEqual(r.client.name, want, tag);
      assert.strictEqual(r.client.active, true);
    }
  }
  // Duplicate inactive rows never win.
  assert.strictEqual(routing.resolveOwnerSlug('salesglider', LIVE).client.slack_channel_id, 'C0AR02YS268');
  assert.strictEqual(routing.resolveOwnerSlug('techevo', LIVE).client.slack_channel_id, 'C0BCS6J0BPB');
});

test('techevo routing does not revive TechEvo booking (booking retirement unchanged)', () => {
  const bb = require('../src/services/booking-bridge');
  assert.ok(!Object.prototype.hasOwnProperty.call(bb.CLIENT_SLUG_ALIASES, 'techevo'));
  assert.deepStrictEqual(bb.RETIRED_BOOKING_BRIDGE_SLUGS.techevo, ['TechEvolution', 'TechEvo']);
});

// ─── 3. Tagged campaign with no active owner is dropped ──────────────────────

const CIOTOLA_TAGS = [{ tag_id: 1, tag_name: 'sg-owner:ciotola', tag_color: '#000' }];

test('Ciotola: SalesGlider per-key scan (client mode), title + route pointing at SalesGlider → dropped, not SalesGlider', async () => {
  const reasons = [];
  const r = await routing.routeClientForCampaign({ ...SG, _pollMode: 'client' }, '4289737', {
    tags: CIOTOLA_TAGS,
    clients: LIVE,
    routes: new Map([['4289737', SG.id]]),
    mode: 'client',
    campaignName: 'Ciotola | SalesGlider Owners',
    onDrop: (x) => reasons.push(x),
  });
  assert.strictEqual(r, null);
  assert.deepStrictEqual(reasons, ['owner_tag_inactive']);
});

test('Ciotola: webhook on the SalesGlider URL and agency inbox with a legacy / env owner → dropped', async () => {
  const webhook = await routing.routeClientForCampaign(routing.withSmartleadKey(SG), '4289737', {
    tags: CIOTOLA_TAGS, clients: LIVE, routes: new Map(), mode: 'webhook', campaignName: 'Ciotola | x',
  });
  assert.strictEqual(webhook, null);
  const env = { SMARTLEAD_MASTER_API_KEY: H.MASTER, SMARTLEAD_MASTER_OWNER_SLUG: 'salesglider' };
  const [target] = routing.pollTargetsFromClients(LIVE, env);
  assert.strictEqual(target.client._legacyOwner.id, SG.id, 'env legacy owner is set');
  const master = await routing.routeClientForCampaign(target.client, '4289737', {
    tags: CIOTOLA_TAGS, clients: LIVE, routes: new Map(), mode: 'master', env,
  });
  assert.strictEqual(master, null, 'legacy / env owner never takes a tagged campaign');
});

test('unknown tag (no client) and conflicting tags are dropped too', async () => {
  for (const tags of [
    [{ tag_name: 'sg-owner:positive' }],
    [{ tag_name: 'sg-owner:nexus' }],
    [{ tag_name: 'sg-owner:vector' }, { tag_name: 'sg-owner:bpltg' }],
    [{ tag_name: 'sg-owner:vector' }, { tag_name: 'sg-owner:positive' }],
  ]) {
    const reasons = [];
    const r = await routing.routeClientForCampaign({ ...SG }, '77', {
      tags, clients: LIVE, routes: new Map([['77', SG.id]]), mode: 'webhook', campaignName: 'SalesGlider | x',
      onDrop: (x) => reasons.push(x),
    });
    assert.strictEqual(r, null, JSON.stringify(tags));
    assert.strictEqual(reasons.length, 1);
  }
  // insight + salesglider both name SalesGlider: not a conflict.
  const both = await routing.routeClientForCampaign({ id: null, name: 'm' }, '78', {
    tags: [{ tag_name: 'sg-owner:insight' }, { tag_name: 'sg-owner:salesglider' }], clients: LIVE, routes: new Map(), mode: 'master',
  });
  assert.strictEqual(both.id, SG.id);
});

test('untagged campaign keeps its fallbacks: route, title, webhook URL, legacy / env owner', async () => {
  const vector = byName('Vector Energy Group');
  const viaRoute = await routing.routeClientForCampaign({ ...SG }, '90', { tags: [], clients: LIVE, routes: new Map([['90', vector.id]]), mode: 'webhook' });
  assert.strictEqual(viaRoute.id, vector.id);
  const viaTitle = await routing.routeClientForCampaign({ ...SG }, '91', { tags: [], clients: LIVE, routes: new Map(), mode: 'webhook', campaignName: 'BPLTG | Owners' });
  assert.strictEqual(viaTitle.name, 'BPLTG');
  const viaUrl = await routing.routeClientForCampaign({ ...SG }, '92', { tags: [], clients: LIVE, routes: new Map(), mode: 'webhook', campaignName: 'Canary shell: #1' });
  assert.strictEqual(viaUrl.id, SG.id);
  const env = { SMARTLEAD_MASTER_API_KEY: H.MASTER, SMARTLEAD_MASTER_OWNER_SLUG: 'salesglider' };
  const [target] = routing.pollTargetsFromClients(LIVE, env);
  const viaEnv = await routing.routeClientForCampaign(target.client, '93', { tags: [], clients: LIVE, routes: new Map(), mode: 'master', env, campaignName: 'Canary shell: #2' });
  assert.strictEqual(viaEnv.id, SG.id);
});

test('tag lookup failed: an explicit route still applies, but title / URL / legacy do not', async () => {
  const vector = byName('Vector Energy Group');
  const failing = async () => null;
  const routed = await routing.routeClientForCampaign({ ...SG }, '94', { fetchTags: failing, clients: LIVE, routes: new Map([['94', vector.id]]), mode: 'webhook' });
  assert.strictEqual(routed.id, vector.id);
  const reasons = [];
  const none = await routing.routeClientForCampaign({ ...SG }, '95', {
    fetchTags: failing, clients: LIVE, routes: new Map(), mode: 'webhook', campaignName: 'SalesGlider | x', onDrop: (x) => reasons.push(x),
  });
  assert.strictEqual(none, null);
  assert.deepStrictEqual(reasons, ['owner_tags_unavailable']);
});

test('HeyReach context: a Ciotola-tagged campaign in SalesGlider\'s Smartlead client is not SalesGlider\'s', () => {
  const { campaignsOwnedByClient } = require('../src/services/heyreach-smartlead-context');
  const owned = campaignsOwnedByClient({
    replyClient: SG,
    clients: LIVE.filter((c) => c.active),
    smartleadCampaigns: [
      { id: 4289737, name: 'Ciotola | Owners', client_id: 345263, tags: CIOTOLA_TAGS },
      { id: 4287124, name: 'SG | Owners', client_id: 345263, tags: [{ tag_name: 'sg-owner:salesglider' }] },
      { id: 4041408, name: 'Insight | IT', client_id: 582890, tags: [{ tag_name: 'sg-owner:insight' }] },
    ],
    smartleadClients: [{ id: 345263, name: 'SalesGlider' }],
  });
  const ids = owned.map((c) => c.id);
  assert.ok(!ids.includes(4289737), 'Ciotola campaign attributed to SalesGlider');
  assert.ok(ids.includes(4287124));
  assert.ok(ids.includes(4041408), 'insight → SalesGlider');
});

test('poller: Ciotola rows on the agency inbox are skipped as owner_tag_inactive even with an env legacy owner', async () => {
  const roster = LIVE.map((c, i) => ({ ...c, slack_bot_token: `xoxb-t-${i}`, smartlead_api_key: null }));
  const old = '2020-01-01T00:00:00.000Z';
  const campaigns = new Map([
    ['4289737', { name: 'Ciotola | Owners', tags: CIOTOLA_TAGS }],
    ['4287124', { name: 'SG | Owners', tags: [{ tag_name: 'sg-owner:salesglider' }] }],
  ]);
  const inboxRows = [...campaigns.keys()].map((cid, i) => ({
    email_campaign_id: Number(cid), email_campaign_name: campaigns.get(cid).name, email_lead_id: 500 + i,
    lead_email: `x${i}@example.org`, last_reply_time: old,
    email_history: [{ type: 'REPLY', time: old, email_body: 'yes', from: `x${i}@example.org` }],
  }));
  const sl = H.installSmartleadFetch({ campaigns, inboxRows });
  H.installDb(roster);
  process.env.SMARTLEAD_MASTER_OWNER_SLUG = 'salesglider';
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a);
  try {
    delete require.cache[require.resolve('../src/services/smartlead-poller')];
    await require('../src/services/smartlead-poller').pollSmartleadReplies();
  } finally { console.log = orig; sl.restore(); delete process.env.SMARTLEAD_MASTER_OWNER_SLUG; }
  const scan = logs.find((a) => a[0] === '[SmartLeadPoll] Client scan complete');
  assert.deepStrictEqual(scan[1].skipReasons, { owner_tag_inactive: 1, older_than_lookback: 1 });
  // Tags were read with include_tags=true and the master key.
  const tagReads = sl.smartleadCalls().filter((c) => /\/campaigns\/\d+$/.test(c.path));
  assert.ok(tagReads.length >= 2 && tagReads.every((c) => c.includeTags && c.apiKey === H.MASTER));
});

// ─── 4. Nurture ──────────────────────────────────────────────────────────────

test('nurture uses the master key, not NURTURE_SMARTLEAD_API_KEY (the SalesGlider workspace key being deleted)', () => {
  const { smartleadKeyFor } = require('../src/services/nurture-day30');
  const client = { id: SG.id, smartlead_api_key: 'REVOKED-SG' };
  assert.strictEqual(smartleadKeyFor(client, { SMARTLEAD_MASTER_API_KEY: 'M', NURTURE_SMARTLEAD_API_KEY: 'SG-WS' }), 'M');
  assert.strictEqual(smartleadKeyFor(client, { SMARTLEAD_API_KEY: 'A', NURTURE_SMARTLEAD_API_KEY: 'SG-WS' }), 'A');
  assert.strictEqual(smartleadKeyFor({ id: 'x', smartlead_api_key: null }, { SMARTLEAD_MASTER_API_KEY: 'M' }), 'M');
  // Only with no agency key at all does the dedicated key apply.
  assert.strictEqual(smartleadKeyFor(client, { NURTURE_SMARTLEAD_API_KEY: 'SG-WS' }), 'SG-WS');
});

test('nurture approve path no longer special-cases NURTURE_SMARTLEAD_API_KEY', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/nurture-day30'), 'utf8');
  const approve = src.slice(src.indexOf('async function approveTouch'), src.indexOf('async function skipTouch'));
  assert.ok(!/NURTURE_SMARTLEAD_API_KEY/.test(approve));
  assert.ok(/smartleadKeyFor\(keyed, env\)/.test(approve));
});

// ─── 5. One master poll target ───────────────────────────────────────────────

test('every client key null, flag false (incl. a brand-new client) → exactly one master poll target', () => {
  const rows = LIVE.map((c) => ({ ...c, smartlead_api_key: null, smartlead_use_master_key: false }));
  rows.push({ id: 'brand-new', name: 'Brand New Co', active: true, smartlead_api_key: null, smartlead_use_master_key: false });
  const targets = routing.pollTargetsFromClients(rows, { SMARTLEAD_MASTER_API_KEY: H.MASTER });
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].mode, 'master');
  assert.strictEqual(targets[0].apiKey, H.MASTER);
  assert.strictEqual(routing.withSmartleadKey(rows[rows.length - 1], { SMARTLEAD_MASTER_API_KEY: H.MASTER }).smartlead_api_key, H.MASTER);
});

// ─── 7. Poll budget ──────────────────────────────────────────────────────────

test('poll budget: master scan defaults to 200 rows in pages of 20; per-key scans keep 40/10; env overrides', () => {
  const { pollScanBudget } = require('../src/services/smartlead-poller');
  assert.deepStrictEqual(pollScanBudget({ _pollMode: 'master' }, {}), { pageLimit: 20, maxReplies: 200 });
  assert.deepStrictEqual(pollScanBudget({ _pollMode: 'client' }, {}), { pageLimit: 10, maxReplies: 40 });
  assert.deepStrictEqual(pollScanBudget({ _pollMode: 'master' }, { SMARTLEAD_POLL_MAX_REPLIES: '60' }), { pageLimit: 20, maxReplies: 60 });
  assert.deepStrictEqual(pollScanBudget({ _pollMode: 'master' }, { SMARTLEAD_POLL_PAGE_LIMIT: '50' }), { pageLimit: 20, maxReplies: 200 });
});

test('poller scans 200 agency-inbox rows per cycle in 10 requests of 20', async () => {
  const roster = LIVE.map((c, i) => ({ ...c, slack_bot_token: `xoxb-t-${i}`, smartlead_api_key: null }));
  const old = '2020-01-01T00:00:00.000Z';
  const campaigns = new Map([['4287124', { name: 'SG | Owners', tags: [{ tag_name: 'sg-owner:salesglider' }] }]]);
  const inboxRows = Array.from({ length: 250 }, (_, i) => ({
    email_campaign_id: 4287124, email_lead_id: 1000 + i, lead_email: `r${i}@example.org`, last_reply_time: old,
    email_history: [{ type: 'REPLY', time: old, email_body: 'ok', from: `r${i}@example.org` }],
  }));
  const sl = H.installSmartleadFetch({ campaigns, inboxRows });
  H.installDb(roster);
  delete process.env.SMARTLEAD_POLL_MAX_REPLIES;
  delete process.env.SMARTLEAD_POLL_PAGE_LIMIT;
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a);
  try {
    delete require.cache[require.resolve('../src/services/smartlead-poller')];
    await require('../src/services/smartlead-poller').pollSmartleadReplies();
  } finally { console.log = orig; sl.restore(); }
  const inbox = sl.smartleadCalls().filter((c) => c.path.endsWith('/master-inbox/inbox-replies'));
  assert.strictEqual(inbox.length, 10);
  for (const c of inbox) assert.strictEqual(JSON.parse(c.body).limit, 20);
  const scan = logs.find((a) => a[0] === '[SmartLeadPoll] Client scan complete');
  assert.strictEqual(scan[1].scanned, 200);
});
