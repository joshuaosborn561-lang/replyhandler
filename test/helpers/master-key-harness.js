/**
 * Shared harness for the per-client Smartlead key cut (Nov 11 2026).
 *
 * - Every client row has its per-client Smartlead key null, '' or a revoked
 *   leftover. Only SMARTLEAD_MASTER_API_KEY is valid.
 * - global.fetch is replaced: Smartlead URLs are answered from fixtures and
 *   every api_key is recorded; any other host throws. http/https requests
 *   (axios, Slack WebClient) are blocked so a test can never reach production.
 * - The db pool's query() is replaced with an in-memory router.
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const MASTER = 'MASTER-TEST-KEY';
const REVOKED_PREFIX = 'REVOKED-CLIENT-KEY-';

/** Every client slug that appears in this repo (DECISIONS sg-owner list, routing aliases, tests). */
const CLIENT_FIXTURES = [
  ['salesglider', 'SalesGlider'],
  ['parlay', 'Parlay Tech'],
  ['culture_fits', 'Culture Fits'],
  ['techevo', 'TechEvolution'],
  ['bcp', 'Bolder Cyber Partners'],
  ['peterson', 'Roofs By Peterson'],
  ['goliath', 'Goliath'],
  ['emcor', 'EMCOR'],
  ['powergryd', 'PowerGRYD'],
  ['vector', 'Vector Energy Group'],
  ['nutter', 'Nutter Group'],
  ['bpltg', 'BPLTG'],
  ['ciotola', 'Jeremy Ciotola'],
  ['nexus', 'Nexus'],
  ['virtual_pulsar', 'Virtual Pulsar'],
  ['deep_roots', 'Deep Roots'],
  ['vasco', 'Vasco Warranty'],
  ['cornerstone', 'Cornerstone Earthworks'],
  ['msrs', 'MSRS'],
];

/**
 * Tag slug → the synthetic fixture slug that owns it. `insight` has no client
 * row; its replies go to SalesGlider (#salesglider-insight-ai-replies).
 * ASSUMPTION for Josh to confirm.
 */
const TAG_OWNER = { insight: 'salesglider' };
/** Every live sg-owner tag (Smartlead tag catalog, Nov 11 2026). */
const LIVE_TAGS = [
  'bcp', 'bpltg', 'ciotola', 'cornerstone', 'culture_fits', 'emcor', 'goliath', 'insight', 'nexus',
  'nutter', 'parlay', 'peterson', 'powergryd', 'salesglider', 'techevo', 'vector', 'virtual_pulsar',
  'deeproots', 'nieto', 'msrs', 'positive', 'vasco',
];
function ownerSlug(tagSlug) {
  return TAG_OWNER[tagSlug] || tagSlug;
}

function slugChannel(slug) {
  return `C_${slug.toUpperCase()}`;
}

/** Key states a row can be in during/after the cut. None of them is valid. */
const KEY_STATES = [null, '', undefined, 'REVOKED'];

function buildRoster() {
  return CLIENT_FIXTURES.map(([slug, name], i) => {
    const state = KEY_STATES[i % KEY_STATES.length];
    const row = {
      id: `client-${slug}`,
      name,
      active: true,
      slack_channel_id: slugChannel(slug),
      slack_bot_token: `xoxb-test-${slug}`,
      // Mix the flag: a new client defaults to false and must still work.
      smartlead_use_master_key: i % 2 === 0,
      voice_prompt: '',
      booking_link: null,
      notify_emails: null,
      cc_emails: null,
      heyreach_api_key: null,
    };
    if (state === 'REVOKED') row.smartlead_api_key = `${REVOKED_PREFIX}${slug}`;
    else if (state !== undefined) row.smartlead_api_key = state;
    return row;
  });
}

function setMasterEnv() {
  process.env.SMARTLEAD_MASTER_API_KEY = MASTER;
  delete process.env.SMARTLEAD_API_KEY;
  delete process.env.NURTURE_SMARTLEAD_API_KEY;
  delete process.env.SMARTLEAD_MASTER_OWNER_SLUG;
}

