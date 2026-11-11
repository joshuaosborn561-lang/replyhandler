/**
 * Campaign → client routing for one Smartlead agency account.
 *
 * Order, when a campaign id is present:
 *   1. Smartlead tag `sg-owner:<slug>` (OWNER_SLUG_CLIENTS). A TAGGED campaign
 *      goes to its tag's active owner or is DROPPED (owner inactive, no client,
 *      conflicting tags). Steps 2–4 apply only to a campaign with no sg-owner
 *      tag (Nov 11 2026: Ciotola cards landed in SalesGlider's channel).
 *      A failed tag lookup allows step 2 only.
 *   2. smartlead_campaign_routes (campaign_id → client uuid)
 *   3. Campaign-title heuristic (leading "Client | …" segment, same aliases as booking)
 *   4. On a webhook URL, the client the URL names. On the agency inbox, the
 *      single client that still stores the agency key, else the client named
 *      by SMARTLEAD_MASTER_OWNER_SLUG, otherwise no client — a reply is not
 *      posted to a guessed Slack channel. (Per-client inboxes are scanned only
 *      when no agency key is configured.)
 *
 * Tags win over routes and titles. Every Smartlead call uses the env agency
 * key (SMARTLEAD_MASTER_API_KEY, else SMARTLEAD_API_KEY) whenever it is set,
 * whatever clients.smartlead_api_key holds (Josh, Nov 11 2026: per-client keys
 * are being deleted and may be revoked before the rows are cleared). A stored
 * key is only a fallback when no agency key is configured. Stored values are
 * never updated here.
 *
 * Mailbox isolation (Ciotola / JEREMY-CIOTOLA allowlists and prefixes) is not
 * part of owner tags and is not changed by this module.
 */
const db = require('../db');
const { CLIENT_SLUG_ALIASES, aliasSlug } = require('./booking-bridge');

const TTL_MS = 60 * 1000;
let cache = { at: 0, map: null };

/**
 * Every live `sg-owner:<slug>` tag (Smartlead tag catalog, Nov 11 2026) → the
 * `clients.name` values that own it. Explicit on purpose: a tag in this table
 * resolves only to these names. `[]` = known tag with no ReplyHandler client.
 * A slug not listed here falls back to the client-name heuristic
 * (normalized name / booking alias), so a new client still routes.
 *
 * Keys are compared with normSlug, so `deeproots` = `deep_roots`.
 */
const OWNER_SLUG_CLIENTS = {
  bcp: ['Bolder Cyber Partners', 'BCP'],
  bpltg: ['BPLTG'],
  ciotola: ['Ciotola', 'Jeremy Ciotola'],
  cornerstone: ['Cornerstone', 'Cornerstone Earthworks'],
  culture_fits: ['Culture Fits'],
  deeproots: ['Deep Roots'],
  emcor: ['Emcor'],
  goliath: ['Goliath', 'Goliath Cybersecurity', 'Goliath Solutions Group'],
  // ASSUMPTION (Josh to confirm): Insight (Smartlead client 582890) is Josh's
  // own book; its replies belong in #salesglider-insight-ai-replies, i.e. the
  // SalesGlider client. There is no Insight clients row.
  insight: ['SalesGlider'],
  msrs: ['MSRS'],
  nexus: ['Nexus'],
  nieto: ['Nieto'],
  nutter: ['Nutter', 'Nutter Group'],
  parlay: ['Parlay Tech'],
  peterson: ['Roofs By Peterson'],
  positive: [],
  powergryd: ['PowerGryd'],
  salesglider: ['SalesGlider'],
  // Routing only. TechEvo booking stays retired (booking-bridge RETIRED_BOOKING_BRIDGE_SLUGS).
  techevo: ['TechEvolution', 'Tech Evolution', 'TechEvo'],
  vasco: ['Vasco Warranty', 'Vasco Warranty Management'],
  vector: ['Vector Energy Group', 'Vector'],
  virtual_pulsar: ['Virtual Pulsar'],
};

const TITLE_SEGMENT_SKIP = new Set([
  'intro', 'owners', 'owner', 'campaign', 'campaigns', 'test', 'copy', 'new', 'tickets', 'calls',
]);

const NAME_SUFFIXES = new Set(['group', 'inc', 'llc', 'co', 'company', 'energygroup']);

function resetCampaignRouteCache() {
  cache = { at: 0, map: null };
}

function normSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function masterKey(env = process.env) {
  return String(env.SMARTLEAD_MASTER_API_KEY || env.SMARTLEAD_API_KEY || '').trim();
}

function ownerSlugTable() {
  return { ...CLIENT_SLUG_ALIASES, ...OWNER_SLUG_CLIENTS };
}

