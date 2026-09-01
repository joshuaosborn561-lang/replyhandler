const db = require('../db');
const { isSlackTestFixtureReply } = require('./reply-send');

/** Default: 2h → 24h → 48h → 1 week after we reply to a positive inbound. */
const DEFAULT_CADENCE = [2, 24, 48, 168];

/** Never start a cadence from a send older than this (no deep backfill). */
const MAX_SCHEDULE_AGE_DAYS = 3;

/**
 * Inbound classifications that start the follow-up cadence when we send our reply.
 * Matches the "positive" set used for phone enrichment.
 */
const POSITIVE_FOLLOW_UP_CLASSIFICATIONS = new Set([
  'INTERESTED',
  'MEETING_PROPOSED',
  'QUESTION',
]);

function isPositiveFollowUpClassification(classification) {
  return POSITIVE_FOLLOW_UP_CLASSIFICATIONS.has(String(classification || '').toUpperCase());
}

/**
 * Parse FOLLOW_UP_HOURS as a comma-separated cadence (hours).
 * Single number still works (one-step). Env override replaces the whole sequence.
 */
function followUpCadenceHours() {
  const raw = process.env.FOLLOW_UP_HOURS || process.env.FOLLOW_UP_REMINDER_HOURS || '';
  if (!String(raw).trim()) return [...DEFAULT_CADENCE];

  const parts = String(raw)
    .split(/[,\s]+/)
    .map((p) => parseFloat(p))
    .filter((n) => Number.isFinite(n) && n > 0);

  return parts.length ? parts : [...DEFAULT_CADENCE];
}

/** First step only — kept for older callers/tests. */
function followUpHours() {
  return followUpCadenceHours()[0];
}

function parseThreadContext(reply) {
  if (!reply?.thread_context) return {};
  try {
    return typeof reply.thread_context === 'string'
      ? JSON.parse(reply.thread_context)
      : reply.thread_context;
  } catch {
    return {};
  }
}

function heyreachConversationId(reply) {
  const ctx = parseThreadContext(reply);
  return ctx?.heyreach?.conversationId || null;
}

function threadMatchParams(reply) {
  const platform = reply.platform;
  const campaignId = reply.campaign_id != null ? String(reply.campaign_id) : null;
  const leadId = reply.lead_id != null ? String(reply.lead_id) : null;
  const conversationId = platform === 'heyreach' ? heyreachConversationId(reply) : null;
  return { platform, campaignId, leadId, conversationId };
}

/** Cancel every pending step for this prospect thread. */
async function cancelPendingForThread(clientId, { platform, campaignId, leadId, conversationId }) {
  const result = await db.query(
    `UPDATE outbound_follow_ups SET status = 'cancelled', updated_at = now()
     WHERE client_id = $1 AND platform = $2 AND status = 'pending'
       AND COALESCE(campaign_id, '') = COALESCE($3, '')
       AND COALESCE(lead_id, '') = COALESCE($4, '')
       AND COALESCE(conversation_id, '') = COALESCE($5, '')`,
    [
      clientId,
      platform,
      campaignId != null ? String(campaignId) : null,
      leadId != null ? String(leadId) : null,
      conversationId != null ? String(conversationId) : null,
    ]
  );
  return result.rowCount || 0;
}

/**
 * After we successfully send a prospect-facing message (Slack approve/edit).
 *
 * Starts the 2h → 24h → 48h → 1w cadence for every positive inbound
 * (INTERESTED / MEETING_PROPOSED / QUESTION). FOLLOW_UP sends do not restart
 * the clock — later steps from the original send keep their due times.
 */
