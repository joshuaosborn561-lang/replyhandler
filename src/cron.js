const cron = require('node-cron');
const db = require('./db');
const slack = require('./services/slack');
const { sendReminder } = require('./services/reminder-email');
const { runDueFollowUps } = require('./services/follow-up-runner');
const { logIntegrationStatus } = require('./services/integration-check');
const { ensureEmailReplyWebhooks } = require('./services/email-reply-webhooks');
const { refreshAllClientSlotCaches } = require('./services/scheduling-slots');
const { postPitchHiddenSummaries } = require('./services/pitch-hidden-summary');
const { logInterestedSweep } = require('./services/interested-sweep');
const { pollHeyReachReplies } = require('./services/heyreach-poller');
const { pollSmartleadReplies } = require('./services/smartlead-poller');
const { runWeeklyVoiceLearning } = require('./services/weekly-voice-learning');
const {
  icpAutoBuildEnabled,
  inIcpBuildWindow,
  runAutomaticIcpBuilds,
  ICP_BUILD_TZ,
} = require('./services/icp-auto-build');

const DEFAULT_TZ = process.env.DEFAULT_DIGEST_TIMEZONE || 'America/New_York';
const HEYREACH_POLL_MINUTES = parseInt(process.env.HEYREACH_POLL_MINUTES || '1', 10);
const SMARTLEAD_POLL_MINUTES = parseInt(process.env.SMARTLEAD_POLL_MINUTES || '1', 10);
const AFTERNOON_DIGEST_TZ = process.env.AFTERNOON_DIGEST_TIMEZONE || 'America/Chicago';
const AFTERNOON_DIGEST_HOUR = parseInt(process.env.AFTERNOON_DIGEST_HOUR || '15', 10);

// Friday 4pm Central: after the Friday noon follow-up cutoff and late enough to
// catch the afternoon's approvals. The job looks back 8 days so anything sent
// after it runs is picked up the following week. Upserts are idempotent.
const VOICE_LEARNING_CRON = process.env.VOICE_LEARNING_CRON || '0 16 * * 5';
const VOICE_LEARNING_TZ = process.env.VOICE_LEARNING_TIMEZONE || 'America/Chicago';

function voiceLearningEnabled() {
  return !/^(1|true|yes|on)$/i.test(String(process.env.DISABLE_VOICE_LEARNING || '').trim());
}

function attentionDigestsEnabled() {
  const v = process.env.ATTENTION_DIGESTS_ENABLED;
  if (v === undefined || v === '') return false;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function clientTimezone(client) {
  return client?.digest_timezone || DEFAULT_TZ;
}

function hourInTimezone(tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
    const parts = fmt.formatToParts(new Date());
    const h = parts.find((p) => p.type === 'hour');
    return parseInt(h?.value || '0', 10);
  } catch {
    return new Date().getHours();
  }
}

function dateInTimezone(tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = fmt.formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
    return new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function dayOfWeekInTimezone(tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    return fmt.format(new Date()); // e.g. Mon, Tue
  } catch {
    const d = new Date().getDay();
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] || 'Mon';
  }
}

