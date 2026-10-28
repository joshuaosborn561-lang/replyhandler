const db = require('../db');
const { phoneForFollowUp, claimDailyCallReminder, reminderLine, leadKey } = require('./follow-up-call-reminder');
const { postProspectSlackCard } = require('./slack-reply-post');
const { draftReattemptToBook, resetFollowUpClaudeBudget, followUpClaudeBudgetSnapshot } = require('./follow-up-drafts');
const { attachFollowUpMeta } = require('../utils/follow-up-meta');
const { daysSinceLastMessage } = require('../utils/follow-up-thread-display');
const { clientLoopContact } = require('../utils/client-loop-contact');
const { looksAlreadyBooked } = require('./booking-check');
const {
  cancelPendingForThread,
  inSendWindow,
  snapDueToSendWindow,
} = require('./outbound-follow-up');
const smartlead = require('./smartlead');
const slack = require('./slack');
const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');
const { extractThreadMessages } = require('../utils/thread-transcript');
const { prospectBookingLink } = require('../utils/public-booking-link');
const { resolveVerifiedSchedulingSlots, slotOffsetForFollowUpStep } = require('./scheduling-slots');
const { prefersInPersonMeeting } = require('../utils/meeting-modality');
const { isLeadClaimed, cancelClaimedLeadWork } = require('./client-claimed');
const { isPostedSlackTs } = require('./reply-dedupe');

/** Shared Slack channel for all FOLLOW_UP bumps (not per-client inbox channels). */
const DEFAULT_FOLLOW_UP_SLACK_CHANNEL_ID = 'C0BRRS8DV19';

function followUpSlackChannelId() {
  const fromEnv = String(process.env.FOLLOW_UP_SLACK_CHANNEL_ID || '').trim();
  return fromEnv || DEFAULT_FOLLOW_UP_SLACK_CHANNEL_ID;
}

/** Placeholder inbound text used on FOLLOW_UP rows — not real prospect context. */
function isFollowUpPlaceholder(text) {
  const s = String(text || '').trim().toLowerCase();
  return !s
    || s.startsWith('(no new reply')
    || s.includes('follow-up re-attempt');
}

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

/** True when we have already sent a prospect-facing reply on this thread. */
async function threadHasOurSend(clientId, fu) {
  if (fu?.source_pending_reply_id) {
    const { rows: [src] } = await db.query(
      `SELECT sent_reply FROM pending_replies WHERE id = $1`,
      [fu.source_pending_reply_id]
    );
    if (src && String(src.sent_reply || '').trim()) return true;
  }
  const extras = await priorSentMessages(clientId, fu);
  return extras.some((m) => m.role === 'us' && String(m.body || '').trim());
}

/** Prior sent messages on this thread (first reply + earlier FOLLOW_UP sends). */
async function priorSentMessages(clientId, fu) {
  const { rows } = await db.query(
    `SELECT sent_reply, inbound_message, classification, updated_at
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND status = 'sent'
        AND sent_reply IS NOT NULL
        AND trim(sent_reply) <> ''
        AND (
          ($3::text <> '' AND COALESCE(lead_id, '') = $3)
          OR ($4::text <> '' AND lower(COALESCE(lead_email, '')) = $4)
        )
      ORDER BY updated_at ASC
      LIMIT 20`,
    [
      clientId,
      fu.platform,
      fu.lead_id != null ? String(fu.lead_id) : '',
      fu.lead_email ? String(fu.lead_email).trim().toLowerCase() : '',
    ]
  );
  const extras = [];
  for (const r of rows) {
    if (r.inbound_message && !isFollowUpPlaceholder(r.inbound_message)
        && String(r.classification || '').toUpperCase() !== 'FOLLOW_UP') {
      extras.push({ role: 'them', body: r.inbound_message, time: r.updated_at });
    }
    extras.push({ role: 'us', body: r.sent_reply, time: r.updated_at });
  }
  return extras;
}

let followUpRunActive = false;

async function releaseStaleFollowUpClaims() {
  const { rowCount } = await db.query(
    `UPDATE outbound_follow_ups
        SET status = 'pending', updated_at = now()
      WHERE status = 'posting'
        AND updated_at < now() - interval '15 minutes'`
  );
  return rowCount || 0;
}

function isUniqueViolation(err) {
  return Boolean(err && err.code === '23505');
}

/**
 * A card already exists for this cadence step (this follow-up row, or the
 * same source reply + step + person). Later steps are a different step
 * number, so they still post.
 */
