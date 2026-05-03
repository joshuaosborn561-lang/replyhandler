const cron = require('node-cron');
const db = require('./db');
const slack = require('./services/slack');
const { sendReminder } = require('./services/reminder-email');
const { draftReattemptToBook } = require('./services/follow-up-drafts');
const { lastOutboundBodyFromSmartleadHistory } = require('./utils/smartlead-webhook-helpers');
const { pollHeyReachReplies } = require('./services/heyreach-poller');

const DEFAULT_TZ = process.env.DEFAULT_DIGEST_TIMEZONE || 'America/New_York';
const PENDING_NUDGE_MINUTES = parseInt(process.env.PENDING_NUDGE_MINUTES || '5', 10);
const HEYREACH_POLL_MINUTES = parseInt(process.env.HEYREACH_POLL_MINUTES || '3', 10);

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
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    return fmt.format(new Date());
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

  // ─── Stale reply reminders (every 10 minutes) ─────────────────────
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { rows: staleReplies } = await db.query(
        `SELECT pr.*, c.slack_bot_token, c.slack_channel_id, c.name AS client_name
         FROM pending_replies pr
         JOIN clients c ON pr.client_id = c.id
         WHERE pr.status = 'pending'
           AND pr.slack_message_ts IS NOT NULL
           AND pr.created_at < now() - interval '30 minutes'
         ORDER BY pr.created_at ASC`
      );

      for (const reply of staleReplies) {
        const ageMinutes = Math.floor((Date.now() - new Date(reply.created_at).getTime()) / 60000);
        const shouldEscalate = ageMinutes >= 120;
        if (shouldEscalate && reply.reminder_count >= 2) continue;
        if (!shouldEscalate && reply.reminder_count >= 1) continue;

        try {
          await slack.postReminder(
            reply.slack_bot_token,
            reply.slack_channel_id,
            reply.slack_message_ts,
            { replyId: reply.id, leadName: reply.lead_name, minutes: ageMinutes, escalate: shouldEscalate }
          );
          const newCount = shouldEscalate ? 2 : 1;
          await db.query('UPDATE pending_replies SET reminder_count = $1, updated_at = now() WHERE id = $2', [newCount, reply.id]);
        } catch (err) {
          console.error('[Cron] Failed to send reply reminder', { replyId: reply.id, err: err.message });
        }
      }
    } catch (err) {
      console.error('[Cron] Stale replies check failed', { err: err.message });
    }
  });

  // ─── Recurring "did you already reply?" nudge — every PENDING_NUDGE_MINUTES (default 5) ────────
  cron.schedule('* * * * *', async () => {
    try {
      // Pull cards that are either unnudged (pending_nudge_next_at NULL) or whose next nudge is due.
      // Respect snooze_until (if set and in the future, skip).
      const { rows: due } = await db.query(
        `SELECT pr.*, c.slack_bot_token, c.slack_channel_id
         FROM pending_replies pr
         JOIN clients c ON pr.client_id = c.id
         WHERE pr.status = 'pending'
           AND pr.slack_message_ts IS NOT NULL
           AND (pr.pending_nudge_snoozed_until IS NULL OR pr.pending_nudge_snoozed_until <= now())
           AND (
             (pr.pending_nudge_next_at IS NULL AND pr.created_at < now() - ($1::int * interval '1 minute'))
             OR
             (pr.pending_nudge_next_at IS NOT NULL AND pr.pending_nudge_next_at <= now())
           )
         ORDER BY pr.created_at ASC
         LIMIT 50`,
        [PENDING_NUDGE_MINUTES]
      );

      for (const reply of due) {
        try {
          const minutes = Math.max(PENDING_NUDGE_MINUTES, Math.floor((Date.now() - new Date(reply.created_at).getTime()) / 60000));
          await slack.postPendingNudge(
            reply.slack_bot_token,
            reply.slack_channel_id,
            reply.slack_message_ts,
            { replyId: reply.id, leadName: reply.lead_name, minutes }
          );
          await db.query(
            `UPDATE pending_replies
               SET pending_nudge_sent_at = now(),
                   pending_nudge_next_at = now() + ($1::int * interval '1 minute'),
                   pending_nudge_count = COALESCE(pending_nudge_count, 0) + 1,
                   pending_nudge_snoozed_until = NULL,
                   updated_at = now()
             WHERE id = $2`,
            [PENDING_NUDGE_MINUTES, reply.id]
          );
          console.log('[Cron] Pending nudge sent', { replyId: reply.id, lead: reply.lead_name, minutes, count: (reply.pending_nudge_count || 0) + 1 });
        } catch (err) {
          console.error('[Cron] Pending nudge failed', { replyId: reply.id, err: err.message });
        }
      }
    } catch (err) {
      console.error('[Cron] Pending nudge scan failed', { err: err.message });
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

  // ─── Morning 8am digest per client timezone (run every 15 min) ────
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { rows: clients } = await db.query('SELECT * FROM clients WHERE active IS DISTINCT FROM false');
      for (const client of clients) {
        const tz = clientTimezone(client);
        const localHour = hourInTimezone(tz);
        if (localHour !== 8) continue;
        const digestDate = dateInTimezone(tz);

        const already = await db.query(
          'SELECT 1 FROM morning_digests WHERE client_id = $1 AND digest_date = $2',
          [client.id, digestDate]
        );
        if (already.rowCount > 0) continue;

        try {
          await buildAndPostMorningDigest(client, digestDate, tz);
        } catch (err) {
          console.error('[Cron] Morning digest failed', { clientId: client.id, err: err.message });
        }
      }
    } catch (err) {
      console.error('[Cron] Morning digest scan failed', { err: err.message });
    }
  });

  console.log('[Cron] Jobs scheduled: HeyReach polling, stale-reply reminders, 5-min pending nudge, meeting reminders, morning digest (per client TZ)');
}

