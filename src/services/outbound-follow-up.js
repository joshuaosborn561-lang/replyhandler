const db = require('../db');
const { isSlackTestFixtureReply } = require('./reply-send');

/**
 * Default cadence after we reply to a positive inbound:
 *   1) 3:30 PM America/Chicago the day the inbound arrived
 *      (next calendar day if inbound was at/after 2:00 PM Central, or if 3:30
 *      that day is already past when we schedule) — never sooner than 2h after
 *      our send
 *   2–4) 24h → 48h → 1 week after our send
 */
const DEFAULT_LATER_CADENCE_HOURS = [24, 48, 168];

/** Later-step hours only (first step is clock-based unless FOLLOW_UP_HOURS is set). */
const DEFAULT_CADENCE = [...DEFAULT_LATER_CADENCE_HOURS];

/** Never start a cadence from a send older than this (no deep backfill). */
const MAX_SCHEDULE_AGE_DAYS = 3;

const FOLLOW_UP_TZ = 'America/Chicago';
/** First bump wall-clock time in FOLLOW_UP_TZ. */
const FIRST_DUE_HOUR = 15;
const FIRST_DUE_MINUTE = 30;
/** Inbounds at/after this local hour skip same-day 3:30 and use the next day. */
const SAME_DAY_CUTOFF_HOUR = 14;
/** Hard floor: never ping sooner than this many hours after our send. */
const MIN_FOLLOW_UP_HOURS = 2;

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

function cadenceEnvRaw() {
  return process.env.FOLLOW_UP_HOURS || process.env.FOLLOW_UP_REMINDER_HOURS || '';
}

/** True when no FOLLOW_UP_HOURS override — first step uses 3:30pm Central clock. */
function usesClockFirstStep() {
  return !String(cadenceEnvRaw()).trim();
}

/**
 * Parse FOLLOW_UP_HOURS as a comma-separated cadence (hours).
 * Single number still works (one-step). Env override replaces the whole sequence
 * (including the default clock-based first step).
 *
 * With no env override, returns later-step hours only ([24, 48, 168]); the first
 * step is computed by firstFollowUpDueAt().
 */
function followUpCadenceHours() {
  const raw = cadenceEnvRaw();
  if (!String(raw).trim()) return [...DEFAULT_LATER_CADENCE_HOURS];

  const parts = String(raw)
    .split(/[,\s]+/)
    .map((p) => parseFloat(p))
    .filter((n) => Number.isFinite(n) && n > 0);

  return parts.length ? parts : [...DEFAULT_LATER_CADENCE_HOURS];
}

/** First step only — kept for older callers/tests. */
function followUpHours() {
  return followUpCadenceHours()[0];
}

function zonedParts(date, timeZone = FOLLOW_UP_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
  };
}

function addCalendarDays(year, month, day, days) {
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

/**
 * Instant for a civil wall-clock time in FOLLOW_UP_TZ (handles CST/CDT).
 */
function zonedWallTimeToUtc(year, month, day, hour, minute, second = 0, timeZone = FOLLOW_UP_TZ) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i += 1) {
    const p = zonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    guess += target - asUtc;
  }
  return new Date(guess);
}

/**
 * First follow-up due: 3:30 PM America/Chicago on the inbound's calendar day,
 * unless the inbound arrived at/after 2:00 PM Central (then next day 3:30).
 * If that instant is already past when scheduling, roll forward day-by-day.
 *
 * @param {Date|string|number} inboundAt when the prospect's reply came in
 * @param {Date|string|number} [now] schedule time (usually our send)
 */
function firstFollowUpDueAt(inboundAt, now = new Date()) {
  const inbound = inboundAt instanceof Date ? inboundAt : new Date(inboundAt);
  const scheduleNow = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(inbound.getTime())) {
    return firstFollowUpDueAt(scheduleNow, scheduleNow);
  }

  const p = zonedParts(inbound, FOLLOW_UP_TZ);
  let { year, month, day } = p;

  // At/after 2:00 PM Central → not same-day 3:30.
  if (p.hour >= SAME_DAY_CUTOFF_HOUR) {
    ({ year, month, day } = addCalendarDays(year, month, day, 1));
  }

  let due = zonedWallTimeToUtc(year, month, day, FIRST_DUE_HOUR, FIRST_DUE_MINUTE);
  let guard = 0;
  while (due.getTime() <= scheduleNow.getTime() && guard < 14) {
    ({ year, month, day } = addCalendarDays(year, month, day, 1));
    due = zonedWallTimeToUtc(year, month, day, FIRST_DUE_HOUR, FIRST_DUE_MINUTE);
    guard += 1;
  }
  return due;
}

function hoursBetween(from, to) {
  const ms = to.getTime() - from.getTime();
  return Math.round((ms / 3600000) * 100) / 100;
}

/** Never schedule a due time earlier than sentAt + MIN_FOLLOW_UP_HOURS. */
function enforceMinFollowUpDelay(due, sentAt, minHours = MIN_FOLLOW_UP_HOURS) {
  const sent = sentAt instanceof Date ? sentAt : new Date(sentAt);
  const target = due instanceof Date ? due : new Date(due);
  const floorMs = sent.getTime() + Math.round(minHours * 3600 * 1000);
  if (!Number.isFinite(target.getTime()) || target.getTime() < floorMs) {
    return new Date(floorMs);
  }
  return target;
}

