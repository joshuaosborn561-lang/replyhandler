const db = require('../db');
const { postProspectSlackCard } = require('./slack-reply-post');
const { draftReattemptToBook } = require('./follow-up-drafts');
const { looksAlreadyBooked } = require('./booking-check');
const { cancelPendingForThread } = require('./outbound-follow-up');
const smartlead = require('./smartlead');
const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');

/**
 * Turns a due row in outbound_follow_ups into a Slack approval card.
 *
 * Shared by the timed runner below and the attention digest, so a follow-up
 * looks and behaves identically either way — same FOLLOW_UP pending_replies
 * row, same Approve / Edit / Reject send path.
 */

function stepLabel(fu) {
  const step = Number(fu.step) || 1;
  const hours = fu.sequence_hours != null ? Number(fu.sequence_hours) : null;
  if (hours != null && Number.isFinite(hours)) {
    const nice = hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
    return `step ${step} (${nice})`;
  }
  return `step ${step}`;
}

function parseThreadContext(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function lastOutboundFor(platform, threadContext) {
  if (!threadContext || typeof threadContext !== 'object') return '';
  if (platform === 'smartlead' && !Array.isArray(threadContext)) {
    return lastOutboundBodyFromSmartleadHistory(threadContext) || '';
  }
  const msgs = Array.isArray(threadContext.messages) ? threadContext.messages : [];
  let last = '';
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase();
    if (role !== 'us' && role !== 'me') continue;
    const t = (typeof m.message === 'string' && m.message) || (typeof m.text === 'string' && m.text) || '';
    if (t.trim()) last = t.trim();
  }
  return last;
}

/** Post one follow-up card. Returns the created pending_replies row. */
async function postFollowUpCard(client, fu, { reasoningExtra } = {}) {
  const draft = await draftReattemptToBook({
    leadName: fu.lead_name,
    platform: fu.platform,
    voicePrompt: client.voice_prompt,
    bookingLink: client.booking_link,
    lastInboundMessage: null,
    lastOutboundMessage: null,
    digestTimezone: client.digest_timezone,
  });

  let threadContext = null;
  let smartleadStatsId = null;
  let campaignName = null;
  if (fu.source_pending_reply_id) {
    const { rows: [src] } = await db.query(
      'SELECT thread_context, smartlead_email_stats_id, campaign_name, campaign_id FROM pending_replies WHERE id = $1',
      [fu.source_pending_reply_id]
    );
    if (src) {
      threadContext = parseThreadContext(src.thread_context);
      smartleadStatsId = src.smartlead_email_stats_id;
      campaignName = campaignNameFromReply(src);
    }
  }
  if (
    !campaignName &&
    fu.platform === 'smartlead' &&
    client.smartlead_api_key &&
    fu.campaign_id
  ) {
    campaignName = await smartlead.resolveCampaignName(client.smartlead_api_key, fu.campaign_id);
  }

  const { rows: [newReply] } = await db.query(
    `INSERT INTO pending_replies
      (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email, linkedin_url,
       inbound_message, thread_context, classification, draft_reply, status, smartlead_email_stats_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'FOLLOW_UP', $11, 'pending', $12)
     RETURNING *`,
    [
      client.id,
      fu.platform,
      fu.campaign_id,
      campaignName || null,
      fu.lead_id,
      fu.lead_name,
      fu.lead_email,
      fu.linkedin_url,
      '(no new reply — follow-up re-attempt)',
      typeof threadContext === 'object' && threadContext !== null ? JSON.stringify(threadContext) : threadContext,
      draft,
      smartleadStatsId,
    ]
  );

  const sentAt = fu.sent_at instanceof Date ? fu.sent_at.toISOString() : String(fu.sent_at || '');
  const campaignDisplay = formatCampaignDisplay(campaignName, fu.campaign_id) || undefined;

  await postProspectSlackCard({
    token: client.slack_bot_token,
    channelId: client.slack_channel_id,
    clientId: client.id,
    platform: fu.platform,
    campaignId: fu.campaign_id,
    leadId: fu.lead_id,
    threadContext,
    isDraft: true,
    replyId: newReply.id,
    card: {
      replyId: newReply.id,
      leadName: fu.lead_name,
      leadEmail: fu.lead_email,
      platform: fu.platform,
      classification: 'FOLLOW_UP',
      draft,
      reasoning: reasoningExtra ||
        `No reply since we proposed a meeting (${sentAt}). Follow-up ${stepLabel(fu)} — AI drafted a re-attempt to book.`,
      inboundMessage: '(no new reply from prospect)',
      campaignDisplay,
      lastOutboundMessage: lastOutboundFor(fu.platform, threadContext) || undefined,
    },
  });

  return newReply;
}

async function resolve(fu, status, skipReason) {
  await db.query(
    `UPDATE outbound_follow_ups
        SET status = $1, skip_reason = $2, last_checked_at = now(),
            attempts = attempts + 1, updated_at = now()
      WHERE id = $3`,
    [status, skipReason || null, fu.id]
  );
}

function maxAgeHours() {
  const n = parseFloat(process.env.FOLLOW_UP_MAX_AGE_HOURS || '24');
  return Number.isFinite(n) && n > 0 ? n : 24;
}

