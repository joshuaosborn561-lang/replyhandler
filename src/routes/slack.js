const { Router } = require('express');
const db = require('../db');
const slackService = require('../services/slack');
const slackVerify = require('../middleware/slackVerify');
const { sendReplyToPlatform, maybeBookMeetingAfterSend, isSlackTestFixtureReply } = require('../services/reply-send');
const { scheduleAfterOutboundSend } = require('../services/outbound-follow-up');

const router = Router();

router.post('/slack/actions', slackVerify, async (req, res) => {
  let interaction;
  try {
    interaction = JSON.parse(req.body.payload);
  } catch (err) {
    console.error('[Slack] Failed to parse interaction payload', err.message);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // Modal submissions must respond within 3s — acknowledge first
  if (interaction.type === 'view_submission' && interaction.view?.callback_id === 'edit_reply_modal') {
    res.status(200).json({ response_action: 'clear' });
    try {
      await handleEditModalSubmit(interaction);
    } catch (err) {
      console.error('[Slack] Edit modal submit error', { err: err.message, stack: err.stack });
    }
    return;
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
    } else if (action.action_id === 'open_edit_modal') {
      await handleOpenEditModal(action.value, interaction);
    } else if (action.action_id === 'already_replied_yes') {
      await handleAlreadyRepliedYes(action.value, interaction);
    } else if (action.action_id === 'already_replied_no') {
      await handleAlreadyRepliedNo(action.value, interaction);
    } else if (action.action_id === 'snooze_nudge_30') {
      await handleSnoozeNudge(action.value, interaction, 30);
    }
  } catch (err) {
    console.error('[Slack] Action handler error', { err: err.message, stack: err.stack });
  }
});