/**
 * Build { due, sequenceHours } rows for the cadence.
 * Default: clock first step + later hour offsets from sentAt.
 * FOLLOW_UP_HOURS override: every step is hours from sentAt.
 * Every step is clamped to ≥ MIN_FOLLOW_UP_HOURS after our send.
 */
function buildCadenceSteps(sentAt, inboundAt) {
  const sent = sentAt instanceof Date ? sentAt : new Date(sentAt);

  if (!usesClockFirstStep()) {
    return followUpCadenceHours().map((hours) => {
      const clampedHours = Math.max(hours, MIN_FOLLOW_UP_HOURS);
      return {
        due: new Date(sent.getTime() + Math.round(clampedHours * 3600 * 1000)),
        sequenceHours: clampedHours,
      };
    });
  }

  const firstDue = enforceMinFollowUpDelay(
    firstFollowUpDueAt(inboundAt || sent, sent),
    sent
  );
  const steps = [
    {
      due: firstDue,
      sequenceHours: hoursBetween(sent, firstDue),
    },
  ];
  for (const hours of DEFAULT_LATER_CADENCE_HOURS) {
    const clampedHours = Math.max(hours, MIN_FOLLOW_UP_HOURS);
    steps.push({
      due: new Date(sent.getTime() + Math.round(clampedHours * 3600 * 1000)),
      sequenceHours: clampedHours,
    });
  }
  return steps;
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
 * Starts the cadence for every positive inbound (INTERESTED / MEETING_PROPOSED /
 * QUESTION): 3:30pm CT the day the reply came in (next day if after 2pm CT),
 * then 24h → 48h → 1w after our send. FOLLOW_UP sends do not restart the clock.
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

  const sentAt = new Date();
  // created_at is when the inbound pending_reply row was created (prospect replied).
  const inboundAt = reply.created_at ? new Date(reply.created_at) : sentAt;
  const steps = buildCadenceSteps(sentAt, inboundAt);

  await cancelPendingForThread(clientId, { platform, campaignId, leadId, conversationId });

  for (let i = 0; i < steps.length; i++) {
    const { due, sequenceHours } = steps[i];
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
        sequenceHours,
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
    clockFirst: usesClockFirstStep(),
    inboundAt: inboundAt.toISOString(),
    steps: steps.map((s) => ({ dueAt: s.due.toISOString(), hours: s.sequenceHours })),
    sentAt: sentAt.toISOString(),
  });
}

/**
 * Prospect replied — cancel pending follow-up for this thread.
 */
async function cancelPendingForLead({ clientId = null, leadEmail, leadName } = {}) {
  const email = leadEmail ? String(leadEmail).trim().toLowerCase() : '';
  const name = leadName ? String(leadName).trim() : '';
  if (!email && !name) return { followUps: 0, replies: 0 };

  const follow = await db.query(
    `UPDATE outbound_follow_ups SET status = 'cancelled', updated_at = now()
      WHERE status = 'pending'
        AND ($1::uuid IS NULL OR client_id = $1)
        AND (
          ($2::text <> '' AND lower(COALESCE(lead_email, '')) = $2)
          OR ($3::text <> '' AND lower(COALESCE(lead_name, '')) = lower($3))
        )`,
    [clientId || null, email, name]
  );
  const replies = await db.query(
    `UPDATE pending_replies
        SET status = 'suppressed',
            suppression_reason = COALESCE(suppression_reason, 'follow_up_stopped'),
            updated_at = now()
      WHERE status IN ('pending', 'alert_only', 'flagged')
        AND classification = 'FOLLOW_UP'
        AND ($1::uuid IS NULL OR client_id = $1)
        AND (
          ($2::text <> '' AND lower(COALESCE(lead_email, '')) = $2)
          OR ($3::text <> '' AND lower(COALESCE(lead_name, '')) = lower($3))
        )`,
    [clientId || null, email, name]
  );
  return { followUps: follow.rowCount || 0, replies: replies.rowCount || 0 };
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

module.exports = {
  scheduleAfterOutboundSend,
  cancelForInboundReply,
  cancelPendingForThread,
  cancelPendingForLead,
  followUpHours,
  followUpCadenceHours,
  usesClockFirstStep,
  firstFollowUpDueAt,
  buildCadenceSteps,
  zonedWallTimeToUtc,
  heyreachConversationId,
  isPositiveFollowUpClassification,
  POSITIVE_FOLLOW_UP_CLASSIFICATIONS,
  DEFAULT_CADENCE,
  DEFAULT_LATER_CADENCE_HOURS,
  MAX_SCHEDULE_AGE_DAYS,
  MIN_FOLLOW_UP_HOURS,
  FOLLOW_UP_TZ,
  FIRST_DUE_HOUR,
  FIRST_DUE_MINUTE,
  SAME_DAY_CUTOFF_HOUR,
  enforceMinFollowUpDelay,
};