function blockRealNetwork() {
  const deny = (mod) => {
    for (const fn of ['request', 'get']) {
      mod[fn] = (...args) => {
        const target = typeof args[0] === 'string' ? args[0] : (args[0] && (args[0].hostname || args[0].host)) || '?';
        throw new Error(`network blocked in test: ${target}`);
      };
    }
  };
  deny(https);
  // http.request stays usable for 127.0.0.1 only (local express under test).
  const realHttpRequest = http.request;
  http.request = (...args) => {
    const opt = args[0];
    const host = typeof opt === 'string' ? new URL(opt).hostname : (opt && (opt.hostname || opt.host));
    if (host === '127.0.0.1' || host === 'localhost') return realHttpRequest(...args);
    throw new Error(`network blocked in test: ${host}`);
  };
}

/** Slack WebClient that never touches the network (its retry backoff would hang the run). */
function stubSlackWebClient() {
  const resolved = require.resolve('@slack/web-api');
  const real = require(resolved);
  const posts = [];
  const handler = (prefix) => new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : handler(prefix ? `${prefix}.${String(prop)}` : String(prop))),
    apply: async (_t, _this, args) => { posts.push({ method: prefix, args: args[0] }); return { ok: true, ts: '1.1', channel: args[0] && args[0].channel, permalink: 'https://slack.test/p' }; },
  });
  class FakeWebClient { constructor() { return handler(''); } }
  // The package exports WebClient as a getter, so replace the cached module object.
  require.cache[resolved].exports = { ...real, WebClient: FakeWebClient };
  return posts;
}

/**
 * Fake Smartlead over global.fetch.
 * campaigns: Map<campaignId, { tags, name, client_id }>
 */
function installSmartleadFetch({ campaigns = new Map(), inboxRows = [], history = null } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  globalThis.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, opts);
    if (url.hostname !== 'server.smartlead.ai') {
      calls.push({ host: url.hostname, path: url.pathname, blocked: true });
      throw new Error(`network blocked in test: ${url.hostname}`);
    }
    const apiKey = url.searchParams.get('api_key');
    const includeTags = url.searchParams.get('include_tags') === 'true';
    calls.push({ host: url.hostname, path: url.pathname, apiKey, includeTags, method: opts.method || 'GET', body: opts.body || null });
    if (apiKey !== MASTER) return json(401, { message: 'invalid api key' });
    const p = url.pathname.replace(/^\/api\/v1/, '');
    let m;
    if ((m = p.match(/^\/campaigns\/(\d+)\/?$/))) {
      const camp = campaigns.get(String(m[1]));
      if (!camp) return json(404, { message: 'not found' });
      // Live Smartlead: no `tags` field at all unless include_tags=true.
      const row = { id: Number(m[1]), name: camp.name, client_id: camp.client_id ?? null, status: 'ACTIVE' };
      if (includeTags) row.tags = camp.tags;
      return json(200, row);
    }
    if ((m = p.match(/^\/campaigns\/(\d+)\/leads\/(\d+)\/message-history$/))) {
      return json(200, history || { history: [] });
    }
    if (p === '/master-inbox/inbox-replies') {
      const body = JSON.parse(opts.body || '{}');
      const off = Number(body.offset) || 0;
      const lim = Number(body.limit) || 20;
      return json(200, { data: inboxRows.slice(off, off + lim) });
    }
    if (p === '/campaigns' || p === '/campaigns/') {
      return json(200, [...campaigns.entries()].map(([id, c]) => {
        const row = { id: Number(id), name: c.name, status: 'ACTIVE' };
        if (includeTags) row.tags = c.tags;
        return row;
      }));
    }
    if ((m = p.match(/^\/campaigns\/(\d+)\/webhooks$/))) return json(200, []);
    if (p.startsWith('/leads')) return json(200, null);
    return json(200, {});
  };
  return {
    calls,
    smartleadCalls: () => calls.filter((c) => c.host === 'server.smartlead.ai'),
    restore: () => { globalThis.fetch = realFetch; },
  };
}

