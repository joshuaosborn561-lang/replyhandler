/**
 * Re-open replies the interested-only gate silenced before mixed-intent
 * classification landed. Selects pending_replies with status=suppressed
 * from the last N days (default 3), re-runs full-body classifyAndDraft
 * (draftMode: bulk), and for mixed-intent or QUESTION rows resets status
 * and posts a Slack card.
 *
 * dry_run is the default and returns counts only — no names, emails, or
 * inbound text.
 */

const db = require('../db');
const { classifyAndDraft } = require('./classifier');
const { postProspectSlackCard } = require('./slack-reply-post');
const { isPostedSlackTs } = require('./reply-dedupe');
const { looksLikeMixedIntent, promoteMixedIntent } = require('../utils/mixed-intent');
const { slackChannelSuppressionReason } = require('../utils/slack-channel-policy');
const { applyClientDraftPolicy } = require('../utils/client-draft-policy');
const { formatCampaignDisplay } = require('../utils/campaign-display');

const DEFAULT_DAYS = 3;
const MAX_DAYS = 30;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

function parseDays(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

function parseLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseDryRun(value) {
  if (value == null || value === '') return true;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function threadContextFromRow(row) {
  let tc = row.thread_context;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  if (Array.isArray(tc) && tc.length) return tc;
  return [{ role: 'prospect', message: row.inbound_message || '' }];
}

function shouldResurface({ classification, inboundMessage }) {
  const inbound = inboundMessage || '';
  const mixed = looksLikeMixedIntent(inbound);
  const promoted = promoteMixedIntent(classification, inbound);
  const isQuestion = String(promoted || '').toUpperCase() === 'QUESTION';
  if (!mixed && !isQuestion) return false;
  return !slackChannelSuppressionReason({
    classification: promoted,
    inboundMessage: inbound,
  });
}

function emptyCounts({ days, dryRun }) {
  return {
    dry_run: !!dryRun,
    days,
    scanned: 0,
    resurfaceable: 0,
    still_suppressed: 0,
    posted: 0,
    skipped_inactive: 0,
    skipped_already_posted: 0,
    skipped_claim: 0,
    classify_errors: 0,
    post_errors: 0,
  };
}

async function resurfaceSuppressedReplies({
  days = DEFAULT_DAYS,
  dryRun = true,
  limit = DEFAULT_LIMIT,
  classifyFn = classifyAndDraft,
  postFn = postProspectSlackCard,
  dbClient = db,
} = {}) {
  const windowDays = parseDays(days);
  const rowLimit = parseLimit(limit);
  const counts = emptyCounts({ days: windowDays, dryRun: !!dryRun });

  const { rows } = await dbClient.query(
    `SELECT pr.id, pr.client_id, pr.platform, pr.campaign_id, pr.campaign_name,
            pr.lead_id, pr.lead_name, pr.lead_email, pr.inbound_message,
            pr.thread_context, pr.classification, pr.draft_reply,
            pr.slack_message_ts, pr.status,
            c.name AS client_name, c.voice_prompt, c.booking_link,
            c.digest_timezone, c.slack_bot_token, c.slack_channel_id, c.active
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.status = 'suppressed'
        AND pr.created_at >= now() - ($1::int * interval '1 day')
      ORDER BY pr.created_at DESC
      LIMIT $2`,
    [windowDays, rowLimit],
  );

  counts.scanned = rows.length;

  for (const row of rows) {
    if (!row.active) {
      counts.skipped_inactive += 1;
      continue;
    }
    if (isPostedSlackTs(row.slack_message_ts)) {
      counts.skipped_already_posted += 1;
      continue;
    }

    const inbound = row.inbound_message || '';
    const threadContext = threadContextFromRow(row);

    let result;
    try {
      result = await classifyFn(
        threadContext,
        inbound,
        row.voice_prompt,
        row.booking_link,
        null,
        {
          leadName: row.lead_name,
          digestTimezone: row.digest_timezone,
          platform: row.platform,
          clientId: row.client_id,
          leadId: row.lead_id,
          leadEmail: row.lead_email,
          clientName: row.client_name,
          draftMode: 'bulk',
        },
      );
    } catch (err) {
      console.error('[Resurface] classify failed', { err: err.message });
      counts.classify_errors += 1;
      continue;
    }

    const classification = promoteMixedIntent(result.classification, inbound);
    if (!shouldResurface({ classification, inboundMessage: inbound })) {
      counts.still_suppressed += 1;
      continue;
    }

    counts.resurfaceable += 1;
    if (dryRun) continue;

    const policy = applyClientDraftPolicy(
      { id: row.client_id, name: row.client_name },
      row.lead_email,
      {
        classification,
        draft: result.draft || null,
        reasoning: result.reasoning || 'Resurfaced after full-body reclassification.',
      },
    );

    try {
      const posted = await postFn({
        token: row.slack_bot_token,
        channelId: row.slack_channel_id,
        clientId: row.client_id,
        platform: row.platform,
        campaignId: row.campaign_id,
        leadId: row.lead_id,
        threadContext,
        isDraft: policy.isDraft,
        replyId: row.id,
        postInThread: false,
        card: {
          replyId: row.id,
          leadName: row.lead_name,
          leadEmail: row.lead_email,
          platform: row.platform,
          classification,
          draft: policy.draft,
          reasoning: policy.reasoning,
          inboundMessage: inbound,
          campaignDisplay: formatCampaignDisplay(row.campaign_name, row.campaign_id) || undefined,
        },
      });
      if (posted && posted.skipped) {
        counts.skipped_claim += 1;
        continue;
      }
    } catch (err) {
      console.error('[Resurface] Slack post failed', { err: err.message });
      counts.post_errors += 1;
      continue;
    }

    await dbClient.query(
      `UPDATE pending_replies
          SET status = $1,
              classification = $2,
              draft_reply = $3,
              suppression_reason = NULL,
              updated_at = now()
        WHERE id = $4 AND status = 'suppressed'`,
      [policy.status, classification, policy.draft, row.id],
    );
    counts.posted += 1;
  }

  return counts;
}

module.exports = {
  DEFAULT_DAYS,
  parseDays,
  parseDryRun,
  shouldResurface,
  resurfaceSuppressedReplies,
};
