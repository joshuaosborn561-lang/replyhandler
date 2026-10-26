/**
 * Per-campaign client routing for shared SmartLead accounts.
 *
 * Unmapped campaigns and clients without smartlead_use_master_key are returned
 * as the SAME object, untouched — existing behavior does not change.
 */
const db = require('../db');

const TTL_MS = 60 * 1000;
let cache = { at: 0, map: null };

function resetCampaignRouteCache() { cache = { at: 0, map: null }; }

async function loadRoutes(q) {
  if (cache.map && Date.now() - cache.at < TTL_MS) return cache.map;
  const map = new Map();
  try {
    const { rows } = await q('SELECT campaign_id, client_id FROM smartlead_campaign_routes', []);
    for (const r of rows) map.set(String(r.campaign_id), r.client_id);
  } catch (err) {
    // Table missing / DB hiccup: behave as unmapped.
    console.warn('[CampaignRouting] route load failed; treating as unmapped', { err: err.message });
    return map;
  }
  cache = { at: Date.now(), map };
  return map;
}

function masterKey(env = process.env) {
  return String(env.SMARTLEAD_MASTER_API_KEY || '').trim();
}

/** Fill the SmartLead key at runtime for master-key clients. Never persisted. */
function withSmartleadKey(client, env = process.env) {
  if (!client || client.smartlead_api_key || client.smartlead_use_master_key !== true) return client;
  const key = masterKey(env);
  return key ? { ...client, smartlead_api_key: key } : client;
}

/**
 * Swap the source client for the campaign's routed client. SmartLead calls keep
 * the source's key (it is the account the reply arrived on).
 */
async function routeClientForCampaign(sourceClient, campaignId, deps = {}) {
  const q = deps.query || ((sql, p) => db.query(sql, p));
  if (!sourceClient || campaignId == null || campaignId === '') return sourceClient;
  const routes = deps.routes || await loadRoutes(q);
  const targetId = routes.get(String(campaignId));
  if (!targetId || targetId === sourceClient.id) return sourceClient;
  const { rows: [target] } = await q('SELECT * FROM clients WHERE id = $1', [targetId]);
  if (!target || target.active === false) return sourceClient;
  const routed = withSmartleadKey(target, deps.env);
  return {
    ...routed,
    smartlead_api_key: routed.smartlead_api_key || sourceClient.smartlead_api_key,
  };
}

module.exports = { withSmartleadKey, routeClientForCampaign, resetCampaignRouteCache, loadRoutes };
