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
      'UPDATE pending_replies SET status = $1, sent_reply = $2, draft_reply = $2, updated_at = now() WHERE id = $3',
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

module.exports = router;