function explicitOwnerNames(slug) {
  const want = normSlug(slug);
  for (const [key, names] of Object.entries(OWNER_SLUG_CLIENTS)) {
    if (normSlug(key) === want) return names;
  }
  return null;
}

function slugsForClient(client) {
  const set = new Set();
  const name = String(client?.name || '');
  if (normSlug(name)) set.add(normSlug(name));
  const aliased = aliasSlug(name);
  if (aliased) set.add(normSlug(aliased));
  for (const [slug, names] of Object.entries(ownerSlugTable())) {
    if ((names || []).some((n) => normSlug(n) === normSlug(name))) set.add(normSlug(slug));
  }
  return set;
}

function pickPreferred(clients) {
  return [...clients].sort((a, b) => (
    String(b.name || '').length - String(a.name || '').length
    || String(a.id).localeCompare(String(b.id))
  ))[0] || null;
}

/**
 * Owner of one sg-owner slug among `clients` (active and inactive rows allowed).
 * status: 'active' (client set) | 'inactive' (owner row exists, inactive) | 'no_client'.
 */
function resolveOwnerSlug(slug, clients) {
  const want = normSlug(slug);
  if (!want) return { status: 'no_client', client: null };
  const explicit = explicitOwnerNames(slug);
  const rows = (clients || []).filter(Boolean);
  const candidates = explicit
    ? rows.filter((c) => explicit.some((n) => normSlug(n) === normSlug(c.name)))
    : rows.filter((c) => slugsForClient(c).has(want));
  const active = candidates.filter((c) => c.active !== false);
  if (active.length) return { status: 'active', client: active.length === 1 ? active[0] : pickPreferred(active) };
  if (candidates.length) return { status: 'inactive', client: null };
  return { status: 'no_client', client: null };
}

function clientForSlug(slug, clients) {
  return resolveOwnerSlug(slug, clients).client;
}

/**
 * Owner decided by the campaign's sg-owner tags alone.
 *   { tagged: false }                       → no sg-owner tag; fallbacks may apply
 *   { tagged: true, client }                → every tag names this one active client
 *   { tagged: true, client: null, reason }  → drop: tag owner inactive / unknown / conflicting
 */
function ownerFromTags(tags, clients) {
  const slugs = ownerSlugsFromTags(tags || []);
  if (!slugs.length) return { tagged: false };
  const results = slugs.map((slug) => ({ slug, ...resolveOwnerSlug(slug, clients) }));
  const ids = new Set(results.filter((r) => r.client).map((r) => String(r.client.id)));
  if (results.every((r) => r.client) && ids.size === 1) {
    return { tagged: true, client: results[0].client, slugs };
  }
  let reason = 'owner_tag_no_client';
  if (slugs.length > 1) reason = 'owner_tag_conflict';
  else if (results[0].status === 'inactive') reason = 'owner_tag_inactive';
  return { tagged: true, client: null, slugs, reason };
}

function nameExtends(compact, key) {
  if (!compact || !key) return false;
  if (compact === key) return true;
  if (!compact.startsWith(key)) return false;
  return NAME_SUFFIXES.has(compact.slice(key.length));
}

function titleLabels(client) {
  const labels = [client.name];
  for (const [slug, names] of Object.entries(ownerSlugTable())) {
    if (slugsForClient(client).has(normSlug(slug))) labels.push(slug, ...(names || []));
  }
  return labels;
}

function scoreSegment(segment, client) {
  const segN = normSlug(segment);
  if (segN.length < 3 || TITLE_SEGMENT_SKIP.has(segN)) return 0;
  let score = 0;
  for (const label of titleLabels(client)) {
    const n = normSlug(label);
    if (n.length < 3 || TITLE_SEGMENT_SKIP.has(n)) continue;
    if (segN === n) score = Math.max(score, 100 + n.length);
    else if (nameExtends(segN, n) || nameExtends(n, segN)) score = Math.max(score, 50 + Math.min(n.length, segN.length));
  }
  if (slugsForClient(client).has(segN)) score = Math.max(score, 90 + segN.length);
  const segSlug = aliasSlug(segment);
  const clientSlug = aliasSlug(client.name);
  if (segSlug && clientSlug && normSlug(segSlug) === normSlug(clientSlug)) {
    score = Math.max(score, 80 + normSlug(segSlug).length);
  }
  return score;
}

/** Leading "Vector | …" / "EMCOR" / "TechEvo | Intro" style titles. Unique match only. */
function clientFromCampaignTitle(title, clients) {
  const segments = String(title || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return null;
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const client of clients || []) {
    if (!client || client.active === false) continue;
    let score = 0;
    for (const seg of segments) score = Math.max(score, scoreSegment(seg, client));
    if (score <= 0) continue;
    if (score > bestScore) {
      best = client;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && client.id !== best?.id) {
      tie = true;
    }
  }
  if (tie) return null;
  return best;
}

function tagsFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const keys = ['tags', 'campaign_tags', 'email_campaign_tags', 'tag_list'];
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key];
  }
  if (record.campaign && Array.isArray(record.campaign.tags)) return record.campaign.tags;
  return null;
}

function ownerSlugsFromTags(tags) {
  const slugs = [];
  for (const tag of tags || []) {
    const name = typeof tag === 'string'
      ? tag
      : (tag && (tag.name || tag.tag || tag.tag_name || tag.label)) || '';
    const match = String(name).trim().match(/^sg-owner:([a-z0-9_]+)$/i);
    if (match) slugs.push(match[1].toLowerCase());
  }
  return [...new Set(slugs)];
}

async function loadRoutes(q) {
  if (cache.map && Date.now() - cache.at < TTL_MS) return cache.map;
  const map = new Map();
  try {
    const { rows } = await q('SELECT campaign_id, client_id FROM smartlead_campaign_routes', []);
    for (const r of rows) map.set(String(r.campaign_id), r.client_id);
  } catch (err) {
    console.warn('[CampaignRouting] route load failed; treating as unmapped', { err: err.message });
    return map;
  }
  cache = { at: Date.now(), map };
  return map;
}

/**
 * Every client row, active or not. Inactive rows are never chosen as an owner;
 * they are loaded so a tag whose owner is inactive is reported as such.
 */
async function loadRoutingClients(q) {
  try {
    const { rows } = await q('SELECT * FROM clients', []);
    return rows || [];
  } catch (err) {
    console.warn('[CampaignRouting] client load failed', { err: err.message });
    return [];
  }
}

/**
 * Runtime Smartlead key, master first. Never persisted.
 * With an agency key in env, every client uses it, even one whose row still
 * stores its own key (that key may already be revoked). The stored key is a
 * fallback only when no agency key is configured.
 * smartlead_use_master_key is not read: a new client defaults to the agency key.
 */
function withSmartleadKey(client, env = process.env) {
  if (!client) return client;
  const key = masterKey(env);
  if (!key || client.smartlead_api_key === key) return client;
  return { ...client, smartlead_api_key: key };
}

function finish(target, sourceClient, via, deps) {
  const env = deps.env || process.env;
  const master = masterKey(env);
  const key = master || target.smartlead_api_key || sourceClient?.smartlead_api_key || null;
  if (target === sourceClient && key === sourceClient.smartlead_api_key) return sourceClient;
  return { ...target, smartlead_api_key: key || null, _ownerVia: via };
}

/**
 * Agency-inbox fallback owner for a row with no tag, route, or title.
 * 1. The single active client whose stored key equals the agency key (pre-cut).
 * 2. SMARTLEAD_MASTER_OWNER_SLUG, when set (e.g. `salesglider`), so that
 *    fallback survives clearing the stored keys. Unset = no guessed channel.
 */
function legacyOwnerFor(active, master, env = process.env) {
  const legacyRows = active.filter((c) => String(c.smartlead_api_key || '').trim() === master);
  if (legacyRows.length === 1) return legacyRows[0];
  const slug = String(env.SMARTLEAD_MASTER_OWNER_SLUG || '').trim();
  if (slug) return clientForSlug(slug, active);
  return null;
}

/**
 * With an agency key: one agency inbox scan, nothing else. Stored per-client
 * keys are not scanned (they may be revoked; their sub-client campaigns are
 * visible to the agency key). Without an agency key: one scan per distinct
 * stored key, as before.
 */