async function handleOpenEditModal(replyId, interaction) {
  const { rows: [reply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1 AND status = $2', [replyId, 'pending']);
  if (!reply) {
    console.warn('[Slack] open_edit_modal: reply not pending', { replyId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  await slackService.openEditReplyModal(client.slack_bot_token, interaction.trigger_id, {
    replyId,
    initialDraft: reply.draft_reply || '',
    channelId: interaction.channel?.id,
    messageTs: interaction.message?.ts,
  });
}

async function handleEditModalSubmit(interaction) {
  let meta;
  try {
    meta = JSON.parse(interaction.view.private_metadata || '{}');
  } catch {
    meta = {};
  }
  const replyId = meta.replyId;
  const channelId = meta.channelId;
  const messageTs = meta.messageTs;
  if (!replyId) return;

  const draftState = interaction.view.state.values?.draft_block?.draft_input;
  const messageText = (draftState?.value || '').trim();
  if (!messageText) return;

  const { rows: [reply] } = await db.query(
    'UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING *',
    ['approved', replyId, 'pending']
  );

  if (!reply) {
    console.warn('[Slack] Edit submit: reply not found or already actioned', { replyId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);

  try {
    await sendReplyToPlatform(client, reply, messageText);

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', messageText, replyId]
    );

    const { rows: [sentReply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
    if (sentReply) await scheduleAfterOutboundSend(client.id, sentReply);

    let statusMsg = `✅ Reply to ${reply.lead_name} edited and sent by <@${interaction.user.id}>.`;
    if (isSlackTestFixtureReply(reply)) {
      statusMsg += '\n_(Test card from `/admin/test/slack-draft` — no SmartLead/HeyReach message sent.)_';
    }
    statusMsg += await maybeBookMeetingAfterSend({ ...reply, draft_reply: messageText, lead_email: reply.lead_email }, client);

    if (channelId && messageTs) {
      await slackService.updateMessage(
        client.slack_bot_token, channelId, messageTs,
        statusMsg
      );
    }
  } catch (err) {
    console.error('[Slack] Edit modal send failed', { replyId, err: err.message });
    await db.query('UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2', ['flagged', replyId]);
    if (channelId && messageTs) {
      await slackService.updateMessage(
        client.slack_bot_token, channelId, messageTs,
        `⚠️ Reply to ${reply.lead_name} was edited but failed to send: ${err.message}. Please reply manually.`
      );
    }
  }
}

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
    await sendReplyToPlatform(client, reply, reply.draft_reply);

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', reply.draft_reply, replyId]
    );

    const { rows: [sentReply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
    if (sentReply) await scheduleAfterOutboundSend(client.id, sentReply);

    let statusMsg = `✅ Reply to ${reply.lead_name} approved and sent by <@${interaction.user.id}>.`;
    if (isSlackTestFixtureReply(reply)) {
      statusMsg += '\n_(Test card from `/admin/test/slack-draft` — no SmartLead/HeyReach message sent.)_';
    }
    statusMsg += await maybeBookMeetingAfterSend(reply, client);

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


async function handleAlreadyRepliedYes(replyId, interaction) {
  const { rows: [reply] } = await db.query(
    `UPDATE pending_replies SET status = 'sent', updated_at = now(),
        sent_reply = COALESCE(sent_reply, draft_reply)
      WHERE id = $1 AND status IN ('pending','approved')
      RETURNING *`,
    [replyId]
  );
  if (!reply) {
    console.warn('[Slack] already_replied_yes: row not pending', { replyId });
    return;
  }
  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  if (interaction.channel?.id && interaction.message?.ts) {
    // Replace the inline nudge with a confirmation (keeps the original approval card intact above).
    try {
      await slackService.updateMessage(
        client.slack_bot_token, interaction.channel.id, interaction.message.ts,
        `✅ Marked as already replied by <@${interaction.user.id}> — ${reply.lead_name}.`
      );
    } catch (e) { console.error('[Slack] update nudge failed', { err: e.message }); }
  }
  try {
    const { rows: pendingReply } = await db.query('SELECT slack_message_ts FROM pending_replies WHERE id = $1', [replyId]);
    const parentTs = pendingReply[0]?.slack_message_ts;
    if (parentTs) {
      await slackService.updateMessage(
        client.slack_bot_token, interaction.channel.id, parentTs,
        `✅ Reply to ${reply.lead_name} marked as already replied by <@${interaction.user.id}> (outside app).`
      );
    }
  } catch (e) { console.error('[Slack] update parent failed', { err: e.message }); }
  console.log('[Slack] already replied marked', { replyId, lead: reply.lead_name });
}

async function handleAlreadyRepliedNo(replyId, interaction) {
  const { rows: [reply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
  if (!reply) {
    console.warn('[Slack] already_replied_no: reply not found', { replyId });
    return;
  }
  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  const draft = reply.draft_reply || '(no draft stored — use Edit & send)';

  // Post the draft as a fresh approval card so user can Approve/Edit/Reject with the same send path.
  const posted = await slackService.postDraftApproval(
    client.slack_bot_token,
    client.slack_channel_id,
    {
      replyId: reply.id,
      leadName: reply.lead_name,
      leadEmail: reply.lead_email,
      platform: reply.platform,
      classification: reply.classification || 'FOLLOW_UP',
      draft,
      reasoning: 'Re-surfaced because you said you have not replied yet.',
      inboundMessage: reply.inbound_message || '(no inbound)',
    }
  );
  await db.query('UPDATE pending_replies SET slack_message_ts = $1, status = $2, updated_at = now() WHERE id = $3',
    [posted.ts, 'pending', replyId]
  );
}


async function handleSnoozeNudge(replyId, interaction, minutes) {
  const mins = Math.max(1, parseInt(minutes, 10) || 30);
  const { rows: [reply] } = await db.query(
    `UPDATE pending_replies
        SET pending_nudge_snoozed_until = now() + ($2::int * interval '1 minute'),
            pending_nudge_next_at = now() + ($2::int * interval '1 minute'),
            updated_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [replyId, mins]
  );
  if (!reply) {
    console.warn('[Slack] snooze: reply not pending', { replyId });
    return;
  }
  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  if (interaction.channel?.id && interaction.message?.ts) {
    try {
      await slackService.updateMessage(
        client.slack_bot_token,
        interaction.channel.id,
        interaction.message.ts,
        `💤 Nudge snoozed ${mins} min for *${reply.lead_name}* by <@${interaction.user.id}>.`
      );
    } catch (e) {
      console.error('[Slack] snooze update failed', { err: e.message });
    }
  }
  console.log('[Slack] nudge snoozed', { replyId, lead: reply.lead_name, mins });
}

module.exports = router;
