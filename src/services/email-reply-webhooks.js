/**
 * Startup check: every active SmartLead client should have an EMAIL_REPLY
 * webhook on each campaign pointing at /webhook/smartlead/:clientId.
 *
 * Registers the hook when it is missing. Failures are logged and returned
 * as `missing` — a bad key or one campaign must not fail the rest.
 */

const db = require('../db');
const smartlead = require('./smartlead');
const { webhookUrls } = require('../utils/public-client');

function campaignIdOf(camp) {
  if (!camp || typeof camp !== 'object') return null;
  const id = camp.id ?? camp.campaign_id ?? camp.campaignId ?? camp.email_campaign_id;
  if (id == null || String(id).trim() === '') return null;
  return id;
}

async function ensureClientEmailReplyWebhooks(client) {
  const result = {
    clientId: client.id,
    campaigns: 0,
    registered: 0,
    created: 0,
    missing: [],
    errors: [],
  };
  if (!client?.smartlead_api_key) {
    result.errors.push('no_smartlead_api_key');
    return result;
  }
  const target = webhookUrls(client.id).smartlead_webhook_url;
  let campaigns = [];
  try {
    campaigns = await smartlead.listCampaigns(client.smartlead_api_key);
  } catch (err) {
    result.errors.push(err.message);
    console.error('[Startup] EMAIL_REPLY list campaigns failed', {
      clientId: client.id, err: err.message,
    });
    return result;
  }
  if (!Array.isArray(campaigns)) campaigns = [];

  for (const camp of campaigns) {
    const campaignId = campaignIdOf(camp);
    if (campaignId == null) continue;
    result.campaigns++;
    try {
      const hooks = await smartlead.listCampaignWebhooks(client.smartlead_api_key, campaignId);
      const has = (Array.isArray(hooks) ? hooks : []).some((h) =>
        smartlead.webhookHasEmailReply(h, target)
      );
      if (has) {
        result.registered++;
        continue;
      }
      try {
        await smartlead.createEmailReplyWebhook(
          client.smartlead_api_key,
          campaignId,
          target,
        );
        result.created++;
        result.registered++;
        console.log('[Startup] EMAIL_REPLY webhook registered', {
          clientId: client.id, campaignId,
        });
      } catch (createErr) {
        result.missing.push({ campaignId, err: createErr.message });
        console.warn('[Startup] EMAIL_REPLY webhook missing', {
          clientId: client.id, campaignId, err: createErr.message,
        });
      }
    } catch (err) {
      result.missing.push({ campaignId, err: err.message });
      result.errors.push(err.message);
      console.warn('[Startup] EMAIL_REPLY webhook check failed', {
        clientId: client.id, campaignId, err: err.message,
      });
    }
  }
  return result;
}

async function ensureEmailReplyWebhooks() {
  const summary = {
    clients: 0,
    campaigns: 0,
    registered: 0,
    created: 0,
    missing: [],
    errors: [],
  };
  let clients = [];
  try {
    const { rows } = await db.query(
      `SELECT id, smartlead_api_key
         FROM clients
        WHERE active IS DISTINCT FROM false
          AND smartlead_api_key IS NOT NULL
          AND smartlead_api_key <> ''`
    );
    clients = rows;
  } catch (err) {
    console.error('[Startup] EMAIL_REPLY client load failed', { err: err.message });
    return { ...summary, errors: [err.message] };
  }

  summary.clients = clients.length;
  const perClient = await Promise.all(clients.map(async (client) => {
    try {
      return await ensureClientEmailReplyWebhooks(client);
    } catch (err) {
      console.error('[Startup] EMAIL_REPLY client check failed', {
        clientId: client.id, err: err.message,
      });
      return {
        clientId: client.id,
        campaigns: 0,
        registered: 0,
        created: 0,
        missing: [],
        errors: [err.message],
      };
    }
  }));

  for (const row of perClient) {
    summary.campaigns += row.campaigns;
    summary.registered += row.registered;
    summary.created += row.created;
    for (const miss of row.missing) {
      summary.missing.push({ clientId: row.clientId, ...miss });
    }
    for (const err of row.errors) {
      summary.errors.push({ clientId: row.clientId, err });
    }
  }

  console.log('[Startup] EMAIL_REPLY webhook check', {
    clients: summary.clients,
    campaigns: summary.campaigns,
    registered: summary.registered,
    created: summary.created,
    missing: summary.missing.length,
    errors: summary.errors.length,
  });
  if (summary.missing.length) {
    console.warn('[Startup] EMAIL_REPLY webhooks missing', {
      count: summary.missing.length,
      campaigns: summary.missing.map((m) => m.campaignId),
    });
  }
  return summary;
}

module.exports = {
  ensureEmailReplyWebhooks,
  ensureClientEmailReplyWebhooks,
  campaignIdOf,
};
