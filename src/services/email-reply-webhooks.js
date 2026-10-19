/**
 * Startup check: every active SmartLead client should have an EMAIL_REPLY
 * webhook on each ACTIVE campaign pointing at /webhook/smartlead/:clientId.
 *
 * Registers the hook when it is missing. A list-call failure is `unknown`,
 * not `missing`. A bad key or one campaign must not fail the rest.
 *
 * SmartLead's shared master key 429s after a burst (~11 calls 0.4s apart),
 * so this check is throttled to about 1 call per second per API key.
 */

const db = require('../db');
const smartlead = require('./smartlead');
const { webhookUrls } = require('../utils/public-client');

const KEY_GAP_MS = (() => {
  const n = parseInt(process.env.SMARTLEAD_WEBHOOK_CHECK_GAP_MS || '', 10);
  return Number.isFinite(n) && n >= 200 ? n : 1000;
})();

const keyQueues = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyId(apiKey) {
  return String(apiKey || '').slice(0, 16) || 'none';
}

/** Serialize SmartLead calls per key with ~1s between starts. */
function withKeyGap(apiKey, fn) {
  const k = keyId(apiKey);
  const prev = keyQueues.get(k) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = prev.then(async () => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      const remain = KEY_GAP_MS - (Date.now() - started);
      if (remain > 0) await sleep(remain);
      release();
    }
  });
  keyQueues.set(k, gate.catch(() => {}));
  return run;
}

function campaignIdOf(camp) {
  if (!camp || typeof camp !== 'object') return null;
  const id = camp.id ?? camp.campaign_id ?? camp.campaignId ?? camp.email_campaign_id;
  if (id == null || String(id).trim() === '') return null;
  return id;
}

function campaignStatusOf(camp) {
  if (!camp || typeof camp !== 'object') return '';
  return String(camp.status || camp.campaign_status || camp.campaignStatus || '').trim().toUpperCase();
}

/** Only ACTIVE campaigns get EMAIL_REPLY webhooks registered. */
function isActiveCampaign(camp) {
  return campaignStatusOf(camp) === 'ACTIVE';
}

function emptyClientResult(clientId) {
  return {
    clientId,
    campaigns: 0,
    registered: 0,
    created: 0,
    missing: [],
    unknown: [],
    errors: [],
  };
}

async function ensureClientEmailReplyWebhooks(client) {
  const result = emptyClientResult(client.id);
  if (!client?.smartlead_api_key) {
    result.errors.push('no_smartlead_api_key');
    return result;
  }
  const target = webhookUrls(client.id).smartlead_webhook_url;
  const key = client.smartlead_api_key;
  let campaigns = [];
  try {
    campaigns = await withKeyGap(key, () => smartlead.listCampaigns(key));
  } catch (err) {
    result.unknown.push({ campaignId: null, err: err.message, reason: 'list_campaigns_failed' });
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
    if (!isActiveCampaign(camp)) continue;
    result.campaigns++;
    try {
      const hooks = await withKeyGap(key, () => smartlead.listCampaignWebhooks(key, campaignId));
      const has = (Array.isArray(hooks) ? hooks : []).some((h) =>
        smartlead.webhookHasEmailReply(h, target)
      );
      if (has) {
        result.registered++;
        continue;
      }
      try {
        await withKeyGap(key, () => smartlead.createEmailReplyWebhook(key, campaignId, target));
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
      result.unknown.push({ campaignId, err: err.message, reason: 'list_webhooks_failed' });
      result.errors.push(err.message);
      console.warn('[Startup] EMAIL_REPLY webhook unknown', {
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
    unknown: [],
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
      return { ...emptyClientResult(client.id), errors: [err.message] };
    }
  }));

  for (const row of perClient) {
    summary.campaigns += row.campaigns;
    summary.registered += row.registered;
    summary.created += row.created;
    for (const miss of row.missing) {
      summary.missing.push({ clientId: row.clientId, ...miss });
    }
    for (const unk of row.unknown || []) {
      summary.unknown.push({ clientId: row.clientId, ...unk });
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
    unknown: summary.unknown.length,
    errors: summary.errors.length,
  });
  if (summary.missing.length) {
    console.warn('[Startup] EMAIL_REPLY webhooks missing', {
      count: summary.missing.length,
      campaigns: summary.missing.map((m) => m.campaignId),
    });
  }
  if (summary.unknown.length) {
    console.warn('[Startup] EMAIL_REPLY webhooks unknown', {
      count: summary.unknown.length,
      campaigns: summary.unknown.map((u) => u.campaignId),
    });
  }
  return summary;
}

module.exports = {
  ensureEmailReplyWebhooks,
  ensureClientEmailReplyWebhooks,
  campaignIdOf,
  isActiveCampaign,
  KEY_GAP_MS,
};
