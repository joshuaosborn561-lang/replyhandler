/**
 * Campaign-mapped inbound forward.
 *
 * When a SmartLead reply arrives on a campaign in inbound_forward_rules,
 * email the configured address from primary Gmail. Separate from client
 * notify (Always-notify on send), which is unchanged.
 */

const db = require('../db');
const gmail = require('./gmail-send');
const smartlead = require('./smartlead');
const { inboundPrefix } = require('./reply-dedupe');
const { buildInboundForwardEmail } = require('./client-notify-email');
const {
  matchInboundForwardRules,
  collectForwardEmails,
  inboundForwardLeadKey,
} = require('../utils/inbound-forward-policy');
const {
  parseInboundFromPayload,
  cleanInboundReply,
  normalizeSmartleadLeadId,
  normalizeSmartleadCampaignId,
  latestInboundFromSmartleadHistory,
  preferFullerInbound,
  SMARTLEAD_NON_REPLY_EVENTS,
} = require('../utils/smartlead-webhook-helpers');

function inboundForwardWebhookUnauthorized(req) {
  const expected = String(process.env.INBOUND_FORWARD_WEBHOOK_SECRET || '').trim();
  if (!expected) return false;
  const q = String(req?.query?.secret || req?.query?.key || '').trim();
  const header = String(req?.headers?.authorization || '').trim();
  const bearer = header.replace(/^Bearer\s+/i, '').trim();
  return q !== expected && bearer !== expected;
}

function shouldSkipInboundForwardEvent(payload) {
  const ev = String(
    payload?.event_type || payload?.eventType || payload?.event
    || payload?.webhook_event || payload?.type || ''
  ).toUpperCase();
  if (!ev) return null;
  if (ev === 'LEAD_CATEGORY_UPDATED') return 'leave_allo_hook';
  if (SMARTLEAD_NON_REPLY_EVENTS.has(ev)) return 'non_reply_event';
  return null;
}

function extractInboundForwardFields(payload = {}) {
  const leadData = payload.lead_data || payload.lead || {};
  const replyObj =
    payload.reply_message || payload.replyMessage || payload.reply
    || payload.latest_reply || payload.last_reply || null;
  const campaignId = normalizeSmartleadCampaignId(payload, leadData);
  const leadId = normalizeSmartleadLeadId(payload, leadData);
  const leadEmail =
    payload.email || payload.lead_email || payload.to_email
    || payload.sl_lead_email || leadData.email || leadData.lead_email || payload.lead?.email || null;
  const leadName =
    (payload.lead_first_name
      ? `${payload.lead_first_name} ${payload.lead_last_name || ''}`.trim()
      : null)
    || payload.name || payload.lead_name
    || (leadData.first_name ? `${leadData.first_name} ${leadData.last_name || ''}`.trim() : null)
    || leadData.name || 'Prospect';
  const campaignName =
    payload.email_campaign_name || payload.emailCampaignName
    || payload.campaign_name || payload.campaignName
    || (payload.campaign && typeof payload.campaign === 'object' ? payload.campaign.name : null)
    || null;
  let inbound = parseInboundFromPayload(replyObj, payload);
  inbound = cleanInboundReply(inbound) || String(inbound || '').trim();
  return { campaignId, campaignName, leadId, leadEmail, leadName, inboundMessage: inbound };
}

async function defaultLoadRules(query) {
  try {
    const { rows } = await query(
      `SELECT campaign_id, campaign_name_pattern, to_emails, active
         FROM inbound_forward_rules
        WHERE active IS DISTINCT FROM false`
    );
    return rows;
  } catch (err) {
    if (/inbound_forward_rules/i.test(err.message || '')) {
      console.warn('[InboundForward] inbound_forward_rules missing — skip (apply migration 032)');
      return [];
    }
    throw err;
  }
}

async function claimForward(query, { campaignId, leadKey, prefix, toEmails }) {
  const { rows } = await query(
    `INSERT INTO inbound_forwards
        (campaign_id, lead_key, inbound_prefix, to_emails, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (campaign_id, lead_key, inbound_prefix) DO NOTHING
     RETURNING id`,
    [campaignId, leadKey, prefix, toEmails]
  );
  return rows[0] || null;
}

async function markForwardSent(query, id) {
  await query(
    `UPDATE inbound_forwards
        SET status = 'sent', sent_at = now()
      WHERE id = $1`,
    [id]
  );
}

async function releaseForwardClaim(query, id) {
  await query('DELETE FROM inbound_forwards WHERE id = $1 AND status = $2', [id, 'pending']);
}

/**
 * Forward this inbound if a rule matches. Never throws to the caller.
 * Dedupe: one Gmail send per (campaign, lead, inbound prefix).
 */
