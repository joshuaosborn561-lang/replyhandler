const { Router } = require('express');
const db = require('../db');
const smartlead = require('../services/smartlead');
const heyreach = require('../services/heyreach');
const calcom = require('../services/calcom');
const slackService = require('../services/slack');
const slackVerify = require('../middleware/slackVerify');

const router = Router();

router.post('/slack/actions', slackVerify, async (req, res) => {
  // Slack sends interaction payloads as application/x-www-form-urlencoded with a "payload" field
  let interaction;
  try {
    interaction = JSON.parse(req.body.payload);
  } catch (err) {
    console.error('[Slack] Failed to parse interaction payload', err.message);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Acknowledge immediately — Slack requires a response within 3 seconds
  res.status(200).send();

  try {
    const action = interaction.actions?.[0];
    if (!action) return;

    const actionId = action.action_id;
    const channelId = interaction.channel?.id;

    console.log('[Slack] Action received', { actionId, value: action.value });

    if (actionId === 'approve_reply') {
      await handleApprove(action.value, interaction);
    } else if (actionId === 'reject_reply') {
      await handleReject(action.value, interaction);
    } else if (actionId === 'confirm_booking') {
      const { meetingId, replyId } = JSON.parse(action.value);
      await handleConfirmBooking(meetingId, replyId, null, interaction);
    } else if (actionId === 'confirm_booking_with_email') {
      const { meetingId, replyId } = JSON.parse(action.value);
      // Extract email from the input block
      const stateValues = interaction.state?.values || {};
      const emailBlock = stateValues.email_input_block;
      const email = emailBlock?.email_input?.value;
      if (!email) {
        await postEphemeral(interaction, 'Please enter an email address before confirming.');
        return;
      }
      await handleConfirmBooking(meetingId, replyId, email, interaction);
    } else if (actionId === 'suggest_time') {
      const { meetingId, replyId } = JSON.parse(action.value);
      await handleSuggestTime(meetingId, replyId, interaction);
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

  // Send the reply via the appropriate platform
  try {
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

    // Update Slack message to show it was sent
    await slackService.updateMessage(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      `✅ Reply to ${reply.lead_name} approved and sent by <@${interaction.user.id}>.`
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

async function handleConfirmBooking(meetingId, replyId, manualEmail, interaction) {
  const { rows: [meeting] } = await db.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
  if (!meeting) {
    console.warn('[Slack] Meeting not found', { meetingId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [meeting.client_id]);
  const { rows: [reply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);

  const email = manualEmail || meeting.lead_email;
  if (!email) {
    console.error('[Slack] No email available for booking', { meetingId });
    return;
  }

  // Update email if manually provided
  if (manualEmail) {
    await db.query('UPDATE meetings SET lead_email = $1 WHERE id = $2', [manualEmail, meetingId]);
    await db.query('UPDATE pending_replies SET lead_email = $1 WHERE id = $2', [manualEmail, replyId]);
  }

  try {
    // Parse proposed_time into an ISO string — best effort
    const startTime = parseProposedTime(meeting.proposed_time);

    const booking = await calcom.createBooking(client.calcom_event_type_id, {
      name: meeting.lead_name || 'Prospect',
      email,
      startTime,
      notes: `Booked via ${reply?.platform || 'unknown'} campaign reply`,
    });

    const bookingUid = booking.uid || booking.id;
    await db.query(
      'UPDATE meetings SET status = $1, confirmed_time = $2, calcom_booking_uid = $3, updated_at = now() WHERE id = $4',
      ['booked', startTime, bookingUid, meetingId]
    );
    await db.query('UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2', ['sent', replyId]);

    await slackService.updateMessage(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      `✅ Meeting with ${meeting.lead_name} booked by <@${interaction.user.id}>. Cal.com will send the confirmation email.`
    );

    console.log('[Slack] Meeting booked', { meetingId, bookingUid, email });

  } catch (err) {
    console.error('[Slack] Failed to create booking', { meetingId, err: err.message });
    await slackService.updateMessage(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      `⚠️ Booking for ${meeting.lead_name} failed: ${err.message}. Please book manually.`
    );
  }
}

async function handleSuggestTime(meetingId, replyId, interaction) {
  const { rows: [meeting] } = await db.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [meeting.client_id]);

  await slackService.updateMessage(
    client.slack_bot_token, interaction.channel.id, interaction.message.ts,
    `🕐 <@${interaction.user.id}> chose to suggest a different time for ${meeting.lead_name}. Please reply manually with alternative times.`
  );

  await db.query('UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2', ['flagged', replyId]);
}

function parseProposedTime(proposedTime) {
  if (!proposedTime) return new Date().toISOString();

  // If it's already ISO format, return as-is
  if (/^\d{4}-\d{2}-\d{2}/.test(proposedTime)) {
    return new Date(proposedTime).toISOString();
  }

  // Try natural language parsing — map day names to upcoming dates
  const now = new Date();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const lower = proposedTime.toLowerCase();

  let targetDate = new Date(now);

  // Find day of week mention
  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i])) {
      const currentDay = now.getDay();
      let daysAhead = i - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      targetDate = new Date(now);
      targetDate.setDate(now.getDate() + daysAhead);
      break;
    }
  }

  // Find time mention (e.g., "2pm", "2:00 PM", "14:00")
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

async function postEphemeral(interaction, text) {
  // Can't easily post ephemeral without knowing the token, so log it
  console.warn('[Slack] Ephemeral message needed:', text);
}

module.exports = router;
