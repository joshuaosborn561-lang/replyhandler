const db = require('../db');

function id(value) {
  return value == null ? '' : String(value).trim();
}

async function learnRoute({ campaignId, clientId, campaignName, source }) {
  const campaign = id(campaignId);
  const client = id(clientId);
  if (!campaign || !client) return { ok: false, reason: 'missing_route_ids' };

  const { rows } = await db.query(
    `INSERT INTO smartlead_campaign_routes
       (campaign_id, client_id, campaign_name, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (campaign_id) DO UPDATE
       SET campaign_name = COALESCE(EXCLUDED.campaign_name, smartlead_campaign_routes.campaign_name),
           source = EXCLUDED.source,
           updated_at = now()
       WHERE smartlead_campaign_routes.client_id = EXCLUDED.client_id
     RETURNING campaign_id, client_id, campaign_name, source`,
    [campaign, client, campaignName || null, source]
  );
  if (rows[0]) return { ok: true, route: rows[0] };

  const { rows: existing } = await db.query(
    `SELECT campaign_id, client_id, campaign_name, source
       FROM smartlead_campaign_routes
      WHERE campaign_id = $1`,
    [campaign]
  );
  console.error('[SmartLeadRoute] Route conflict — refusing to overwrite', {
    campaignId: campaign,
    attemptedClientId: client,
    existingClientId: existing[0]?.client_id || null,
    source,
  });
  return { ok: false, reason: 'route_conflict', route: existing[0] || null };
}

async function resolveClientForCampaign(campaignId) {
  const campaign = id(campaignId);
  if (!campaign) return null;
  const { rows } = await db.query(
    `SELECT c.*, r.campaign_name AS routed_campaign_name
       FROM smartlead_campaign_routes r
       JOIN clients c ON c.id = r.client_id
      WHERE r.campaign_id = $1
        AND c.active IS DISTINCT FROM false
      LIMIT 1`,
    [campaign]
  );
  return rows[0] || null;
}

async function loadRouteMap() {
  const { rows } = await db.query(
    `SELECT r.campaign_id, c.*
       FROM smartlead_campaign_routes r
       JOIN clients c ON c.id = r.client_id
      WHERE c.active IS DISTINCT FROM false`
  );
  return new Map(rows.map((row) => [String(row.campaign_id), row]));
}

async function listCampaigns(apiKey) {
  const res = await fetch(
    `https://server.smartlead.ai/api/v1/campaigns/?api_key=${encodeURIComponent(apiKey)}`
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`SmartLead campaign list failed (${res.status}): ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
}

let seededThisProcess = false;

/** Seed only campaigns visible to exactly one dedicated (non-master) key. */
async function seedRoutesFromDedicatedKeys() {
  if (seededThisProcess) return { skipped: 'already_seeded' };
  seededThisProcess = true;

  const master = String(process.env.SMARTLEAD_MASTER_API_KEY || '').trim();
  const { rows: clients } = await db.query(
    `SELECT id, name, smartlead_api_key
       FROM clients
      WHERE active IS DISTINCT FROM false
        AND smartlead_api_key IS NOT NULL
        AND btrim(smartlead_api_key) <> ''`
  );
  const owners = new Map();
  for (const client of clients) {
    const key = String(client.smartlead_api_key || '').trim();
    if (!key || (master && key === master)) continue;
    try {
      for (const campaign of await listCampaigns(key)) {
        const campaignId = id(campaign.id || campaign.campaign_id);
        if (!campaignId) continue;
        if (!owners.has(campaignId)) owners.set(campaignId, []);
        owners.get(campaignId).push({
          client,
          name: campaign.name || campaign.campaign_name || null,
        });
      }
    } catch (err) {
      console.error('[SmartLeadRoute] Dedicated-key seed failed', {
        client: client.name,
        err: err.message,
      });
    }
  }

  const totals = { routed: 0, ambiguous: 0 };
  for (const [campaignId, candidates] of owners) {
    const uniqueClients = new Map(candidates.map((candidate) => [String(candidate.client.id), candidate]));
    if (uniqueClients.size !== 1) {
      totals.ambiguous++;
      console.error('[SmartLeadRoute] Ambiguous dedicated-key ownership — skipping', {
        campaignId,
        clients: [...uniqueClients.values()].map((candidate) => candidate.client.name),
      });
      continue;
    }
    const candidate = [...uniqueClients.values()][0];
    const result = await learnRoute({
      campaignId,
      clientId: candidate.client.id,
      campaignName: candidate.name,
      source: 'seed_api',
    });
    if (result.ok) totals.routed++;
  }
  console.log('[SmartLeadRoute] Dedicated-key seed complete', totals);
  return totals;
}

async function setManualRoute({ campaignId, clientId, campaignName }) {
  const { rows } = await db.query(
    `INSERT INTO smartlead_campaign_routes
       (campaign_id, client_id, campaign_name, source)
     VALUES ($1, $2, $3, 'manual')
     ON CONFLICT (campaign_id) DO UPDATE
       SET client_id = EXCLUDED.client_id,
           campaign_name = COALESCE(EXCLUDED.campaign_name, smartlead_campaign_routes.campaign_name),
           source = 'manual',
           updated_at = now()
     RETURNING campaign_id, client_id, campaign_name, source`,
    [id(campaignId), id(clientId), campaignName || null]
  );
  return rows[0];
}

module.exports = {
  learnRoute,
  resolveClientForCampaign,
  loadRouteMap,
  seedRoutesFromDedicatedKeys,
  setManualRoute,
};
