const { Router } = require('express');
const db = require('../db');
const smartlead = require('../services/smartlead');
const heyreach = require('../services/heyreach');
const calendar = require('../services/calendar');
const slackService = require('../services/slack');
const slackVerify = require('../middleware/slackVerify');

const router = Router();

router.post('/slack/actions', slackVerify, async (req, res) => {
  let interaction;
  try {
    interaction = JSON.parse(req.body.payload);
  } catch (err) {
    console.error('[Slack] Failed to parse interaction payload', err.message);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  res.status(200).send();

  try {
    const action = interaction.actions?.[0];
    if (!action) return;

    console.log('[Slack] Action received', { actionId: action.action_id, value: action.value });

    if (action.action_id === 'approve_reply') {
      await handleApprove(action.value, interaction);
    } else if (action.action_id === 'reject_reply') {
      await handleReject(action.value, interaction);
    }
  } catch (err) {
    console.error('[Slack] Action handler error', { err: err.message, stack: err.stack });
  }
});

async function handleApprove(replyId, interaction) {
  const { rows: [reply] } = await db.query(
    'UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING *',
    ['approved', replyId, 'pending']
  );

  if (!reply) {
    console.warn('[Slack] Reply not found or already actioned', { replyId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);

  try {
    // Send the reply via the appropriate platform
    if (reply.platform === 'smartlead') {
      await smartlead.sendReply(client.smartlead_api_key, reply.campaign_id, reply.lead_id, reply.draft_reply);
    } else if (reply.platform === 'heyreach') {
      const ctx = typeof reply.thread_context === 'string' ? JSON.parse(reply.thread_context) : reply.thread_context;
      const meta = ctx?.heyreach || {};
      await heyreach.sendMessage(
        client.heyreach_api_key,
        meta.listId,
        meta.linkedinAccountId,
        meta.linkedinUrl || reply.linkedin_url,
        reply.draft_reply
      );
    }

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', reply.draft_reply, replyId]
    );

    let statusMsg = `✅ Reply to ${reply.lead_name} approved and sent by <@${interaction.user.id}>.`;

    // If this is a MEETING_PROPOSED reply, try to book on the client's calendar
    if (reply.classification === 'MEETING_PROPOSED') {
      const { rows: [meeting] } = await db.query(
        'SELECT * FROM meetings WHERE pending_reply_id = $1',
        [replyId]
      );

      if (meeting && meeting.proposed_time) {
        const attendeeEmail = reply.lead_email || meeting.lead_email;
        if (attendeeEmail) {
          try {
            const result = await calendar.bookMeeting(reply.client_id, {
              summary: `Call with ${reply.lead_name}`,
              description: `Booked via SalesGlider AI Reply Handler (${reply.platform})`,
              startTime: parseProposedTime(meeting.proposed_time),
              durationMinutes: 30,
              attendeeEmail,
              attendeeName: reply.lead_name || 'Prospect',
            });

            await db.query(
              `UPDATE meetings SET status = 'booked', confirmed_time = $1, calendar_event_id = $2,
               calendar_provider = $3, meeting_link = $4, updated_at = now() WHERE id = $5`,
              [parseProposedTime(meeting.proposed_time), result.eventId, result.provider, result.meetingLink, meeting.id]
            );

            const linkMsg = result.meetingLink ? ` Meeting link: ${result.meetingLink}` : '';
            statusMsg = `✅ Reply to ${reply.lead_name} sent and meeting booked on ${result.provider} calendar by <@${interaction.user.id}>.${linkMsg}`;

            console.log('[Slack] Meeting booked', { meetingId: meeting.id, provider: result.provider, eventId: result.eventId });
          } catch (bookErr) {
            console.error('[Slack] Calendar booking failed (reply still sent)', { err: bookErr.message });
            statusMsg += `\n⚠️ Calendar booking failed: ${bookErr.message}. Please book manually.`;
          }
        } else {
          statusMsg += '\n⚠️ No email for this prospect — calendar invite not sent. Book manually.';
        }
      }
    }

    await slackService.updateMessage(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      statusMsg
    );

    console.log('[Slack] Reply approved and sent', { replyId, platform: reply.platform, lead: reply.lead_name });

  } catch (err) {
    console.error('[Slack] Failed to send reply after approval', { replyId, err: err.message });
    await db.query('UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2', ['flagged', replyId]);
    await slackService.updateMessage(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      `⚠️ Reply to ${reply.lead_name} was approved but failed to send: ${err.message}. Please reply manually.`
    );
  }
}

async function handleReject(replyId, interaction) {
  const { rows: [reply] } = await db.query(
    'UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING *',
    ['rejected', replyId, 'pending']
  );

  if (!reply) return;

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);

  await slackService.updateMessage(
    client.slack_bot_token, interaction.channel.id, interaction.message.ts,
    `❌ Reply to ${reply.lead_name} rejected by <@${interaction.user.id}>.`
  );

  console.log('[Slack] Reply rejected', { replyId, lead: reply.lead_name });
}

function parseProposedTime(proposedTime) {
  if (!proposedTime) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}/.test(proposedTime)) return new Date(proposedTime).toISOString();

  const now = new Date();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const lower = proposedTime.toLowerCase();
  let targetDate = new Date(now);

  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i])) {
      let daysAhead = i - now.getDay();
      if (daysAhead <= 0) daysAhead += 7;
      targetDate = new Date(now);
      targetDate.setDate(now.getDate() + daysAhead);
      break;
    }
  }

  if (lower.includes('tomorrow')) {
    targetDate = new Date(now);
    targetDate.setDate(now.getDate() + 1);
  }

  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2] || '0');
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    targetDate.setHours(hours, minutes, 0, 0);
  }

  return targetDate.toISOString();
}

module.exports = router;
