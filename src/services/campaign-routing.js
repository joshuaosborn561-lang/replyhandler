/**
 * Campaign → client routing for one Smartlead agency account.
 *
 * Order, when a campaign id is present:
 *   1. Smartlead tag `sg-owner:<slug>` (slug matches topup.client_map.client_tag)
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

/** Slugs Deliverability writes that booking aliases name differently, plus clients with no booking alias yet. */
const EXTRA_OWNER_SLUGS = {
  bcp: ['Bolder Cyber Partners', 'BCP'],
  culture_fits: ['Culture Fits'],
  bpltg: ['BPLTG'],
  ciotola: ['Ciotola', 'Jeremy Ciotola'],
  nexus: ['Nexus'],
  virtual_pulsar: ['Virtual Pulsar'],
  // Client row is "TechEvolution"; Deliverability tags `sg-owner:techevo`.
  techevo: ['TechEvolution', 'Tech Evolution', 'TechEvo'],
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
  return { ...CLIENT_SLUG_ALIASES, ...EXTRA_OWNER_SLUGS };
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

function clientForSlug(slug, clients) {
  const want = normSlug(slug);
  if (!want) return null;
  const matched = (clients || []).filter((c) => c && c.active !== false && slugsForClient(c).has(want));
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) return pickPreferred(matched);
  return null;
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

async function loadActiveClients(q) {
  try {
    const { rows } = await q('SELECT * FROM clients WHERE active IS DISTINCT FROM false', []);
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
    if (!clients) clients = Array.isArray(deps.clients) ? deps.clients : await loadActiveClients(q);
    return clients;
  };

  let tags = Array.isArray(deps.tags) ? deps.tags : null;
  if (!tags && typeof deps.fetchTags === 'function') {
    try {
      const fetched = await deps.fetchTags(campaignId);
      tags = Array.isArray(fetched) ? fetched : [];
    } catch (err) {
      console.warn('[CampaignRouting] tag fetch failed', { campaignId, err: err.message });
      tags = [];
    }
  }
  const slugs = ownerSlugsFromTags(tags || []);
  if (slugs.length > 1) {
    console.warn('[CampaignRouting] campaign has conflicting sg-owner tags', { campaignId, slugs });
  } else if (slugs.length === 1) {
    const tagged = clientForSlug(slugs[0], await needClients());
    if (tagged && tagged.id && tagged.id !== sourceClient.id) {
      return finish(tagged, sourceClient, 'tag', { ...deps, env, campaignId });
    }
    if (tagged && tagged.id === sourceClient.id) {
      return finish(sourceClient, sourceClient, 'tag', { ...deps, env, campaignId });
    }
    console.warn('[CampaignRouting] sg-owner tag did not match a client', { campaignId, slug: slugs[0] });
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
  clientFromCampaignTitle,
  slugsForClient,
  legacyOwnerFor,
};
