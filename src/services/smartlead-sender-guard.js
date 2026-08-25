/**
 * Detect cross-client SmartLead sender contamination.
 *
 * All SalesGlider clients share one SmartLead workspace (same user_id). When an
 * email account is moved between SmartLead "clients" (or its signature is
 * rebranded), in-flight sequences keep sending from that mailbox — so a Goliath
 * campaign can suddenly sign "Aarav Sanchez / Roofs by Peterson".
 *
 * 2026-08-25: Goliath Education Receipts seq-2 to Sean Dean (sdean@mscok.edu)
 * rendered with Aarav Sanchez + Roofs by Peterson. Dozens of similar bad sends
 * the same day (Peterson + Culture Fits sigs on Goliath copy).
 *
 * This guard scans recent sent statistics for signature brands that do not
 * match the campaign's ReplyHandler client and optionally auto-pauses the
 * campaign + Slack-alerts.
 */

const db = require('../db');

const SMARTLEAD_API = 'https://server.smartlead.ai/api/v1';

/** client.name (ReplyHandler) → substrings that must appear in a valid signature */
const CLIENT_BRAND_NEEDLES = {
  Goliath: ['goliath'],
  'Roofs By Peterson': ['roofs by peterson', 'peterson'],
  'Culture Fits': ['culture fit'],
  'Parlay Tech': ['parlay'],
  'Bolder Cyber Partners': ['bolder'],
  SalesGlider: ['salesglider', 'insight'],
  TechEvolution: ['techevolution', 'tech evolution', 'tech evo'],
  'Vasco Warranty': ['vasco'],
  MSRS: ['msrs'],
  Nieto: ['nieto'],
};

/** Other clients' brand markers — finding these on a campaign is contamination. */
const ALL_FOREIGN_BRANDS = [
  { brand: 'Roofs By Peterson', re: /roofs\s*by\s*peterson/i },
  { brand: 'Culture Fits', re: /culture\s*fits?/i },
  { brand: 'Goliath', re: /goliath/i },
  { brand: 'Parlay Tech', re: /parlay/i },
  { brand: 'Bolder Cyber Partners', re: /bolder\s*cyber/i },
  { brand: 'SalesGlider', re: /salesglider|insight\s*\(dot\)\s*com/i },
  { brand: 'TechEvolution', re: /techevolution|tech\s*evo/i },
  { brand: 'Vasco Warranty', re: /vasco/i },
  { brand: 'MSRS', re: /\bmsrs\b/i },
  { brand: 'Nieto', re: /\bnieto\b/i },
];

function brandNeedlesForClient(clientName) {
  const direct = CLIENT_BRAND_NEEDLES[clientName];
  if (direct) return direct;
  // Fallback: first token of the client name.
  const token = String(clientName || '').trim().split(/\s+/)[0];
  return token ? [token.toLowerCase()] : [];
}

function extractSignatureBlocks(htmlOrText) {
  const raw = String(htmlOrText || '');
  const blocks = [];
  // SmartLead renders %signature% as <div>Name\nCompany</div>
  for (const m of raw.matchAll(/<div>([^<]+)\n([^<]+)<\/div>/gi)) {
    blocks.push(`${m[1].trim()}\n${m[2].trim()}`);
  }
  if (blocks.length) return blocks;
  // Plain-text fallback: last non-empty lines before an unsub footer.
  const plain = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '');
  const lines = plain.split('\n').map((l) => l.trim()).filter(Boolean);
  const unsubIdx = lines.findIndex((l) => /not for you\?|wrong person\?|one reply and/i.test(l));
  if (unsubIdx >= 2) {
    blocks.push(`${lines[unsubIdx - 2]}\n${lines[unsubIdx - 1]}`);
  }
  return blocks;
}

function foreignBrandInSignature(signature, clientName) {
  const sig = String(signature || '');
  if (!sig.trim()) return null;
  for (const { brand, re } of ALL_FOREIGN_BRANDS) {
    if (brand === clientName) continue;
    if (re.test(sig)) return brand;
  }
  return null;
}

function signatureMatchesClient(signature, clientName) {
  const foreignBrand = foreignBrandInSignature(signature, clientName);
  if (foreignBrand) return { ok: false, foreignBrand };
  return { ok: true, foreignBrand: null };
}