async function findExistingFollowUpCard(clientId, fu) {
  const step = Number(fu.step) || 1;
  const { rows } = await db.query(
    `SELECT id, slack_message_ts, status, follow_up_id
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND classification = 'FOLLOW_UP'
        AND status IN ('pending', 'flagged', 'approved', 'sending', 'sent', 'skipped', 'rejected')
        AND (
          follow_up_id = $3::uuid
          OR (
            follow_up_step = $4
            AND follow_up_source_id IS NOT DISTINCT FROM $5::uuid
            AND $5::uuid IS NOT NULL
            AND (
              ($6::text <> '' AND COALESCE(lead_id, '') = $6)
              OR ($7::text <> '' AND lower(COALESCE(lead_email, '')) = $7)
            )
          )
        )
      ORDER BY created_at ASC
      LIMIT 1`,
    [
      clientId,
      fu.platform,
      fu.id,
      step,
      fu.source_pending_reply_id || null,
      fu.lead_id != null ? String(fu.lead_id) : '',
      fu.lead_email ? String(fu.lead_email).trim().toLowerCase() : '',
    ]
  );
  return rows[0] || null;
}

/** Post one follow-up card. Returns the pending_replies row, or null when another worker owns the step. */
async function postFollowUpCard(client, fu, { reasoningExtra } = {}) {
  await releaseStaleFollowUpClaims();
  const { rows: claimedRows } = await db.query(
    `UPDATE outbound_follow_ups
        SET status = 'posting', updated_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [fu.id]
  );
  if (!claimedRows[0]) {
    console.log('[FollowUp] Skip card — step already claimed or no longer pending', {
      followUpId: fu.id, lead: fu.lead_name, step: fu.step,
    });
    return null;
  }

  let slackPosted = false;
  try {
    const existing = await findExistingFollowUpCard(client.id, fu);
    if (existing && String(existing.follow_up_id || '') !== String(fu.id)) {
      await resolve(fu, 'skipped', 'duplicate_step');
      console.log('[FollowUp] Skip card — this step already has a card', {
        followUpId: fu.id, existingReplyId: existing.id, lead: fu.lead_name,
      });
      return null;
    }
    if (existing && isPostedSlackTs(existing.slack_message_ts)) {
      await resolve(fu, 'notified', null);
      return existing;
    }

  let threadContext = null;
  let smartleadStatsId = null;
  let campaignName = null;
  let originalInbound = '';
  let ourLastSend = '';
  let sourceSlackTs = null;
  if (fu.source_pending_reply_id) {
    const { rows: [src] } = await db.query(
      `SELECT thread_context, smartlead_email_stats_id, campaign_name, campaign_id,
              inbound_message, sent_reply, draft_reply, slack_message_ts
         FROM pending_replies WHERE id = $1`,
      [fu.source_pending_reply_id]
    );
    if (src) {
      threadContext = parseThreadContext(src.thread_context);
      smartleadStatsId = src.smartlead_email_stats_id;
      campaignName = campaignNameFromReply(src);
      if (!isFollowUpPlaceholder(src.inbound_message)) {
        originalInbound = String(src.inbound_message || '').trim();
      }
      ourLastSend = String(src.sent_reply || '').trim();
      sourceSlackTs = src.slack_message_ts || null;
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

  // Campaign sequence mail in SmartLead history is not "we replied". Follow-ups
  // only fire after a Slack-approved send on this thread.
  if (!(await threadHasOurSend(client.id, fu))) {
    const err = new Error('no_prior_send');
    err.code = 'no_prior_send';
    throw err;
  }
  if (await isLeadClaimed({ leadEmail: fu.lead_email, campaignId: fu.campaign_id })) {
    const err = new Error('client_claimed');
    err.code = 'client_claimed';
    throw err;
  }
  const lastOutbound = ourLastSend || lastOutboundFor(fu.platform, threadContext) || '';
  const inboundForCard = originalInbound || '(no new reply from prospect)';
  const { prefersCallbackCall } = require('../utils/meeting-modality');
  const inPerson = prefersInPersonMeeting(client.voice_prompt);
  const callback = prefersCallbackCall(client.voice_prompt, client.name);
  const bookingLink = (inPerson || callback)
    ? ''
    : prospectBookingLink({
      clientName: client.name,
      bookingLink: client.booking_link,
    });

  let slots = [];
  const step = Number(fu.step) || 1;
  if (step >= 2 && !callback) {
    try {
      const resolved = await resolveVerifiedSchedulingSlots(client, {
        offset: slotOffsetForFollowUpStep(step),
        count: 2,
      });
      slots = resolved.slots || [];
    } catch (err) {
      console.warn('[FollowUp] scheduling slots failed', { err: err.message, step });
    }
  }

  const sentExtras = await priorSentMessages(client.id, fu);
  const threadMessages = extractThreadMessages(fu.platform, threadContext, {
    maxMessages: 40,
    pinStart: true,
    extraMessages: [
      ...sentExtras,
      ...(originalInbound ? [{ role: 'them', body: originalInbound }] : []),
      ...(lastOutbound ? [{ role: 'us', body: lastOutbound }] : []),
    ],
  });
  const daysSince = daysSinceLastMessage(threadMessages, fu.sent_at);
  let learnedVoiceBlock = '';
  try {
    const { loadLearnedVoiceBlock } = require('./voice-profile');
    learnedVoiceBlock = await loadLearnedVoiceBlock({
      clientId: client.id,
      clientName: client.name,
    }) || '';
  } catch (err) {
    console.warn('[FollowUp] Learned voice unavailable', { err: err.message });
  }
  const loopContact = clientLoopContact({
    voicePrompt: client.voice_prompt,
    clientName: client.name,
  });

  const drafted = await draftReattemptToBook({
    leadName: fu.lead_name,
    platform: fu.platform,
    voicePrompt: client.voice_prompt,
    bookingLink,
    lastInboundMessage: originalInbound || null,
    lastOutboundMessage: lastOutbound || null,
    digestTimezone: client.digest_timezone,
    step,
    slots,
    clientName: client.name,
    clientId: client.id,
    loopContact,
    threadContext,
    threadMessages,
    learnedVoiceBlock,
    daysSinceLastMessage: daysSince,
  });
  const draft = typeof drafted === 'string' ? drafted : (drafted && drafted.text) || '';
  const needsClient = Boolean(drafted && drafted.needsClient);
  const whatToSend = needsClient ? (drafted.whatToSend || 'info') : null;
  const storedContext = attachFollowUpMeta(threadContext, { needsClient, whatToSend });

  let newReply = null;
  if (existing && String(existing.follow_up_id || '') === String(fu.id)) {
    const { rows } = await db.query(
      `UPDATE pending_replies
          SET draft_reply = $2, thread_context = $3, inbound_message = $4,
              campaign_name = COALESCE(campaign_name, $5),
              follow_up_step = $6, follow_up_source_id = $7, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        existing.id,
        draft,
        JSON.stringify(storedContext),
        inboundForCard,
        campaignName || null,
        step,
        fu.source_pending_reply_id || null,
      ]
    );
    newReply = rows[0] || null;
  } else {
    try {
      const { rows } = await db.query(
        `INSERT INTO pending_replies
          (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email, linkedin_url,
           inbound_message, thread_context, classification, draft_reply, status, smartlead_email_stats_id,
           follow_up_id, follow_up_step, follow_up_source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'FOLLOW_UP', $11, 'pending', $12, $13, $14, $15)
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
          // Store the original prospect reply so Approve/confirm cards keep thread context.
          inboundForCard,
          JSON.stringify(storedContext),
          draft,
          smartleadStatsId,
          fu.id,
          step,
          fu.source_pending_reply_id || null,
        ]
      );
      newReply = rows[0] || null;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const { rows } = await db.query(
        'SELECT * FROM pending_replies WHERE follow_up_id = $1 ORDER BY created_at ASC LIMIT 1',
        [fu.id]
      );
      newReply = rows[0] || null;
      if (newReply && isPostedSlackTs(newReply.slack_message_ts)) {
        slackPosted = true;
        await resolve(fu, 'notified', null);
        return newReply;
      }
    }
  }
  if (!newReply) {
    throw new Error('follow_up_card_insert_failed');
  }

  const sentAt = fu.sent_at instanceof Date ? fu.sent_at.toISOString() : String(fu.sent_at || '');
  // Phone on every follow-up card, plus a once-a-day "call before sending" reminder.
  let leadPhone = null;
  let phoneProvider = null;
  let callReminder = '';
  try {
    const found = await phoneForFollowUp(db, {
      clientId: client.id,
      sourceReplyId: fu.source_pending_reply_id,
      leadEmail: fu.lead_email,
      linkedinUrl: fu.linkedin_url,
    });
    leadPhone = found.phone;
    phoneProvider = found.provider;
    if (leadPhone && await claimDailyCallReminder(db, {
      key: leadKey({ clientId: client.id, leadEmail: fu.lead_email, linkedinUrl: fu.linkedin_url, leadId: fu.lead_id }),
      phone: leadPhone,
      replyId: newReply.id,
    })) {
      callReminder = reminderLine(leadPhone);
    }
  } catch (err) {
    console.warn('[FollowUp] Phone / call reminder lookup failed', { followUpId: fu.id, err: err.message });
  }
  const campaignDisplay = formatCampaignDisplay(campaignName, fu.campaign_id) || undefined;
  // Permalink still points at the original card in the client's main inbox channel.
  const threadPermalink = await slack.getPermalink(
    client.slack_bot_token,
    client.slack_channel_id,
    sourceSlackTs,
  );

  // Same context block as the sequence cards, from the stored source reply (no model calls).
  let followupContext = null;
  if (fu.source_pending_reply_id) {
    try {
      const { rows: [srcRow] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [fu.source_pending_reply_id]);
      if (srcRow) {
        const { loadFollowupContext } = require('./followup-card-context');
        const { pickOffer } = require('../utils/followup-card-context');
        followupContext = await loadFollowupContext({
          client,
          source: srcRow,
          phone: leadPhone || '',
          offer: pickOffer({ icpProfile: client.icp_profile }).text,
          permalink: threadPermalink || null,
        });
      }
    } catch (err) {
      console.warn('[FollowUp] card context failed, posting without it', { followUpId: fu.id, err: err.message });
    }
  }

  // FOLLOW_UP bumps go to the dedicated follow-ups channel (top-level, not threaded
  // under the original card). WILL SEND + buttons first, then the full thread.
  const postedCard = await postProspectSlackCard({
    token: client.slack_bot_token,
    channelId: followUpSlackChannelId(),
    clientId: client.id,
    platform: fu.platform,
    campaignId: fu.campaign_id,
    leadId: fu.lead_id,
    threadContext,
    isDraft: true,
    replyId: newReply.id,
    postInThread: false,
    card: {
      replyId: newReply.id,
      leadName: fu.lead_name,
      leadEmail: fu.lead_email,
      linkedinUrl: fu.linkedin_url || undefined,
      leadWebsite: fu.lead_website || undefined,
      platform: fu.platform,
      classification: 'FOLLOW_UP',
      draft,
      leadPhone: leadPhone || undefined,
      phoneProvider: phoneProvider || undefined,
      reasoning: (callReminder ? `${callReminder} · ` : '') + (reasoningExtra ||
        `No reply since our last send (${sentAt}). Follow-up ${stepLabel(fu)}${daysSince != null ? ` · ${daysSince}d since last message` : ''}${drafted && drafted.source && drafted.source !== 'claude' ? ` · ${drafted.source}` : ''}.`),
      needsClient,
      whatToSend,
      ccEmails: client.cc_emails || client.cc_email || undefined,
      inboundMessage: inboundForCard,
      campaignDisplay,
      lastOutboundMessage: lastOutbound || undefined,
      contextLabel: 'You sent',
      threadPermalink: threadPermalink || undefined,
      followupContext: followupContext || undefined,
      threadMessages,
    },
  });
  slackPosted = true;
  if (postedCard && postedCard.skipped && !isPostedSlackTs(postedCard.ts)) {
    console.log('[FollowUp] Slack post skipped', {
      followUpId: fu.id, replyId: newReply.id, reason: postedCard.reason,
    });
  }
  await resolve(fu, 'notified', null);
  return newReply;
  } catch (err) {
    if (!slackPosted) {
      await db.query(
        `UPDATE outbound_follow_ups
            SET status = 'pending', updated_at = now()
          WHERE id = $1 AND status = 'posting'`,
        [fu.id]
      ).catch((revertErr) => {
        console.warn('[FollowUp] Could not release step claim', {
          followUpId: fu.id, err: revertErr.message,
        });
      });
    } else {
      await resolve(fu, 'notified', null).catch(() => {});
    }
    throw err;
  }
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
/**
 * Rows scheduled onto a night or weekend would sit pending until they trip
 * FOLLOW_UP_MAX_AGE_HOURS and die as stale. Snap those due_ats into the next
 * weekday window so Monday still fires.
 */
async function deferOffHoursFollowUps() {
  const { rows } = await db.query(
    `SELECT id, due_at FROM outbound_follow_ups WHERE status = 'pending'`
  );
  let deferred = 0;
  for (const row of rows) {
    const due = new Date(row.due_at);
    if (inSendWindow(due)) continue;
    const next = snapDueToSendWindow(due);
    if (!Number.isFinite(next.getTime()) || next.getTime() === due.getTime()) continue;
    await db.query(
      `UPDATE outbound_follow_ups
          SET due_at = $1, updated_at = now()
        WHERE id = $2 AND status = 'pending'`,
      [next, row.id]
    );
    deferred += 1;
  }
  if (deferred) {
    console.log('[FollowUp] Deferred off-hours follow-ups into send window', { count: deferred });
  }
  return deferred;
}

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
            c.voice_prompt, c.booking_link, c.digest_timezone, c.smartlead_api_key, c.smartlead_use_master_key,
            c.cc_email, c.cc_emails
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
  if (followUpRunActive) {
    console.log('[FollowUp] Previous run still active; skipping');
    return {
      posted: 0, skipped: 0, failed: 0, retired: 0, deferred: 0,
      skipReasons: { overlap: 1 },
    };
  }
  followUpRunActive = true;
  try {
  resetFollowUpClaudeBudget();
  const deferred = await deferOffHoursFollowUps();
  // Do not post — and do not retire as stale — at night or on the weekend.
  // Stale is 24h past due; a Saturday skip would otherwise kill Monday's card.
  if (!inSendWindow(new Date())) {
    return {
      posted: 0,
      skipped: 0,
      failed: 0,
      retired: 0,
      deferred,
      skipReasons: { outside_send_window: 1 },
    };
  }

  const retired = await retireStaleFollowUps();
  const rows = await dueFollowUps(limit);
  const totals = { posted: 0, skipped: 0, failed: 0, retired, deferred, skipReasons: {} };

  for (const fu of rows) {
    const client = require('./campaign-routing').withSmartleadKey({
      id: fu.client_id,
      name: fu.client_name,
      slack_bot_token: fu.slack_bot_token,
      slack_channel_id: fu.slack_channel_id,
      voice_prompt: fu.voice_prompt,
      booking_link: fu.booking_link,
      digest_timezone: fu.digest_timezone,
      smartlead_api_key: fu.smartlead_api_key,
      smartlead_use_master_key: fu.smartlead_use_master_key,
      cc_email: fu.cc_email,
      cc_emails: fu.cc_emails,
    });

    try {
      const { isDisqualified } = require('./disqualified-prospects');
      if (await isLeadClaimed({ leadEmail: fu.lead_email, campaignId: fu.campaign_id })) {
        await resolve(fu, 'skipped', 'client_claimed');
        const cancelled = await cancelClaimedLeadWork({
          leadEmail: fu.lead_email,
          campaignId: fu.campaign_id,
        });
        totals.skipped++;
        totals.skipReasons.client_claimed = (totals.skipReasons.client_claimed || 0) + 1;
        console.log('[FollowUp] Skipped — client claimed this lead', {
          client: client.name, lead: fu.lead_name, cancelled,
        });
        continue;
      }

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

      if (!(await threadHasOurSend(fu.client_id, fu))) {
        await resolve(fu, 'skipped', 'no_prior_send');
        const cancelled = await cancelPendingForThread(fu.client_id, {
          platform: fu.platform,
          campaignId: fu.campaign_id,
          leadId: fu.lead_id,
          conversationId: fu.conversation_id,
        });
        totals.skipped++;
        totals.skipReasons.no_prior_send = (totals.skipReasons.no_prior_send || 0) + 1;
        console.log('[FollowUp] Skipped — no Slack-approved send on this thread yet', {
          client: client.name, lead: fu.lead_name, cancelledLaterSteps: cancelled,
        });
        continue;
      }

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

      const card = await postFollowUpCard(client, fu);
      if (!card) {
        totals.skipped++;
        totals.skipReasons.already_claimed = (totals.skipReasons.already_claimed || 0) + 1;
        continue;
      }
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

  const budget = followUpClaudeBudgetSnapshot();
  if (budget.calls) {
    console.log('[FollowUp] Claude usage this run', budget);
  }
  return { ...totals, claude: budget };
  } finally {
    followUpRunActive = false;
  }
}

module.exports = {
  runDueFollowUps,
  postFollowUpCard,
  dueFollowUps,
  retireStaleFollowUps,
  deferOffHoursFollowUps,
  threadHasOurSend,
  maxAgeHours,
  followUpSlackChannelId,
  DEFAULT_FOLLOW_UP_SLACK_CHANNEL_ID,
};