function addDays(yyyyMmDd, deltaDays) {
  const base = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

function startCron() {
  // ─── SmartLead inbox polling backstop (webhooks are primary) ───────
  if (!/^(1|true|yes|on)$/i.test(String(process.env.DISABLE_SMARTLEAD_POLLING || '').trim())) {
    const slEvery = Number.isFinite(SMARTLEAD_POLL_MINUTES) && SMARTLEAD_POLL_MINUTES > 0
      ? SMARTLEAD_POLL_MINUTES
      : 1;
    cron.schedule(`*/${slEvery} * * * *`, async () => {
      try {
        const result = await pollSmartleadReplies();
        if (result && (result.processed || result.skipped)) {
          console.log('[Cron] SmartLead poll complete', result);
        }
      } catch (err) {
        console.error('[Cron] SmartLead poll failed', { err: err.message });
      }
    });
  }

  // Stuck Approve clicks: retry a row that never reached the provider, or
  // mark a claimed send failed with Retry. Never sends a second copy.
  cron.schedule('*/2 * * * *', async () => {
    try {
      const { sweepStuckSends } = require('./services/stuck-send-sweeper');
      await sweepStuckSends();
    } catch (err) {
      console.error('[Cron] Stuck-send sweep failed', { err: err.message });
    }
  });

  // ─── HeyReach polling backstop (webhooks are primary) ──────────────
  if (!/^(1|true|yes|on)$/i.test(String(process.env.DISABLE_HEYREACH_POLLING || '').trim())) {
    const every = Number.isFinite(HEYREACH_POLL_MINUTES) && HEYREACH_POLL_MINUTES > 0
      ? HEYREACH_POLL_MINUTES
      : 1;
    cron.schedule(`*/${every} * * * *`, async () => {
      try {
        const result = await pollHeyReachReplies();
        if (result && (result.processed || result.skipped)) {
          console.log('[Cron] HeyReach poll complete', result);
        }
      } catch (err) {
        console.error('[Cron] HeyReach poll failed', { err: err.message });
      }
    });
  }

  // ─── Interested/booked sweep — recurring, results go to the log ───
  // The app can reach SmartLead; a restricted session may not. Publishing the
  // answer on a schedule means "who booked?" is always available from the
  // deploy log without anyone querying SmartLead by hand.
  if (!/^(0|false|no|off)$/i.test(String(process.env.SWEEP_INTERESTED_ENABLED || '1').trim())) {
    const sweepEvery = (() => {
      const n = parseInt(process.env.SWEEP_INTERESTED_MINUTES || '30', 10);
      return Number.isFinite(n) && n > 0 && n <= 59 ? n : 30;
    })();
    cron.schedule(`*/${sweepEvery} * * * *`, async () => {
      try {
        await logInterestedSweep({ hours: 24 });
      } catch (err) {
        console.error('[Cron] Interested sweep failed', { err: err.message });
      }
    });
  }

  // ─── Follow-up re-attempts — post as soon as they come due ────────
  if (!/^(1|true|yes|on)$/i.test(String(process.env.DISABLE_FOLLOW_UP_RUNNER || '').trim())) {
    const fuEvery = (() => {
      const n = parseInt(process.env.FOLLOW_UP_CHECK_MINUTES || '5', 10);
      return Number.isFinite(n) && n > 0 && n <= 59 ? n : 5;
    })();
    cron.schedule(`*/${fuEvery} * * * *`, async () => {
      try {
        const result = await runDueFollowUps({ limit: 25 });
        if (result.posted || result.skipped || result.failed || result.retired) {
          console.log('[Cron] Follow-up run complete', result);
        }
      } catch (err) {
        console.error('[Cron] Follow-up run failed', { err: err.message });
      }
    });
  }

  // ─── Day-30 nurture (OFF by default; NURTURE_ENABLED=true turns it on) ──
  // Enrols finished follow-up sequences, watches for exits, posts the Day 30 card.
  // Nothing is sent from here: a person approves each card.
  {
    const nurtureEvery = (() => {
      const n = parseInt(process.env.NURTURE_TICK_MINUTES || '10', 10);
      return Number.isFinite(n) && n > 0 && n <= 59 ? n : 10;
    })();
    cron.schedule(`*/${nurtureEvery} * * * *`, async () => {
      try {
        const nurture = require('./services/nurture-day30');
        if (!nurture.enabled()) return;
        const result = await nurture.runNurtureTick();
        const t = result.touches || {};
        const e = result.entries || {};
        if (e.enrolled || e.paused || e.exited || t.posted || t.stopped || t.failed) {
          console.log('[Cron] Nurture tick', result);
        }
      } catch (err) {
        console.error('[Cron] Nurture tick failed', { err: err.message });
      }
    });
  }

  // ─── Follow-up card sequence for positive replies (OFF by default) ──
  // FOLLOWUP_SEQUENCE_ENABLED=true turns it on. Every step is a Slack card a
  // human clicks; nothing is sent to a lead from here.
  {
    const { enabled: sequenceEnabled, runSequenceTick } = require('./services/followup-sequence');
    const ghostedMeetings = require('./services/ghosted-meetings');
    if (sequenceEnabled() || ghostedMeetings.enabled()) {
      cron.schedule('* * * * *', async () => {
        try {
          const result = await runSequenceTick();
          if (result.enrolled || result.posted || result.stopped || result.failed) {
            console.log('[Cron] Follow-up sequence tick', result);
          }
        } catch (err) {
          console.error('[Cron] Follow-up sequence tick failed', { err: err.message });
        }
      });
      console.log('[Cron] Follow-up card sequence ENABLED');
    }

    // Ghosted meetings (OFF by default, GHOSTED_MEETING_ENABLED): find booked meetings the
    // prospect never showed up to and enroll them in the sequence above. Cards only.
    if (ghostedMeetings.enabled()) {
      cron.schedule('*/2 * * * *', async () => {
        try {
          const result = await ghostedMeetings.runGhostedMeetingScan({
            dryRun: /^(1|true|yes|on)$/i.test(String(process.env.GHOSTED_MEETING_DRY_RUN || '')),
          });
          if (result.candidates || result.enrolled || result.sourceErrors.length) {
            console.log('[Cron] Ghosted meeting scan', result);
          }
        } catch (err) {
          console.error('[Cron] Ghosted meeting scan failed', { err: err.message });
        }
      });
      console.log('[Cron] Ghosted-meeting follow-up ENABLED');
    }
  }

  // ─── Weekly voice learning — Fridays ──────────────────────────────
  // Learns from the week's Slack-approved / edited sends and manual
  // SmartLead / HeyReach replies, refreshes RAG, re-synthesizes the voice
  // profiles drafts read from. Gemini only (bulk job — never Claude).
  if (voiceLearningEnabled()) {
    if (!cron.validate(VOICE_LEARNING_CRON)) {
      console.error('[Cron] Invalid VOICE_LEARNING_CRON — weekly voice learning not scheduled', { expr: VOICE_LEARNING_CRON });
    } else {
      cron.schedule(VOICE_LEARNING_CRON, async () => {
        try {
          const result = await runWeeklyVoiceLearning({ trigger: 'cron' });
          console.log('[Cron] Weekly voice learning complete', {
            rag: result.rag, profiles: result.profiles, errors: result.errors?.length || 0,
          });
        } catch (err) {
          console.error('[Cron] Weekly voice learning failed', { err: err.message });
        }
      }, { timezone: VOICE_LEARNING_TZ });
    }
  }

  // ─── Client day-of briefs — hold ~45 min before, send only on release ─
  // CLIENT_DAYOF_BRIEF_ENABLED defaults off. A held brief is never emailed.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const briefs = require('./services/client-dayof-brief');
      if (!briefs.dayofBriefEnabled()) return;
      const result = await briefs.runClientDayofBriefs();
      if (result.held || result.notified || result.sent || result.blocked_by_context) {
        console.log('[Cron] Client day-of briefs', result);
      }
    } catch (err) {
      console.error('[Cron] Client day-of briefs failed', { err: err.message });
    }
  });

  // ─── Meeting reminders — 1 hour before (every 10 minutes) ─────────
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { rows: upcoming } = await db.query(
        `SELECT m.*, c.id AS c_id, c.name AS client_name, c.voice_prompt, c.booking_link,
                c.slack_bot_token, c.slack_channel_id
         FROM meetings m
         JOIN clients c ON m.client_id = c.id
         WHERE m.status = 'booked'
           AND m.reminder_sent = false
           AND m.confirmed_time IS NOT NULL
           AND m.confirmed_time > now() + interval '50 minutes'
           AND m.confirmed_time <= now() + interval '70 minutes'
           AND m.lead_email IS NOT NULL`
      );

      for (const meeting of upcoming) {
        try {
          const client = {
            id: meeting.c_id,
            name: meeting.client_name,
            voice_prompt: meeting.voice_prompt,
            booking_link: meeting.booking_link,
          };
          const sent = await sendReminder(meeting, client, meeting.voice_prompt);
          if (sent) {
            await db.query('UPDATE meetings SET reminder_sent = true, updated_at = now() WHERE id = $1', [meeting.id]);
          }
        } catch (err) {
          console.error('[Cron] Failed to send meeting reminder', { meetingId: meeting.id, err: err.message });
        }
      }
    } catch (err) {
      console.error('[Cron] Meeting reminders check failed', { err: err.message });
    }
  });

  if (attentionDigestsEnabled()) {
    // ─── Morning 8am digest per client timezone (run every 15 min) ────
    cron.schedule('*/15 * * * *', async () => {
      try {
        const { rows: clients } = await db.query('SELECT * FROM clients WHERE active IS DISTINCT FROM false');
        for (const client of clients) {
          const tz = clientTimezone(client);
          const localHour = hourInTimezone(tz);
          if (localHour !== 8) continue;
          const digestDate = dateInTimezone(tz);

          try {
            await buildAndPostAttentionDigest(client, {
              digestDate,
              tz,
              digestType: 'morning',
              dateLabel: digestDate,
            });
          } catch (err) {
            console.error('[Cron] Morning digest failed', { clientId: client.id, err: err.message });
          }
        }
      } catch (err) {
        console.error('[Cron] Morning digest scan failed', { err: err.message });
      }
    });

    // ─── Afternoon 3pm Central digest (run every 15 min) ───────────────
    cron.schedule('*/15 * * * *', async () => {
      try {
        const localHour = hourInTimezone(AFTERNOON_DIGEST_TZ);
        if (localHour !== AFTERNOON_DIGEST_HOUR) return;
        const digestDate = dateInTimezone(AFTERNOON_DIGEST_TZ);
        const { rows: clients } = await db.query('SELECT * FROM clients WHERE active IS DISTINCT FROM false');
        for (const client of clients) {
          try {
            await buildAndPostAttentionDigest(client, {
              digestDate,
              tz: AFTERNOON_DIGEST_TZ,
              digestType: 'afternoon',
              dateLabel: `${digestDate} 3pm CT`,
            });
          } catch (err) {
            console.error('[Cron] Afternoon digest failed', { clientId: client.id, err: err.message });
          }
        }
      } catch (err) {
        console.error('[Cron] Afternoon digest scan failed', { err: err.message });
      }
    });
  }

  // ─── Daily "N pitches hidden today" (8pm CT, only if N > 0) ───────
  cron.schedule('*/15 * * * *', async () => {
    try {
      if (hourInTimezone('America/Chicago') !== 20) return;
      const result = await postPitchHiddenSummaries();
      if (result.posted) {
        console.log('[Cron] Pitch-hidden summaries posted', result);
      }
    } catch (err) {
      console.error('[Cron] Pitch-hidden summary failed', { err: err.message });
    }
  });

  // ─── Auto ICP — weekdays 6am–8pm CT (Josh's quiet hours) ──────────
  // Empty / missing / never-built statuses every hour in-window.
  // needs_review retries once a day when new Fireflies calls may exist.
  if (icpAutoBuildEnabled()) {
    cron.schedule('0 6-20 * * 1-5', async () => {
      if (!inIcpBuildWindow()) return;
      try {
        const counts = await runAutomaticIcpBuilds({ db });
        console.log('[Cron] ICP auto-build', counts);
      } catch (err) {
        console.error('[Cron] ICP auto-build failed', { err: err.message });
      }
    }, { timezone: ICP_BUILD_TZ });
  }

  // ─── Client positive-reply roll-up — weekdays 4:00pm CT ───────────
  // One email per client listing the positive replies we answered (weekend replies ride in Monday's
  // email; an empty day sends nothing). See services/client-reply-digest.js. Off with CLIENT_DIGEST_ENABLED=false.
  if (String(process.env.CLIENT_DIGEST_ENABLED || '').toLowerCase() !== 'false') {
    const digestCron = process.env.CLIENT_DIGEST_CRON || '0 16 * * 1-5';
    if (!cron.validate(digestCron)) {
      console.error('[Cron] Invalid CLIENT_DIGEST_CRON — client roll-up not scheduled', { expr: digestCron });
    } else {
      cron.schedule(digestCron, async () => {
        try {
          const { runClientReplyDigest, clientNotifyMode } = require('./services/client-reply-digest');
          if (clientNotifyMode() === 'off') return;
          const result = await runClientReplyDigest();
          console.log('[Cron] Client reply roll-up complete', result);
        } catch (err) {
          console.error('[Cron] Client reply roll-up failed', { err: err.message });
        }
      }, { timezone: 'America/Chicago' });
    }
  }

  // Background calendar cache — 8 minutes (inside the 5–10 minute window).
  cron.schedule('*/8 * * * *', async () => {
    try {
      await refreshAllClientSlotCaches();
    } catch (err) {
      console.error('[Cron] Slot cache refresh failed', { err: err.message });
    }
  });

  // Fire and forget — never delays startup.
  logIntegrationStatus().catch((err) =>
    console.error('[Startup] Integration check failed', { err: err.message })
  );
  require('./services/ariel-referral-card').ensureArielReferralCard().then((out) => {
    console.log('[Startup] Ariel referral card', out && out.action);
  }).catch((err) => {
    console.error('[Startup] Ariel referral card failed', { err: err.message });
  });
  require('./services/marbella-reply-card').ensureMarbellaReplyCard().then((out) => {
    console.log('[Startup] Marbella reply card', out && out.action);
  }).catch((err) => {
    console.error('[Startup] Marbella reply card failed', { err: err.message });
  });
  ensureEmailReplyWebhooks().catch((err) =>
    console.error('[Startup] EMAIL_REPLY webhook check failed', { err: err.message })
  );
  refreshAllClientSlotCaches().catch((err) =>
    console.error('[Startup] Slot cache warm failed', { err: err.message })
  );

  if (icpAutoBuildEnabled()) {
    runAutomaticIcpBuilds({ db }).then((counts) => {
      console.log('[Startup] ICP auto-build', counts);
    }).catch((err) => {
      console.error('[Startup] ICP auto-build failed', { err: err.message });
    });
  }

  // Print who looks booked, straight into the deploy log. Read-only.
  if (/^(1|true|yes|on)$/i.test(String(process.env.SWEEP_INTERESTED_ON_BOOT || '1').trim())) {
    logInterestedSweep({ hours: 24 }).catch((err) =>
      console.error('[Startup] Interested sweep failed', { err: err.message })
    );
  }

  const digestNote = attentionDigestsEnabled()
    ? 'morning + 3pm attention digests enabled'
    : 'morning + 3pm attention digests disabled (set ATTENTION_DIGESTS_ENABLED=1 to enable)';
  const voiceNote = voiceLearningEnabled()
    ? `weekly voice learning (${VOICE_LEARNING_CRON} ${VOICE_LEARNING_TZ})`
    : 'weekly voice learning disabled (DISABLE_VOICE_LEARNING)';
  const icpNote = icpAutoBuildEnabled()
    ? `ICP auto-build (hourly weekdays 6am-8pm ${ICP_BUILD_TZ})`
    : 'ICP auto-build disabled (DISABLE_ICP_AUTO_BUILD)';
  const dayofNote = require('./services/client-dayof-brief').dayofBriefEnabled()
    ? 'client day-of briefs ON (held for review)'
    : 'client day-of briefs off (CLIENT_DAYOF_BRIEF_ENABLED)';
  console.log(`[Cron] Jobs scheduled: SmartLead + HeyReach polling, follow-up runner, interested sweep, meeting reminders, ${voiceNote}, ${icpNote}, ${digestNote}, ${dayofNote}`);
}