async function maybeForwardInboundReply(input = {}, deps = {}) {
  const query = deps.query || ((text, params) => db.query(text, params));
  const loadRules = deps.loadRules || defaultLoadRules;
  const sendMail = deps.sendMail || ((opts) => gmail.sendMail(opts));
  const isGmailConfigured = deps.isGmailConfigured || (() => gmail.isConfigured());

  const campaignId = input.campaignId != null ? String(input.campaignId).trim() : '';
  const inboundMessage = String(input.inboundMessage || '').trim();
  if (!campaignId || !inboundMessage) {
    return { skipped: true, reason: 'missing_campaign_or_inbound' };
  }

  let rules;
  try {
    rules = await loadRules(query);
  } catch (err) {
    console.error('[InboundForward] Failed to load rules', { campaignId, err: err.message });
    return { skipped: true, reason: 'rules_load_failed' };
  }

  const matched = matchInboundForwardRules(rules, {
    campaignId,
    campaignName: input.campaignName,
  });
  const { emails, blocked } = collectForwardEmails(matched);
  if (blocked.length) {
    console.warn('[InboundForward] Dropped blocked forward address(es)', {
      campaignId, blocked,
    });
  }
  if (!emails.length) {
    return { skipped: true, reason: matched.length ? 'all_recipients_blocked' : 'no_rule' };
  }

  if (!isGmailConfigured()) {
    console.warn('[InboundForward] Primary Gmail not configured — will retry on next inbound', {
      campaignId,
    });
    return { skipped: true, reason: 'gmail_not_configured' };
  }

  const leadKey = inboundForwardLeadKey({
    leadId: input.leadId,
    leadEmail: input.leadEmail,
  });
  const prefix = inboundPrefix(inboundMessage);
  if (!prefix) {
    return { skipped: true, reason: 'empty_prefix' };
  }

  let claimed;
  try {
    claimed = await claimForward(query, {
      campaignId,
      leadKey,
      prefix,
      toEmails: emails.join(', '),
    });
  } catch (err) {
    if (/inbound_forwards/i.test(err.message || '')) {
      console.warn('[InboundForward] inbound_forwards missing — skip (apply migration 032)');
      return { skipped: true, reason: 'forwards_table_missing' };
    }
    console.error('[InboundForward] Claim failed', { campaignId, err: err.message });
    return { skipped: true, reason: 'claim_failed' };
  }
  if (!claimed) {
    return { skipped: true, reason: 'already_forwarded' };
  }

  const notify = buildInboundForwardEmail({
    leadName: input.leadName,
    leadEmail: input.leadEmail,
    campaignName: input.campaignName,
    campaignId,
    threadContext: input.threadContext,
    inboundMessage,
  });

  try {
    await sendMail({
      to: emails,
      subject: notify.subject,
      htmlBody: notify.htmlBody,
      textBody: notify.textBody,
    });
    await markForwardSent(query, claimed.id);
    console.log('[InboundForward] Sent', {
      campaignId,
      campaignName: input.campaignName || null,
      to: emails,
    });
    return { forwarded: true, to: emails };
  } catch (err) {
    console.error('[InboundForward] Gmail send failed — claim released for retry', {
      campaignId, err: err.message,
    });
    try {
      await releaseForwardClaim(query, claimed.id);
    } catch (releaseErr) {
      console.error('[InboundForward] Failed to release claim', { err: releaseErr.message });
    }
    return { skipped: true, reason: 'send_failed', error: err.message };
  }
}

async function optionalThreadHistory(campaignId, leadId) {
  const key = String(process.env.SMARTLEAD_MASTER_API_KEY || process.env.SMARTLEAD_API_KEY || '').trim();
  if (!key || !campaignId || !leadId) return null;
  try {
    return await smartlead.getThreadHistory(key, campaignId, leadId);
  } catch (err) {
    console.warn('[InboundForward] Thread history lookup failed', {
      campaignId, err: err.message,
    });
    return null;
  }
}

/**
 * Dedicated EMAIL_REPLY webhook (no client Slack path).
 * Leaves LEAD_CATEGORY_UPDATED to the Allo caller-reply-hook.
 */
async function handleInboundForwardWebhook(req) {
  if (inboundForwardWebhookUnauthorized(req)) {
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }
  const payload = req.body || {};
  const skipEvent = shouldSkipInboundForwardEvent(payload);
  if (skipEvent) {
    return { status: 200, body: { ok: true, skipped: true, reason: skipEvent } };
  }
  const fields = extractInboundForwardFields(payload);
  if (!fields.campaignId) {
    return { status: 200, body: { ok: true, skipped: true, reason: 'missing_campaign' } };
  }
  let threadContext = null;
  if (fields.leadId) {
    threadContext = await optionalThreadHistory(fields.campaignId, fields.leadId);
    if (threadContext) {
      const fromHist = latestInboundFromSmartleadHistory(threadContext, fields.leadEmail) || '';
      fields.inboundMessage = preferFullerInbound(fields.inboundMessage, fromHist);
    }
  }
  const result = await maybeForwardInboundReply({
    ...fields,
    threadContext,
  });
  return { status: 200, body: { ok: true, ...result } };
}

module.exports = {
  maybeForwardInboundReply,
  defaultLoadRules,
  handleInboundForwardWebhook,
  inboundForwardWebhookUnauthorized,
  shouldSkipInboundForwardEvent,
  extractInboundForwardFields,
};
