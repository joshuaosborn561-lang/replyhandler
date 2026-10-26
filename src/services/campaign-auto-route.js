/**
 * Auto-route new SmartLead campaigns to replyhandler clients by SmartLead client_id.
 *
 * For each active client with smartlead_use_master_key = true and a
 * smartlead_client_id, list campaigns on the master account whose client_id
 * matches and ADD a route + EMAIL_REPLY hook for any campaign not yet routed.
 * Existing routes (to any client) are never changed or removed.
 * No campaign status changes. Cron is opt-in via AUTO_ROUTE_SMARTLEAD_CLIENTS=true.
 */
const db = require('../db');
const smartlead = require('./smartlead');
const { webhookUrls } = require('../utils/public-client');
const { resetCampaignRouteCache } = require('./campaign-routing');

function autoRouteEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.AUTO_ROUTE_SMARTLEAD_CLIENTS || ''));
}

async function autoRouteClientCampaigns({ dryRun = false, clientId = null } = {}, deps = {}) {
  const q = deps.query || ((sql, p) => db.query(sql, p));
  const sl = deps.smartlead || smartlead;
  const env = deps.env || process.env;
  const master = String(env.SMARTLEAD_MASTER_API_KEY || '').trim();
  if (!master) return { clients: 0, added: [], error: 'SMARTLEAD_MASTER_API_KEY not set' };

  const params = [];
  let where = `active IS DISTINCT FROM false AND smartlead_use_master_key = true
               AND smartlead_client_id IS NOT NULL AND smartlead_client_id <> ''`;
  if (clientId) { params.push(clientId); where += ` AND id = $${params.length}`; }
  const { rows: clients } = await q(`SELECT id, smartlead_client_id FROM clients WHERE ${where}`, params);
  if (!clients.length) return { clients: 0, added: [] };

  const campaigns = await sl.listCampaigns(master);
  const { rows: routeRows } = await q('SELECT campaign_id FROM smartlead_campaign_routes', []);
  const routed = new Set(routeRows.map((r) => String(r.campaign_id)));
  const added = [];
  for (const c of clients) {
    const target = webhookUrls(c.id).smartlead_webhook_url;
    const mine = campaigns.filter((cp) => cp && cp.client_id != null && String(cp.client_id) === String(c.smartlead_client_id));
    for (const cp of mine) {
      const cid = String(cp.id);
      if (routed.has(cid)) continue;
      const entry = { campaign_id: cid, client_id: c.id };
      if (!dryRun) {
        await q(
          `INSERT INTO smartlead_campaign_routes (campaign_id, client_id) VALUES ($1, $2)
           ON CONFLICT (campaign_id) DO NOTHING`,
          [cid, c.id]
        );
        routed.add(cid);
        try {
          const hooks = await sl.listCampaignWebhooks(master, cid);
          if (!(hooks || []).some((h) => sl.webhookHasEmailReply(h, target))) {
            await sl.createEmailReplyWebhook(master, cid, target);
            entry.webhook_created = true;
          } else entry.webhook_created = false;
        } catch (err) {
          entry.webhook_error = err.message.replace(/api_key=[^&\s]+/g, 'api_key=***');
        }
      }
      added.push(entry);
    }
  }
  if (added.length && !dryRun) resetCampaignRouteCache();
  if (added.length) console.log('[AutoRoute] routes', { dryRun, added: added.length });
  return { clients: clients.length, added };
}

module.exports = { autoRouteClientCampaigns, autoRouteEnabled };