async function alreadyPostedAttentionDigest(clientId, digestDate, digestType) {
  const { rows } = await db.query(
    `SELECT 1 FROM attention_digests WHERE client_id = $1 AND digest_date = $2 AND digest_type = $3`,
    [clientId, digestDate, digestType]
  );
  return rows.length > 0;
}

async function recordAttentionDigest({ clientId, digestDate, digestType, pendingCount, followUpCount, slackMessageTs }) {
  await db.query(
    `INSERT INTO attention_digests (client_id, digest_date, digest_type, pending_count, follow_up_count, slack_message_ts)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id, digest_date, digest_type) DO NOTHING`,
    [clientId, digestDate, digestType, pendingCount, followUpCount, slackMessageTs || null]
  );
}

/**
 * How far back the digest looks. Bounded on purpose.
 *
 * The list is ordered oldest-first (within a sane window, oldest is the most
 * urgent), but with no lower bound a large backlog fills all 25 slots with
 * ancient rows and current work becomes structurally invisible. Measured
 * 2026-08-18 against a 2,075-row backlog: the newest item SalesGlider's digest
 * could show was 38 days old, and Culture Fits' was 22 days old.
 */
function attentionDigestWindowDays() {
  const n = parseInt(process.env.ATTENTION_DIGEST_WINDOW_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

const PENDING_DIGEST_LIMIT = 25;

/**
 * @returns {{ rows: object[], totalInWindow: number, backlogOlder: number }}
 *   `rows` is capped for display; `totalInWindow` is the real count so the
 *   header cannot report the cap as if it were the total.
 */
async function pendingApprovalRows(clientId) {
  const windowDays = attentionDigestWindowDays();

  const { rows } = await db.query(
    `SELECT id, platform, campaign_id, lead_name, classification, created_at, slack_message_ts
       FROM pending_replies
      WHERE client_id = $1
        AND status = 'pending'
        AND classification <> 'FOLLOW_UP'
        AND created_at > now() - ($2::int * interval '1 day')
      ORDER BY created_at ASC
      LIMIT ${PENDING_DIGEST_LIMIT}`,
    [clientId, windowDays]
  );

  const { rows: [counts] } = await db.query(
    `SELECT count(*) FILTER (WHERE created_at > now() - ($2::int * interval '1 day'))::int AS in_window,
            count(*) FILTER (WHERE created_at <= now() - ($2::int * interval '1 day'))::int AS older
       FROM pending_replies
      WHERE client_id = $1
        AND status = 'pending'
        AND classification <> 'FOLLOW_UP'`,
    [clientId, windowDays]
  );

  return {
    rows,
    totalInWindow: counts ? counts.in_window : rows.length,
    backlogOlder: counts ? counts.older : 0,
  };
}

/** Collect pending approvals + silent prospects, draft follow-ups, post digest/update in Slack. */
async function buildAndPostAttentionDigest(client, { digestDate, tz, digestType, dateLabel }) {
  if (await alreadyPostedAttentionDigest(client.id, digestDate, digestType)) return;

  const {
    rows: pendingApprovals,
    totalInWindow: pendingTotal,
    backlogOlder,
  } = await pendingApprovalRows(client.id);

  if (backlogOlder > 0) {
    console.log('[Cron] Attention digest: backlog outside window not shown', {
      clientId: client.id, client: client.name, backlogOlder,
      windowDays: attentionDigestWindowDays(),
    });
  }

  // Candidate follow-ups: scheduled outbound where the due time has arrived and the prospect
  // still has not replied. Morning and 3pm digests are the only Slack notifications for these.
  const { rows: pendingFollowUps } = await db.query(
    `SELECT DISTINCT ON (f.client_id, f.platform, COALESCE(f.campaign_id, ''), COALESCE(f.lead_id, ''), COALESCE(f.conversation_id, ''))
            f.*
     FROM outbound_follow_ups f
     WHERE f.client_id = $1
       AND f.status = 'pending'
       AND f.due_at <= now()
     ORDER BY f.client_id, f.platform, COALESCE(f.campaign_id, ''), COALESCE(f.lead_id, ''), COALESCE(f.conversation_id, ''), f.due_at ASC`,
    [client.id]
  );

  const { inSendWindow } = require('./services/outbound-follow-up');
  const followUpsToPost = inSendWindow(new Date()) ? pendingFollowUps : [];

  if (pendingApprovals.length === 0 && followUpsToPost.length === 0) {
    const header = await slack.postAttentionDigestHeader(client.slack_bot_token, client.slack_channel_id, {
      digestType,
      dateLabel,
      pendingCount: 0,
      followUpCount: 0,
    });
    await recordAttentionDigest({
      clientId: client.id,
      digestDate,
      digestType,
      pendingCount: 0,
      followUpCount: 0,
      slackMessageTs: header?.ts || null,
    });
    console.log('[Cron] Attention digest posted (empty)', { clientId: client.id, date: digestDate, digestType });
    return;
  }

  const header = await slack.postAttentionDigestHeader(
    client.slack_bot_token, client.slack_channel_id,
    {
      digestType,
      dateLabel,
      pendingCount: pendingTotal,
      followUpCount: followUpsToPost.length,
    }
  );

  if (pendingApprovals.length > 0) {
    await slack.postPendingApprovalDigest(client.slack_bot_token, client.slack_channel_id, {
      pending: pendingApprovals,
      dateLabel,
    });
  }

  let posted = 0;
  const { leadSuppressionReason } = require('./services/lead-suppression');
  const { postFollowUpCard, threadHasOurSend } = require('./services/follow-up-runner');
  const { resetFollowUpClaudeBudget, followUpClaudeBudgetSnapshot } = require('./services/follow-up-drafts');
  resetFollowUpClaudeBudget();
  const { cancelPendingForThread } = require('./services/outbound-follow-up');
  const { isLeadClaimed, cancelClaimedLeadWork } = require('./services/client-claimed');
  for (const fu of followUpsToPost) {
    try {
      if (await isLeadClaimed({ leadEmail: fu.lead_email, campaignId: fu.campaign_id })) {
        await db.query(
          `UPDATE outbound_follow_ups
              SET status = 'skipped', skip_reason = 'client_claimed', updated_at = now()
            WHERE id = $1`,
          [fu.id]
        );
        await cancelClaimedLeadWork({
          leadEmail: fu.lead_email,
          campaignId: fu.campaign_id,
        });
        console.log('[Cron] Digest follow-up skipped — client claimed this lead', {
          clientId: client.id, lead: fu.lead_name,
        });
        continue;
      }
      if (!(await threadHasOurSend(client.id, fu))) {
        await db.query(
          `UPDATE outbound_follow_ups
              SET status = 'skipped', skip_reason = 'no_prior_send', updated_at = now()
            WHERE id = $1`,
          [fu.id]
        );
        await cancelPendingForThread(client.id, {
          platform: fu.platform,
          campaignId: fu.campaign_id,
          leadId: fu.lead_id,
          conversationId: fu.conversation_id,
        });
        console.log('[Cron] Digest follow-up skipped — no Slack-approved send yet', {
          clientId: client.id, lead: fu.lead_name,
        });
        continue;
      }
      if (await leadSuppressionReason(require('./services/campaign-routing').withSmartleadKey(client), {
        platform: fu.platform,
        campaignId: fu.campaign_id,
        leadId: fu.lead_id,
        conversationId: fu.conversation_id,
        leadEmail: fu.lead_email,
        linkedinUrl: fu.linkedin_url,
      })) {
        await db.query(
          `UPDATE outbound_follow_ups
              SET status = 'skipped', skip_reason = 'disqualified', updated_at = now()
            WHERE id = $1`,
          [fu.id]
        );
        console.log('[Cron] Digest follow-up skipped — disqualified', {
          clientId: client.id, lead: fu.lead_name,
        });
        continue;
      }

      // Same top-level FOLLOW_UP card as the timed runner (dedicated follow-ups channel).
      // postFollowUpCard claims the row. A second digest/runner tick must not
      // mark it notified out from under the worker that is still posting.
      const card = await postFollowUpCard(client, fu);
      if (!card) {
        console.log('[Cron] Digest follow-up skipped — already claimed or duplicate', {
          clientId: client.id, followUpId: fu.id, lead: fu.lead_name,
        });
        continue;
      }
      posted++;
    } catch (err) {
      console.error('[Cron] Digest follow-up card failed', { followUpId: fu.id, err: err.message });
    }
  }

  const budget = followUpClaudeBudgetSnapshot();
  if (budget.calls) {
    console.log('[Cron] Follow-up Claude usage this digest', budget);
  }

  await recordAttentionDigest({
    clientId: client.id,
    digestDate,
    digestType,
    pendingCount: pendingTotal,
    followUpCount: posted,
    slackMessageTs: header?.ts || null,
  });
  console.log('[Cron] Attention digest posted', {
    clientId: client.id,
    date: digestDate,
    digestType,
    pending: pendingApprovals.length,
    followUpsPosted: posted,
  });
}

module.exports = {
  startCron,
  attentionDigestWindowDays,
  PENDING_DIGEST_LIMIT,
  VOICE_LEARNING_CRON,
  VOICE_LEARNING_TZ,
  voiceLearningEnabled,
};