async function scheduleAfterOutboundSend(clientId, reply) {
  if (!reply || isSlackTestFixtureReply(reply)) return;

  const platform = reply.platform;
  if (platform !== 'smartlead' && platform !== 'heyreach') return;

  // Follow-up cards are steps in an existing sequence — do not reschedule.
  if (String(reply.classification || '').toUpperCase() === 'FOLLOW_UP') {
    console.log('[FollowUp] Skip schedule — FOLLOW_UP send keeps existing cadence', {
      replyId: reply.id,
    });
    return;
  }

  const { isReplyDisqualified } = require('./disqualified-prospects');
  if (await isReplyDisqualified(clientId, reply)) {
    console.log('[FollowUp] Skip schedule — prospect disqualified', {
      replyId: reply.id,
      lead: reply.lead_name,
    });
    return;
  }

  if (!isPositiveFollowUpClassification(reply.classification)) {
    console.log('[FollowUp] Skip schedule — inbound was not positive', {
      replyId: reply.id,
      lead: reply.lead_name,
      classification: reply.classification,
    });
    return;
  }

  // Refuse deep backfills — only schedule from recent sends.
  const sentAtCandidate = reply.updated_at || reply.created_at || null;
  if (sentAtCandidate) {
    const sentMs = new Date(sentAtCandidate).getTime();
    if (Number.isFinite(sentMs)) {
      const ageDays = (Date.now() - sentMs) / (24 * 3600 * 1000);
      if (ageDays > MAX_SCHEDULE_AGE_DAYS) {
        console.log('[FollowUp] Skip schedule — send older than 3 days', {
          replyId: reply.id,
          lead: reply.lead_name,
          ageDays: Math.round(ageDays * 10) / 10,
        });
        return;
      }
    }
  }

  const { campaignId, leadId, conversationId } = threadMatchParams(reply);

  if (platform === 'smartlead' && (!campaignId || !leadId)) {
    console.warn('[FollowUp] Skip schedule — SmartLead missing campaign_id or lead_id', { replyId: reply.id });
    return;
  }
  if (platform === 'heyreach' && !leadId && !conversationId) {
    console.warn('[FollowUp] Skip schedule — HeyReach missing lead/conversation id', { replyId: reply.id });
    return;
  }

  const cadence = followUpCadenceHours();
  const sentAt = new Date();

  await cancelPendingForThread(clientId, { platform, campaignId, leadId, conversationId });

  for (let i = 0; i < cadence.length; i++) {
    const hours = cadence[i];
    const due = new Date(sentAt.getTime() + Math.round(hours * 3600 * 1000));
    await db.query(
      `INSERT INTO outbound_follow_ups
        (client_id, platform, campaign_id, lead_id, conversation_id, lead_name, lead_email, linkedin_url,
         source_pending_reply_id, sent_at, due_at, status, step, sequence_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13)`,
      [
        clientId,
        platform,
        campaignId,
        leadId,
        conversationId,
        reply.lead_name || null,
        reply.lead_email || null,
        reply.linkedin_url || null,
        reply.id,
        sentAt,
        due,
        i + 1,
        hours,
      ]
    );
  }

  console.log('[FollowUp] Scheduled cadence', {
    clientId,
    platform,
    campaignId,
    leadId,
    conversationId,
    classification: reply.classification,
    steps: cadence,
    sentAt: sentAt.toISOString(),
  });
}

/**
 * Prospect replied — cancel pending follow-up for this thread.
 */
async function cancelForInboundReply({ clientId, platform, campaignId, leadId, conversationId }) {
  const camp = campaignId != null ? String(campaignId) : '';
  const lead = leadId != null ? String(leadId) : '';
  const conv = conversationId != null ? String(conversationId) : '';

  let result;
  if (platform === 'smartlead') {
    result = await db.query(
      `UPDATE outbound_follow_ups SET status = 'cancelled', updated_at = now()
       WHERE client_id = $1 AND platform = 'smartlead' AND status = 'pending'
         AND COALESCE(campaign_id, '') = $2 AND COALESCE(lead_id, '') = $3`,
      [clientId, camp, lead]
    );
  } else {
    result = await db.query(
      `UPDATE outbound_follow_ups SET status = 'cancelled', updated_at = now()
       WHERE client_id = $1 AND platform = 'heyreach' AND status = 'pending'
         AND (
           ($2::text <> '' AND COALESCE(conversation_id, '') = $2)
           OR ($3::text <> '' AND COALESCE(lead_id, '') = $3)
         )`,
      [clientId, conv, lead]
    );
  }

  const rowCount = result.rowCount || 0;
  if (rowCount > 0) {
    console.log('[FollowUp] Cancelled pending reminder(s) on inbound reply', {
      clientId,
      platform,
      rowCount,
    });
  }
}