/**
 * Retire follow-ups that came due long ago.
 *
 * Rows have been written on every send since this table existed but nothing
 * ever read them, so the backlog is large and stale. Nudging someone about a
 * thread from weeks ago is worse than staying quiet, and posting the whole
 * backlog would bury the channel. Retired in bulk, with no Slack post and no
 * per-row API calls.
 */
async function retireStaleFollowUps() {
  const { rowCount } = await db.query(
    `UPDATE outbound_follow_ups
        SET status = 'skipped', skip_reason = 'stale', last_checked_at = now(), updated_at = now()
      WHERE status = 'pending'
        AND due_at < now() - ($1::float * interval '1 hour')`,
    [maxAgeHours()]
  );
  if (rowCount) {
    console.log('[FollowUp] Retired stale follow-ups', { count: rowCount, olderThanHours: maxAgeHours() });
  }
  return rowCount || 0;
}

/**
 * Due follow-ups across all active clients.
 * Oldest due step per thread first — so a backlog of steps advances in order
 * (2h before 24h) instead of jumping to the latest.
 */
async function dueFollowUps(limit) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (f.client_id, f.platform, COALESCE(f.campaign_id, ''), COALESCE(f.lead_id, ''), COALESCE(f.conversation_id, ''))
            f.*, c.name AS client_name, c.slack_bot_token, c.slack_channel_id,
            c.voice_prompt, c.booking_link, c.digest_timezone, c.smartlead_api_key
       FROM outbound_follow_ups f
       JOIN clients c ON c.id = f.client_id
      WHERE f.status = 'pending'
        AND f.due_at <= now()
        AND f.due_at > now() - ($2::float * interval '1 hour')
        AND c.active IS DISTINCT FROM false
      ORDER BY f.client_id, f.platform, COALESCE(f.campaign_id, ''), COALESCE(f.lead_id, ''), COALESCE(f.conversation_id, ''), f.due_at ASC
      LIMIT $1`,
    [limit, maxAgeHours()]
  );
  return rows;
}

/**
 * Process every due follow-up: skip the ones that already booked or proposed a
 * time, post a Slack card for the rest.
 */
async function runDueFollowUps({ limit = 25 } = {}) {
  const retired = await retireStaleFollowUps();
  const rows = await dueFollowUps(limit);
  const totals = { posted: 0, skipped: 0, failed: 0, retired, skipReasons: {} };

  for (const fu of rows) {
    const client = {
      id: fu.client_id,
      name: fu.client_name,
      slack_bot_token: fu.slack_bot_token,
      slack_channel_id: fu.slack_channel_id,
      voice_prompt: fu.voice_prompt,
      booking_link: fu.booking_link,
      digest_timezone: fu.digest_timezone,
      smartlead_api_key: fu.smartlead_api_key,
    };

    try {
      const { isDisqualified } = require('./disqualified-prospects');
      if (await isDisqualified(fu.client_id, {
        platform: fu.platform,
        campaignId: fu.campaign_id,
        leadId: fu.lead_id,
        conversationId: fu.conversation_id,
        leadEmail: fu.lead_email,
        linkedinUrl: fu.linkedin_url,
      })) {
        await resolve(fu, 'skipped', 'disqualified');
        const cancelled = await cancelPendingForThread(fu.client_id, {
          platform: fu.platform,
          campaignId: fu.campaign_id,
          leadId: fu.lead_id,
          conversationId: fu.conversation_id,
        });
        totals.skipped++;
        totals.skipReasons.disqualified = (totals.skipReasons.disqualified || 0) + 1;
        console.log('[FollowUp] Skipped — prospect disqualified', {
          client: client.name, lead: fu.lead_name, cancelledLaterSteps: cancelled,
        });
        continue;
      }

      const bookedReason = await looksAlreadyBooked(fu.client_id, {
        platform: fu.platform,
        leadEmail: fu.lead_email,
        leadName: fu.lead_name,
        leadId: fu.lead_id,
        since: fu.sent_at,
      });

      if (bookedReason) {
        await resolve(fu, 'skipped', bookedReason);
        // Drop later cadence steps for this thread — already booked.
        const cancelled = await cancelPendingForThread(fu.client_id, {
          platform: fu.platform,
          campaignId: fu.campaign_id,
          leadId: fu.lead_id,
          conversationId: fu.conversation_id,
        });
        totals.skipped++;
        totals.skipReasons[bookedReason] = (totals.skipReasons[bookedReason] || 0) + 1;
        console.log('[FollowUp] Skipped — already handled', {
          client: client.name, lead: fu.lead_name, reason: bookedReason, cancelledLaterSteps: cancelled,
        });
        continue;
      }

      await postFollowUpCard(client, fu);
      await resolve(fu, 'notified', null);
      totals.posted++;
      console.log('[FollowUp] Posted follow-up card', {
        client: client.name, lead: fu.lead_name, step: fu.step, sequenceHours: fu.sequence_hours,
      });
    } catch (err) {
      totals.failed++;
      // Leave status pending so the next tick retries.
      await db.query(
        'UPDATE outbound_follow_ups SET last_checked_at = now(), attempts = attempts + 1, updated_at = now() WHERE id = $1',
        [fu.id]
      );
      console.error('[FollowUp] Failed', { followUpId: fu.id, lead: fu.lead_name, err: err.message });
    }
  }

  return totals;
}

module.exports = { runDueFollowUps, postFollowUpCard, dueFollowUps, retireStaleFollowUps, maxAgeHours };