/** In-memory db router for the queries these paths make. Unknown SQL returns no rows. */
function installDb(roster, { routes = [], onQuery } = {}) {
  const db = require('../../src/db');
  const seen = [];
  db.query = async (sql, params = []) => {
    const s = String(sql);
    seen.push({ sql: s, params });
    if (onQuery) {
      const r = await onQuery(s, params);
      if (r) return r;
    }
    if (/FROM\s+smartlead_campaign_routes/i.test(s)) return { rows: routes };
    if (/FROM\s+clients\s+WHERE\s+id\s*=\s*\$1/i.test(s)) {
      return { rows: roster.filter((c) => c.id === params[0]) };
    }
    if (/FROM\s+clients/i.test(s) && /active/i.test(s)) return { rows: roster.filter((c) => c.active !== false) };
    if (/^\s*SELECT \* FROM clients\s*$/i.test(s)) return { rows: roster };
    return { rows: [], rowCount: 0 };
  };
  db.connect = async () => ({ query: (...a) => db.query(...a), release: () => {} });
  return { db, seen };
}

/** Optional real payloads: /workspace/keycut/fixtures/rh_payloads.json (absent = skipped). */
function loadRealPayloads() {
  const file = process.env.RH_PAYLOADS_FILE || path.join(__dirname, '..', 'fixtures', 'rh_payloads.json');
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : (raw.payloads || raw.entries || []);
}

/**
 * Optional real client roster (no key columns): /workspace/keycut/rh_clients_safe.json.
 * Every row gets a fake Slack token and a null / revoked Smartlead key in memory.
 */
function loadRealRoster() {
  const file = process.env.RH_CLIENTS_FILE || path.join(__dirname, '..', 'fixtures', 'rh_clients_live.json');
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(raw) ? raw : (raw.clients || []);
  return rows.map((r, i) => ({
    ...r,
    slack_bot_token: `xoxb-test-${i}`,
    smartlead_api_key: i % 2 ? null : `${REVOKED_PREFIX}${i}`,
    smartlead_use_master_key: false,
    heyreach_api_key: null,
  }));
}

/**
 * Expected owner for a real fixture entry, or null when it must be DROPPED.
 *   insight → SalesGlider (assumption; no Insight row, channel #salesglider-insight-ai-replies)
 *   ciotola → dropped (client inactive since Nov 11 08:06 CT)
 *   otherwise → the active row named expected_client.
 */
const REAL_OVERRIDES = { insight: { name: 'SalesGlider', channel: 'C0AR02YS268' } };
function expectedRealClient(entry, roster) {
  const o = REAL_OVERRIDES[entry.sg_owner];
  const name = o ? o.name : entry.expected_client;
  if (!name || (!o && entry.expected_client_active_in_db === false)) return null;
  return roster.find((c) => c.active !== false && c.name === name) || null;
}
function expectedRealChannel(entry) {
  const o = REAL_OVERRIDES[entry.sg_owner];
  return o ? o.channel : entry.expected_slack_channel;
}

/** Same shape as the EMAIL_REPLY payloads in test/inbound-canon.test.js. */
function emailReplyPayload({ campaignId, leadId, slug, campaignName }) {
  return {
    event_type: 'EMAIL_REPLY',
    email_campaign_id: campaignId,
    email_campaign_name: campaignName || `Untitled sequence ${campaignId}`,
    email_lead_id: leadId,
    lead_email: `prospect.${slug}@example.org`,
    lead_first_name: 'Pat',
    lead_last_name: slug.replace(/_/g, ''),
    stats_id: `stats-${campaignId}-${leadId}`,
    reply_message: {
      html: '<html><body><p>Yes, this is interesting. Can we talk Tuesday?</p></body></html>',
      message_id: `<msg-${campaignId}-${leadId}@example.org>`,
    },
  };
}

module.exports = {
  MASTER,
  REVOKED_PREFIX,
  CLIENT_FIXTURES,
  slugChannel,
  buildRoster,
  setMasterEnv,
  blockRealNetwork,
  stubSlackWebClient,
  installSmartleadFetch,
  installDb,
  loadRealPayloads,
  loadRealRoster,
  expectedRealClient,
  expectedRealChannel,
  ownerSlug,
  LIVE_TAGS,
  emailReplyPayload,
  path,
};