/** Collect silent prospects from last ~36h, draft follow-ups, post approval cards in Slack. */
async function buildAndPostMorningDigest(client, digestDate, tz) {
  // Candidate follow-ups: scheduled outbound that prospect hasn't replied to.
  // Normally: include follow-ups from "yesterday" (client-local date).
  // Monday: include Fri+Sat+Sun and remind on Monday.
  const endDate = addDays(digestDate, -1); // yesterday
  const dow = dayOfWeekInTimezone(tz);
  const startDate = dow === 'Mon' ? addDays(endDate, -2) : endDate; // Fri..Sun on Monday, else just yesterday

  const { rows: pendingFollowUps } = await db.query(
    `SELECT DISTINCT ON (f.client_id, f.platform, COALESCE(f.campaign_id, ''), COALESCE(f.lead_id, ''), COALESCE(f.conversation_id, ''))
            f.*
     FROM outbound_follow_ups f
     WHERE f.client_id = $1
       AND f.status = 'pending'
       AND (f.sent_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
     ORDER BY f.client_id, f.platform, COALESCE(f.campaign_id, ''), COALESCE(f.lead_id, ''), COALESCE(f.conversation_id, ''), f.sent_at DESC`,
    [client.id, tz, startDate, endDate]
  );

  if (pendingFollowUps.length === 0) {
    const header = await slack.postMorningDigestHeader(client.slack_bot_token, client.slack_channel_id, { count: 0, dateLabel: digestDate });
    await db.query(
      `INSERT INTO morning_digests (client_id, digest_date, follow_up_count, slack_message_ts) VALUES ($1, $2, 0, $3)`,
      [client.id, digestDate, header?.ts || null]
    );
    console.log('[Cron] Morning digest posted (empty)', { clientId: client.id, date: digestDate });
    return;
  }

  const header = await slack.postMorningDigestHeader(
    client.slack_bot_token, client.slack_channel_id,
    { count: pendingFollowUps.length, dateLabel: digestDate }
  );

  let posted = 0;
  for (const fu of pendingFollowUps) {
    try {
      const draft = await draftReattemptToBook({
        leadName: fu.lead_name,
        platform: fu.platform,
        voicePrompt: client.voice_prompt,
        bookingLink: client.booking_link,
        lastInboundMessage: null,
        lastOutboundMessage: null,
      });

      // Create a reusable pending_replies row; Slack Approve/Edit uses the existing send path.
      let threadContext = null;
      let smartleadStatsId = null;
      if (fu.source_pending_reply_id) {
        const { rows: [src] } = await db.query(
          'SELECT thread_context, smartlead_email_stats_id FROM pending_replies WHERE id = $1',
          [fu.source_pending_reply_id]
        );
        if (src) {
          threadContext = src.thread_context;
          smartleadStatsId = src.smartlead_email_stats_id;
          if (typeof threadContext === 'string') {
            try { threadContext = JSON.parse(threadContext); } catch { /* keep string */ }
          }
        }
      }

      const { rows: [newReply] } = await db.query(
        `INSERT INTO pending_replies
          (client_id, platform, campaign_id, lead_id, lead_name, lead_email, linkedin_url,
           inbound_message, thread_context, classification, draft_reply, status, smartlead_email_stats_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'FOLLOW_UP', $10, 'pending', $11)
         RETURNING *`,
        [
          client.id,
          fu.platform,
          fu.campaign_id,
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

      let lastOutFollow = '';
      if (fu.platform === 'smartlead' && threadContext && typeof threadContext === 'object' && !Array.isArray(threadContext)) {
        lastOutFollow = lastOutboundBodyFromSmartleadHistory(threadContext) || '';
      } else if (fu.platform === 'heyreach' && threadContext && typeof threadContext === 'object' && threadContext.messages) {
        const msgs = threadContext.messages;
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            const role = String(m.role || '').toLowerCase();
            if (role === 'us' || role === 'me') {
              const t = (typeof m.message === 'string' && m.message) || (typeof m.text === 'string' && m.text) || '';
              if (t.trim()) lastOutFollow = t.trim();
            }
          }
        }
      }
      const campFollow =
        fu.campaign_id != null && String(fu.campaign_id).trim() !== ''
          ? `Campaign ${String(fu.campaign_id).trim()}`
          : '';

      const slackRes = await slack.postDraftApproval(
        client.slack_bot_token, client.slack_channel_id,
        {
          replyId: newReply.id,
          leadName: fu.lead_name,
          leadEmail: fu.lead_email,
          platform: fu.platform,
          classification: 'FOLLOW_UP',
          draft,
          reasoning: `No reply since our last message (${fu.sent_at.toISOString ? fu.sent_at.toISOString() : fu.sent_at}). AI drafted a re-attempt to book.`,
          inboundMessage: '(no new reply from prospect)',
          campaignDisplay: campFollow || undefined,
          lastOutboundMessage: lastOutFollow || undefined,
        }
      );
      await db.query('UPDATE pending_replies SET slack_message_ts = $1 WHERE id = $2', [slackRes.ts, newReply.id]);
      await db.query('UPDATE outbound_follow_ups SET status = $1, updated_at = now() WHERE id = $2', ['notified', fu.id]);
      posted++;
    } catch (err) {
      console.error('[Cron] Digest follow-up card failed', { followUpId: fu.id, err: err.message });
    }
  }

  await db.query(
    `INSERT INTO morning_digests (client_id, digest_date, follow_up_count, slack_message_ts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, digest_date) DO NOTHING`,
    [client.id, digestDate, posted, header?.ts || null]
  );
  console.log('[Cron] Morning digest posted', { clientId: client.id, date: digestDate, posted });
}

module.exports = { startCron };
