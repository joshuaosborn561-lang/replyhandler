/**
 * After a client ICP is built, re-grade Slack cards from the last N days
 * that were marked "no ICP". Updates the existing card in place — never
 * posts a new one. Counts only.
 */

const db = require('../db');
const slack = require('./slack');
const { resolveReplyIcp, parseStoredIcp } = require('./reply-icp');
const { updatePostedCard } = require('./slack-reply-post');
const { isPostedSlackTs } = require('./reply-dedupe');
const { DRAFT_CLASSIFICATIONS } = require('./classifier');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');

const DEFAULT_DAYS = 3;

function isNoIcpVerdict(raw) {
  const v = parseStoredIcp(raw) || (raw && typeof raw === 'object' ? raw : null);
  if (!v) return false;
  return String(v.reason || '').trim().toLowerCase() === 'no icp';
}

function isDraftStatus(row) {
  const status = String(row.status || '');
  const classification = String(row.classification || '').toUpperCase();
  return (status === 'pending' || status === 'flagged')
    && DRAFT_CLASSIFICATIONS.includes(classification);
}

function cardPayload(row, verdict) {
  return {
    replyId: row.id,
    leadName: row.lead_name,
    leadEmail: row.lead_email,
    leadPhone: row.lead_phone || undefined,
    phoneProvider: row.lead_phone_provider || undefined,
    phoneEnrichmentStatus: row.phone_enrichment_status || undefined,
    leadLinkedinUrl: row.linkedin_url || undefined,
    leadWebsite: row.lead_website || undefined,
    leadPhoneAlt: row.lead_phone_alt || undefined,
    leadLocation: row.lead_location || undefined,
    leadTimezone: row.lead_timezone || undefined,
    leadFullName: row.lead_full_name || undefined,
    leadIcpVerdict: verdict,
    platform: row.platform,
    classification: row.classification,
    draft: row.draft_reply,
    inboundMessage: row.inbound_message,
    campaignDisplay: formatCampaignDisplay(
      campaignNameFromReply(row),
      row.campaign_id,
    ) || undefined,
  };
}

async function regradeNoIcpCards({
  clientId,
  days = DEFAULT_DAYS,
  dbClient = db,
  resolveIcp = resolveReplyIcp,
  updateCard = updatePostedCard,
  slackApi = slack,
} = {}) {
  const counts = {
    scanned: 0,
    persisted: 0,
    updated: 0,
    skipped_no_ts: 0,
    still_no_icp: 0,
    errors: 0,
  };
  if (!clientId) return counts;

  const lookback = Number.isFinite(Number(days)) ? Math.min(Math.max(Number(days), 1), 14) : DEFAULT_DAYS;
  const { rows } = await dbClient.query(
    `SELECT pr.id, pr.status, pr.classification, pr.draft_reply, pr.inbound_message,
            pr.slack_message_ts, pr.lead_name, pr.lead_email, pr.lead_phone,
            pr.lead_phone_provider, pr.phone_enrichment_status, pr.linkedin_url,
            pr.lead_website, pr.icp_verdict, pr.platform, pr.campaign_id, pr.campaign_name,
            c.slack_bot_token, c.slack_channel_id, c.name AS client_name
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.client_id = $1
        AND pr.created_at >= now() - ($2::int * interval '1 day')
        AND pr.status NOT IN ('suppressed', 'disqualified')
        AND pr.icp_verdict->>'reason' = 'no ICP'
      ORDER BY pr.created_at DESC
      LIMIT 200`,
    [clientId, lookback],
  );

  counts.scanned = rows.length;

  for (const row of rows) {
    if (!isNoIcpVerdict(row.icp_verdict)) continue;
    let verdict;
    try {
      verdict = await resolveIcp({
        website: row.lead_website,
        clientName: row.client_name,
        clientId,
        replyId: row.id,
        db: dbClient,
        grade: true,
      });
    } catch (err) {
      console.error('[IcpRegrade] resolve failed', { err: err.message });
      counts.errors += 1;
      continue;
    }
    if (!verdict || String(verdict.reason || '').trim().toLowerCase() === 'no icp') {
      counts.still_no_icp += 1;
      continue;
    }
    counts.persisted += 1;

    if (!isPostedSlackTs(row.slack_message_ts) || !row.slack_bot_token || !row.slack_channel_id) {
      counts.skipped_no_ts += 1;
      continue;
    }

    try {
      await updateCard(slackApi, {
        token: row.slack_bot_token,
        channelId: row.slack_channel_id,
        ts: row.slack_message_ts,
        isDraft: isDraftStatus(row),
        payload: cardPayload(row, verdict),
      });
      counts.updated += 1;
    } catch (err) {
      console.error('[IcpRegrade] card update failed', { err: err.message });
      counts.errors += 1;
    }
  }

  return counts;
}

module.exports = {
  DEFAULT_DAYS,
  isNoIcpVerdict,
  regradeNoIcpCards,
};
