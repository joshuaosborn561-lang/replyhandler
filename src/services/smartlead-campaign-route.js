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

module.exports = { learnRoute, resolveClientForCampaign, loadRouteMap };