function pollTargetsFromClients(clients, env = process.env) {
  const master = masterKey(env);
  const active = (clients || []).filter((c) => c && c.active !== false);
  const targets = [];
  if (master) {
    const legacy = legacyOwnerFor(active, master, env);
    const base = legacy || {
      id: null,
      name: '(smartlead master)',
      slack_channel_id: null,
      slack_bot_token: null,
    };
    targets.push({
      mode: 'master',
      apiKey: master,
      client: {
        ...base,
        smartlead_api_key: master,
        _pollMode: 'master',
        _legacyOwner: legacy,
      },
    });
    return targets;
  }
  const seen = new Set();
  for (const client of active) {
    const key = String(client.smartlead_api_key || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    targets.push({
      mode: 'client',
      apiKey: key,
      client: { ...client, _pollMode: 'client', _legacyOwner: null },
    });
  }
  return targets;
}

/**
 * Swap the source client for the campaign's owner. Returns the source object
 * unchanged when nothing maps it (per-client inbox / webhook URL). Returns null
 * on an agency-inbox row that has no tag, route, title, or legacy key owner.
 */
async function routeClientForCampaign(sourceClient, campaignId, deps = {}) {
  const q = deps.query || ((sql, p) => db.query(sql, p));
  if (!sourceClient || campaignId == null || campaignId === '') return sourceClient;
  const mode = deps.mode || sourceClient._pollMode || 'client';
  const env = deps.env || process.env;
  let clients = null;
  const needClients = async () => {
    if (!clients) clients = Array.isArray(deps.clients) ? deps.clients : await loadRoutingClients(q);
    return clients;
  };

  // tagsUnknown: a lookup was attempted and failed. That is not "untagged":
  // only an explicit route may place the campaign; title / URL / legacy may not.
  let tagsUnknown = false;
  let tags = Array.isArray(deps.tags) ? deps.tags : null;
  if (!tags && typeof deps.fetchTags === 'function') {
    try {
      const fetched = await deps.fetchTags(campaignId);
      if (Array.isArray(fetched)) tags = fetched;
      else tagsUnknown = true;
    } catch (err) {
      console.warn('[CampaignRouting] tag fetch failed', { campaignId, err: err.message });
      tagsUnknown = true;
    }
  }
  const drop = (reason, extra = {}) => {
    console.warn('[CampaignRouting] campaign dropped, not posted to any channel', {
      campaignId, reason, source: sourceClient.id || sourceClient.name || null, ...extra,
    });
    if (typeof deps.onDrop === 'function') deps.onDrop(reason);
    return null;
  };

  // A tagged campaign belongs to its tag owner or to nobody (Nov 11 2026,
  // Ciotola cards landing in SalesGlider's channel). No route / title /
  // fetching-client / legacy fallback for a tagged campaign.
  const byTag = ownerFromTags(tags || [], await needClients());
  if (byTag.tagged) {
    if (!byTag.client) return drop(byTag.reason, { slugs: byTag.slugs });
    if (byTag.client.id === sourceClient.id) return finish(sourceClient, sourceClient, 'tag', { ...deps, env, campaignId });
    return finish(byTag.client, sourceClient, 'tag', { ...deps, env, campaignId });
  }

  const routes = deps.routes || await loadRoutes(q);
  const targetId = routes.get(String(campaignId));
  if (targetId && targetId !== sourceClient.id) {
    let target = (Array.isArray(deps.clients) ? deps.clients : []).find((c) => c.id === targetId);
    if (!target) {
      try {
        const { rows: [row] } = await q('SELECT * FROM clients WHERE id = $1', [targetId]);
        target = row;
      } catch (err) {
        console.warn('[CampaignRouting] routed client lookup failed', { err: err.message });
      }
    }
    if (target && target.active !== false) {
      return finish(target, sourceClient, 'route', { ...deps, env, campaignId });
    }
  } else if (targetId && targetId === sourceClient.id) {
    return finish(sourceClient, sourceClient, 'route', { ...deps, env, campaignId });
  }

  if (tagsUnknown) return drop('owner_tags_unavailable');

  if (deps.allowTitle !== false && deps.campaignName) {
    const titled = clientFromCampaignTitle(deps.campaignName, await needClients());
    if (titled && titled.id) {
      if (titled.id === sourceClient.id) {
        return finish(sourceClient, sourceClient, 'title', { ...deps, env, campaignId });
      }
      return finish(titled, sourceClient, 'title', { ...deps, env, campaignId });
    }
  }

  if (mode === 'master') {
    const legacy = deps.legacyOwner || sourceClient._legacyOwner || null;
    if (legacy && legacy.id && legacy.active !== false) {
      if (sourceClient.id === legacy.id) return sourceClient;
      return finish(legacy, sourceClient, 'legacy', { ...deps, env, campaignId });
    }
    return null;
  }
  return sourceClient;
}

/**
 * Runtime key for a send / history / nurture call: the agency key whenever it
 * is set, regardless of campaign ownership or a stored per-client key. The
 * campaign id is kept in the signature for callers; no Smartlead call is made.
 */
async function applyAgencyKey(client, campaignId, deps = {}) {
  void campaignId;
  return withSmartleadKey(client, deps.env || process.env);
}

module.exports = {
  withSmartleadKey,
  routeClientForCampaign,
  resetCampaignRouteCache,
  loadRoutes,
  masterKey,
  pollTargetsFromClients,
  applyAgencyKey,
  tagsFromRecord,
  ownerSlugsFromTags,
  clientForSlug,
  resolveOwnerSlug,
  ownerFromTags,
  OWNER_SLUG_CLIENTS,
  clientFromCampaignTitle,
  slugsForClient,
  legacyOwnerFor,
};
