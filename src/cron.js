const cron = require('node-cron');
const db = require('./db');
const slack = require('./services/slack');
const { sendReminder } = require('./services/reminder-email');

function startCron() {
  // ─── Stale reply reminders (every 10 minutes) ─────────────────────
  cron.schedule('*/10 * * * *', async () => {
    console.log('[Cron] Checking for stale pending replies...');

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
            {
              replyId: reply.id,
              leadName: reply.lead_name,
              minutes: ageMinutes,
              escalate: shouldEscalate,
            }
          );

          const newCount = shouldEscalate ? 2 : 1;
          await db.query(
            'UPDATE pending_replies SET reminder_count = $1, updated_at = now() WHERE id = $2',
            [newCount, reply.id]
          );

          console.log('[Cron] Reply reminder sent', {
            replyId: reply.id,
            client: reply.client_name,
            lead: reply.lead_name,
            ageMinutes,
            escalated: shouldEscalate,
          });
        } catch (err) {
          console.error('[Cron] Failed to send reply reminder', {
            replyId: reply.id,
            err: err.message,
          });
        }
      }
    } catch (err) {
      console.error('[Cron] Stale replies check failed', { err: err.message });
    }
  });

  // ─── Meeting reminders — 1 hour before (every 10 minutes) ─────────
  cron.schedule('*/10 * * * *', async () => {
    try {
      // Find booked meetings happening in the next 50–70 minutes that haven't been reminded yet
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
            console.log('[Cron] Meeting reminder sent', {
              meetingId: meeting.id,
              client: meeting.client_name,
              lead: meeting.lead_name,
              meetingTime: meeting.confirmed_time,
            });
          }
        } catch (err) {
          console.error('[Cron] Failed to send meeting reminder', {
            meetingId: meeting.id,
            lead: meeting.lead_name,
            err: err.message,
          });
        }
      }
    } catch (err) {
      console.error('[Cron] Meeting reminders check failed', { err: err.message });
    }
  });

  console.log('[Cron] Jobs scheduled: reply reminders + meeting reminders (every 10 min)');
}

module.exports = { startCron };
