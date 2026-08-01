#!/usr/bin/env node
/**
 * Seed explicit SmartLead campaign ownership from each client's dedicated key.
 * Run after migration 020. Conflicts are logged and never overwritten.
 */

const db = require('../src/db');
const { learnRoute } = require('../src/services/smartlead-campaign-route');

const BASE = 'https://server.smartlead.ai/api/v1';

async function listCampaigns(apiKey) {
  const res = await fetch(
    `${BASE}/campaigns/?api_key=${encodeURIComponent(apiKey)}`
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`campaign list failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
}

async function main() {
  const { rows: clients } = await db.query(
    `SELECT id, name, smartlead_api_key
       FROM clients
      WHERE active IS DISTINCT FROM false
        AND smartlead_api_key IS NOT NULL
        AND btrim(smartlead_api_key) <> ''
      ORDER BY name`
  );

  const totals = { clients: clients.length, campaigns: 0, routed: 0, conflicts: 0, failed: 0 };
  for (const client of clients) {
    try {
      const campaigns = await listCampaigns(client.smartlead_api_key);
      totals.campaigns += campaigns.length;
      for (const campaign of campaigns) {
        const result = await learnRoute({
          campaignId: campaign.id || campaign.campaign_id,
          clientId: client.id,
          campaignName: campaign.name || campaign.campaign_name || null,
          source: 'manual',
        });
        if (result.ok) totals.routed++;
        else if (result.reason === 'route_conflict') totals.conflicts++;
      }
      console.log('[RouteSeed] Client complete', {
        client: client.name,
        campaigns: campaigns.length,
      });
    } catch (err) {
      totals.failed++;
      console.error('[RouteSeed] Client failed', { client: client.name, err: err.message });
    }
  }
  console.log('[RouteSeed] Complete', totals);
  if (totals.failed) process.exitCode = 1;
}

main()
  .finally(() => db.end())
  .catch((err) => {
    console.error('[RouteSeed] Fatal', err);
    process.exit(1);
  });
