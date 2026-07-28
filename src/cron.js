const cron = require('node-cron');
const db = require('./db');
const { sendReminder } = require('./services/reminder-email');

function startCron() {
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

  console.log('[Cron] Jobs scheduled: meeting reminders (every 10 min)');
}

module.exports = { startCron };