async function smartleadFetch(apiKey, pathWithQuery) {
  const sep = pathWithQuery.includes('?') ? '&' : '?';
  const url = `${SMARTLEAD_API}${pathWithQuery}${sep}api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'ReplyHandler-SenderGuard/1.0' },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`SmartLead ${res.status}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function pauseCampaign(apiKey, campaignId) {
  const url = `${SMARTLEAD_API}/campaigns/${campaignId}/status?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'ReplyHandler-SenderGuard/1.0',
    },
    body: JSON.stringify({ status: 'PAUSED' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`pause ${campaignId} failed: ${res.status} ${text.slice(0, 200)}`);
  return true;
}

/**
 * Scan one client's active/paused campaigns for recent sends with foreign signatures.
 */
async function auditClientSenderBrands(client, {
  lookbackHours = 48,
  maxStatsPerCampaign = 300,
  autoPause = false,
} = {}) {
  const apiKey = client.smartlead_api_key;
  if (!apiKey) return { client: client.name, skipped: 'no_smartlead_key' };

  const campaigns = await smartleadFetch(apiKey, '/campaigns');
  const list = Array.isArray(campaigns) ? campaigns : [];
  const cutoff = Date.now() - lookbackHours * 3600 * 1000;
  const findings = [];
  const paused = [];

  for (const camp of list) {
    const status = String(camp.status || '').toUpperCase();
    if (!['ACTIVE', 'PAUSED', 'STARTING'].includes(status)) continue;

    let offset = 0;
    let foreignHits = [];
    while (offset < maxStatsPerCampaign) {
      const page = await smartleadFetch(
        apiKey,
        `/campaigns/${camp.id}/statistics?offset=${offset}&limit=100`,
      );
      const rows = page?.data || (Array.isArray(page) ? page : []);
      if (!rows.length) break;

      for (const row of rows) {
        const sentAt = row.sent_time ? Date.parse(row.sent_time) : 0;
        if (sentAt && sentAt < cutoff) continue;
        const sigs = extractSignatureBlocks(row.email_message || '');
        for (const sig of sigs) {
          const check = signatureMatchesClient(sig, client.name);
          if (check.foreignBrand) {
            foreignHits.push({
              campaignId: camp.id,
              campaignName: camp.name,
              leadEmail: row.lead_email,
              leadName: row.lead_name,
              sequenceNumber: row.sequence_number,
              sentTime: row.sent_time,
              signature: sig.replace(/\n/g, ' | '),
              foreignBrand: check.foreignBrand,
            });
          }
        }
      }
      offset += rows.length;
      if (rows.length < 100) break;
    }

    if (foreignHits.length) {
      findings.push(...foreignHits);
      if (autoPause && status === 'ACTIVE') {
        try {
          await pauseCampaign(apiKey, camp.id);
          paused.push({ campaignId: camp.id, campaignName: camp.name, hits: foreignHits.length });
        } catch (err) {
          console.error('[SenderGuard] pause failed', {
            client: client.name, campaignId: camp.id, err: err.message,
          });
        }
      }
    }
  }

  return {
    client: client.name,
    clientId: client.id,
    findings,
    paused,
    foreignCount: findings.length,
  };
}

async function loadActiveSmartleadClients() {
  const { rows } = await db.query(
    `SELECT id, name, smartlead_api_key, slack_bot_token, slack_channel_id
       FROM clients
      WHERE active IS DISTINCT FROM false
        AND smartlead_api_key IS NOT NULL
        AND length(trim(smartlead_api_key)) > 0
      ORDER BY name`,
  );
  return rows;
}

function guardEnabled() {
  const v = process.env.SMARTLEAD_SENDER_GUARD_ENABLED;
  if (v === undefined || v === '') return true; // on by default — this bug is catastrophic
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function autoPauseEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.SMARTLEAD_SENDER_GUARD_AUTO_PAUSE || '1').trim());
}

/**
 * Cron entry: audit every SmartLead client; pause + alert on contamination.
 */
async function runSmartleadSenderGuard() {
  if (!guardEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }

  const clients = await loadActiveSmartleadClients();
  const lookbackHours = parseInt(process.env.SMARTLEAD_SENDER_GUARD_LOOKBACK_HOURS || '48', 10);
  const autoPause = autoPauseEnabled();
  const results = [];

  for (const client of clients) {
    try {
      const r = await auditClientSenderBrands(client, { lookbackHours, autoPause });
      results.push(r);
      if (r.foreignCount) {
        console.error('[SenderGuard] CROSS-CLIENT SIGNATURES DETECTED', {
          client: r.client,
          foreignCount: r.foreignCount,
          paused: r.paused,
          sample: r.findings.slice(0, 3),
        });
        await alertContamination(client, r);
      }
    } catch (err) {
      console.error('[SenderGuard] audit failed', { client: client.name, err: err.message });
      results.push({ client: client.name, error: err.message });
    }
  }

  return { results };
}

async function alertContamination(client, audit) {
  const token = client.slack_bot_token || process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SMARTLEAD_SENDER_GUARD_SLACK_CHANNEL_ID
    || process.env.FOLLOW_UP_SLACK_CHANNEL_ID
    || client.slack_channel_id;
  if (!token || !channel) return;

  const sample = (audit.findings || []).slice(0, 5).map((f) => (
    `• ${f.campaignName} → ${f.leadEmail || f.leadName} signed *${f.signature}* (_${f.foreignBrand}_)`
  )).join('\n');
  const pausedLine = (audit.paused || []).length
    ? `\n⏸ Auto-paused: ${audit.paused.map((p) => p.campaignName).join(', ')}`
    : '\n_(auto-pause off or campaign already paused)_';

  const text = (
    `🚨 *SmartLead cross-client signature*\n` +
    `*Client:* ${client.name}\n` +
    `*Bad sends (last window):* ${audit.foreignCount}\n` +
    `${sample}${pausedLine}\n` +
    `_A mailbox was sending another brand's company line. Fix account attachments before unpausing._`
  );

  try {
    const { WebClient } = require('@slack/web-api');
    const api = new WebClient(token);
    await api.chat.postMessage({ channel, text });
  } catch (err) {
    console.error('[SenderGuard] Slack alert failed', { err: err.message });
  }
}

module.exports = {
  CLIENT_BRAND_NEEDLES,
  extractSignatureBlocks,
  foreignBrandInSignature,
  signatureMatchesClient,
  auditClientSenderBrands,
  runSmartleadSenderGuard,
  pauseCampaign,
  guardEnabled,
  autoPauseEnabled,
};