/**
 * Undo Slack "Meeting booked" / booking-bridge for a lead and start the
 * 2h → 24h → 48h → 1w cadence again from now.
 *
 * Clears booked/proposed meeting rows so the runner does not skip as
 * already booked. Does not touch calendar events — a real hold on the
 * calendar still suppresses.
 */
async function restartFollowUpsForLead({
  clientId = null,
  leadEmail,
  leadName,
  postNow = true,
} = {}) {
  const email = String(leadEmail || '').trim().toLowerCase();
  const name = String(leadName || '').trim();
  if (!email && !name) {
    throw new Error('leadEmail or leadName is required');
  }

  const positives = [...POSITIVE_FOLLOW_UP_CLASSIFICATIONS];
  const { rows: replies } = await db.query(
    `SELECT *
       FROM pending_replies
      WHERE status = 'sent'
        AND ($1::uuid IS NULL OR client_id = $1)
        AND upper(COALESCE(classification, '')) = ANY($4::text[])
        AND (
          ($2::text <> '' AND lower(COALESCE(lead_email, '')) = $2)
          OR ($3::text <> '' AND lower(COALESCE(lead_name, '')) = lower($3))
        )
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 40`,
    [clientId || null, email, name, positives]
  );

  if (!replies.length) {
    return { ok: false, error: 'no sent positive reply found for this lead', restarted: [] };
  }

  const latestByClient = new Map();
  for (const reply of replies) {
    if (!latestByClient.has(reply.client_id)) latestByClient.set(reply.client_id, reply);
  }

  const restarted = [];
  for (const [cid, reply] of latestByClient) {
    const matchEmail = email || String(reply.lead_email || '').trim().toLowerCase();
    const matchName = name || String(reply.lead_name || '').trim();

    const meetings = await db.query(
      `UPDATE meetings
          SET status = 'cancelled', updated_at = now()
        WHERE client_id = $1
          AND status IN ('proposed', 'confirmed', 'booked')
          AND (
            ($2::text <> '' AND lower(COALESCE(lead_email, '')) = $2)
            OR ($3::text <> '' AND lower(COALESCE(lead_name, '')) = lower($3))
          )`,
      [cid, matchEmail, matchName]
    );

    await scheduleAfterOutboundSend(cid, {
      ...reply,
      updated_at: new Date(),
      created_at: new Date(),
    });

    let postedReplyId = null;
    if (postNow) {
      const { rows: [fu] } = await db.query(
        `SELECT * FROM outbound_follow_ups
          WHERE client_id = $1
            AND status = 'pending'
            AND step = 1
            AND source_pending_reply_id = $2
          ORDER BY due_at ASC
          LIMIT 1`,
        [cid, reply.id]
      );
      if (fu) {
        const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [cid]);
        if (client) {
          const { postFollowUpCard } = require('./follow-up-runner');
          const posted = await postFollowUpCard(client, fu, {
            reasoningExtra: 'Cadence restarted — Meeting booked cleared. Follow-up step 1 (2h) posted now.',
          });
          postedReplyId = posted?.id || null;
          await db.query(
            `UPDATE outbound_follow_ups
                SET status = 'notified', skip_reason = NULL, last_checked_at = now(),
                    attempts = attempts + 1, updated_at = now()
              WHERE id = $1`,
            [fu.id]
          );
        }
      }
    }

    console.log('[FollowUp] Restarted cadence', {
      clientId: cid,
      lead: reply.lead_name,
      email: reply.lead_email,
      sourceReplyId: reply.id,
      meetingsCleared: meetings.rowCount || 0,
      postedReplyId,
    });
    restarted.push({
      clientId: cid,
      leadName: reply.lead_name,
      leadEmail: reply.lead_email,
      sourceReplyId: reply.id,
      meetingsCleared: meetings.rowCount || 0,
      postedReplyId,
    });
  }

  return { ok: true, restarted };
}

module.exports = {
  scheduleAfterOutboundSend,
  cancelForInboundReply,
  cancelPendingForThread,
  restartFollowUpsForLead,
  followUpHours,
  followUpCadenceHours,
  heyreachConversationId,
  isPositiveFollowUpClassification,
  POSITIVE_FOLLOW_UP_CLASSIFICATIONS,
  DEFAULT_CADENCE,
  MAX_SCHEDULE_AGE_DAYS,
};
