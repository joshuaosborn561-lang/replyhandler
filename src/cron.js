const cron = require('node-cron');
const db = require('./db');
const slack = require('./services/slack');

function startCron() {
  // Run every 10 minutes
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

        // Only remind if we haven't already sent a reminder at this level
        // reminder_count 0 = no reminder, 1 = 30-min reminder sent, 2 = escalation sent
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

          console.log('[Cron] Reminder sent', {
            replyId: reply.id,
            client: reply.client_name,
            lead: reply.lead_name,
            ageMinutes,
            escalated: shouldEscalate,
          });
        } catch (err) {
          console.error('[Cron] Failed to send reminder', {
            replyId: reply.id,
            client: reply.client_name,
            err: err.message,
          });
        }
      }

      if (staleReplies.length > 0) {
        console.log('[Cron] Processed', staleReplies.length, 'stale replies');
      }
    } catch (err) {
      console.error('[Cron] Check failed', { err: err.message, stack: err.stack });
    }
  });

  console.log('[Cron] Reminder job scheduled (every 10 minutes)');
}

module.exports = { startCron };
