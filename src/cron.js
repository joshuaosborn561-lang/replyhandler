const cron = require('node-cron');
const db = require('./db');
const slack = require('./services/slack');
const { sendReminder } = require('./services/reminder-email');
const { runDueFollowUps } = require('./services/follow-up-runner');
const { logIntegrationStatus } = require('./services/integration-check');
const { logInterestedSweep } = require('./services/interested-sweep');
const { pollHeyReachReplies } = require('./services/heyreach-poller');
const { pollSmartleadReplies } = require('./services/smartlead-poller');

const DEFAULT_TZ = process.env.DEFAULT_DIGEST_TIMEZONE || 'America/New_York';
const HEYREACH_POLL_MINUTES = parseInt(process.env.HEYREACH_POLL_MINUTES || '3', 10);
const SMARTLEAD_POLL_MINUTES = parseInt(process.env.SMARTLEAD_POLL_MINUTES || '5', 10);
const AFTERNOON_DIGEST_TZ = process.env.AFTERNOON_DIGEST_TIMEZONE || 'America/Chicago';
const AFTERNOON_DIGEST_HOUR = parseInt(process.env.AFTERNOON_DIGEST_HOUR || '15', 10);

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
      : 5;
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

  // ─── HeyReach polling backstop (webhooks are primary) ──────────────
  if (!/^(1|true|yes|on)$/i.test(String(process.env.DISABLE_HEYREACH_POLLING || '').trim())) {
    const every = Number.isFinite(HEYREACH_POLL_MINUTES) && HEYREACH_POLL_MINUTES > 0
      ? HEYREACH_POLL_MINUTES
      : 3;
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

  // Fire and forget — never delays startup.
  logIntegrationStatus().catch((err) =>
    console.error('[Startup] Integration check failed', { err: err.message })
  );

  // Print who looks booked, straight into the deploy log. Read-only.
  if (/^(1|true|yes|on)$/i.test(String(process.env.SWEEP_INTERESTED_ON_BOOT || '1').trim())) {
    logInterestedSweep({ hours: 24 }).catch((err) =>
      console.error('[Startup] Interested sweep failed', { err: err.message })
    );
  }

  const digestNote = attentionDigestsEnabled()
    ? 'morning + 3pm attention digests enabled'
    : 'morning + 3pm attention digests disabled (set ATTENTION_DIGESTS_ENABLED=1 to enable)';
  console.log(`[Cron] Jobs scheduled: SmartLead + HeyReach polling, follow-up runner, interested sweep, meeting reminders, ${digestNote}`);
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

async function pendingApprovalRows(clientId) {
  const { rows } = await db.query(
    `SELECT id, platform, campaign_id, lead_name, classification, created_at, slack_message_ts
       FROM pending_replies
      WHERE client_id = $1
        AND status = 'pending'
        AND classification <> 'FOLLOW_UP'
      ORDER BY created_at ASC
      LIMIT 25`,
    [clientId]
  );
  return rows;
}

/** Collect pending approvals + silent prospects, draft follow-ups, post digest/update in Slack. */
async function buildAndPostAttentionDigest(client, { digestDate, tz, digestType, dateLabel }) {
  if (await alreadyPostedAttentionDigest(client.id, digestDate, digestType)) return;

  const pendingApprovals = await pendingApprovalRows(client.id);

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

  if (pendingApprovals.length === 0 && pendingFollowUps.length === 0) {
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
      pendingCount: pendingApprovals.length,
      followUpCount: pendingFollowUps.length,
    }
  );

  if (pendingApprovals.length > 0) {
    await slack.postPendingApprovalDigest(client.slack_bot_token, client.slack_channel_id, {
      pending: pendingApprovals,
      dateLabel,
    });
  }

  let posted = 0;
  const { isDisqualified } = require('./services/disqualified-prospects');
  const { postFollowUpCard } = require('./services/follow-up-runner');
  for (const fu of pendingFollowUps) {
    try {
      if (await isDisqualified(client.id, {
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

      // Same top-level FOLLOW_UP card as the timed runner (main channel + thread context).
      await postFollowUpCard(client, fu);
      await db.query('UPDATE outbound_follow_ups SET status = $1, updated_at = now() WHERE id = $2', ['notified', fu.id]);
      posted++;
    } catch (err) {
      console.error('[Cron] Digest follow-up card failed', { followUpId: fu.id, err: err.message });
    }
  }

  await recordAttentionDigest({
    clientId: client.id,
    digestDate,
    digestType,
    pendingCount: pendingApprovals.length,
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

module.exports = { startCron };
