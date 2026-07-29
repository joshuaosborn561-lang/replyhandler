const { Router } = require('express');
const db = require('../db');
const slackService = require('../services/slack');
const { postProspectSlackCard } = require('../services/slack-reply-post');
const slackVerify = require('../middleware/slackVerify');
const { sendReplyToPlatform, maybeBookMeetingAfterSend, isSlackTestFixtureReply } = require('../services/reply-send');
const { scheduleAfterOutboundSend } = require('../services/outbound-follow-up');
const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');
const { learnFromApprovedReply } = require('../services/approved-reply-learning');

const router = Router();

function formatCampaignDisplay(campaignName, campaignId) {
  const id = campaignId != null ? String(campaignId).trim() : '';
  const name = campaignName != null ? String(campaignName).trim() : '';
  if (name && id) return `${name} (${id})`;
  if (name) return name;
  if (id) return `Campaign ${id}`;
  return '';
}

function heyreachLastOutboundFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let last = '';
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '').toLowerCase();
    const isUs = role === 'us' || role === 'me' || role === 'sender' || role === 'user';
    if (!isUs) continue;
    const txt =
      (typeof m.message === 'string' && m.message) ||
      (typeof m.text === 'string' && m.text) ||
      (typeof m.body === 'string' && m.body) ||
      '';
    if (txt && String(txt).trim()) last = String(txt).trim();
  }
  return last;
}

function slackCardContextFromReply(reply) {
  let tc = reply.thread_context;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  const campaignId = reply.campaign_id;
  let campaignDisplay = formatCampaignDisplay(null, campaignId);
  let lastOutbound = '';

  if (reply.platform === 'heyreach' && tc && typeof tc === 'object' && !Array.isArray(tc)) {
    const meta = tc.heyreach && typeof tc.heyreach === 'object' ? tc.heyreach : {};
    campaignDisplay = formatCampaignDisplay(meta.campaignName, campaignId) || campaignDisplay;
    lastOutbound = heyreachLastOutboundFromMessages(tc.messages);
  } else if (reply.platform === 'smartlead' && tc && typeof tc === 'object') {
    lastOutbound = lastOutboundBodyFromSmartleadHistory(tc) || '';
  }

  return { campaignDisplay: campaignDisplay || undefined, lastOutboundMessage: lastOutbound || undefined };
}

function normDraft(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function sentCardPayload(reply, ctx, { sentReply, actionKind, userId, extraFooter, ccUsed }) {
  return {
    leadName: reply.lead_name,
    leadEmail: reply.lead_email,
    platform: reply.platform,
    classification: reply.classification,
    inboundMessage: reply.inbound_message,
    lastOutboundMessage: ctx.lastOutboundMessage,
    contextLabel: 'You sent',
    campaignDisplay: ctx.campaignDisplay,
    sentReply,
    actionKind,
    userId,
    extraFooter,
    ccUsed,
  };
}

function ccUsedLabel(reply, client, sendResult) {
  if (reply.platform !== 'smartlead') return undefined;
  if (sendResult?.clientCcWarning) return undefined;
  const email = String(sendResult?.clientCcEmails || '').trim()
    || String(client.cc_emails || client.cc_email || '').trim();
  if (!email) return undefined;
  const rr = sendResult?.clientCcRoundRobin || null;
  return {
    email,
    mode: sendResult?.clientCcMode || 'gmail',
    roundRobin: rr,
    cellPhone: sendResult?.leadCellPhone || null,
  };
}

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
    } else if (action.action_id === 'toggle_cc_client') {
      await handleToggleCcClient(action);
    }
  } catch (err) {
    console.error('[Slack] Action handler error', { err: err.message, stack: err.stack });
  }
});

async function handleOpenEditModal(replyId, interaction) {
  const { rows: [reply] } = await db.query(
    'SELECT * FROM pending_replies WHERE id = $1 AND status IN ($2, $3)',
    [replyId, 'pending', 'flagged']
  );
  if (!reply) {
    console.warn('[Slack] open_edit_modal: reply not pending/flagged', { replyId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  await slackService.openEditReplyModal(client.slack_bot_token, interaction.trigger_id, {
    replyId,
    initialDraft: reply.draft_reply || '',
    channelId: interaction.channel?.id,
    messageTs: interaction.message?.ts,
    ccEmail: reply.platform === 'smartlead' ? (client.cc_emails || client.cc_email) : null,
    ccEmails: reply.platform === 'smartlead' ? (client.cc_emails || client.cc_email) : null,
    ccRoundRobinEmails: reply.platform === 'smartlead' ? client.cc_round_robin_emails : null,
  });
}

async function handleToggleCcClient(action) {
  const blockId = action.block_id || '';
  const replyId = blockId.startsWith('cc_toggle_') ? blockId.slice('cc_toggle_'.length) : null;
  if (!replyId) {
    console.warn('[Slack] toggle_cc_client: missing replyId', { blockId });
    return;
  }
  const ccOn = Array.isArray(action.selected_options) && action.selected_options.length > 0;
  const { rowCount } = await db.query(
    `UPDATE pending_replies SET cc_on_send = $1, updated_at = now()
      WHERE id = $2 AND status IN ('pending', 'flagged')`,
    [ccOn, replyId]
  );
  if (!rowCount) {
    console.warn('[Slack] toggle_cc_client: reply not pending', { replyId, ccOn });
  }
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
    `UPDATE pending_replies SET status = $1, updated_at = now()
     WHERE id = $2 AND status IN ('pending', 'flagged') RETURNING *`,
    ['approved', replyId]
  );

  if (!reply) {
    console.warn('[Slack] Edit submit: reply not found or already actioned', { replyId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);

  const originalDraft = reply.draft_reply;
  const wasEdited = normDraft(messageText) !== normDraft(originalDraft);
  const ctx = slackCardContextFromReply(reply);

  try {
    const sendResult = await sendReplyToPlatform(client, reply, messageText) || {};

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, draft_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', messageText, replyId]
    );

    const { rows: [sentReply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
    if (sentReply) await scheduleAfterOutboundSend(client.id, sentReply);
    await learnFromApprovedReply({ reply, client, finalText: messageText });

    let extraFooter = '';
    if (isSlackTestFixtureReply(reply)) {
      extraFooter = 'Test card — no SmartLead/HeyReach message sent.';
    }
    extraFooter += await maybeBookMeetingAfterSend({ ...reply, draft_reply: messageText, lead_email: reply.lead_email }, client);
    if (sendResult.clientCcWarning) {
      extraFooter += `\n⚠️ ${sendResult.clientCcWarning}`;
    }

    if (channelId && messageTs) {
      await slackService.updateSentConfirmationCard(
        client.slack_bot_token, channelId, messageTs,
        sentCardPayload(reply, ctx, {
          sentReply: messageText,
          actionKind: wasEdited ? 'edited' : 'approved',
          userId: interaction.user.id,
          extraFooter: extraFooter.trim() || undefined,
          ccUsed: ccUsedLabel(reply, client, sendResult),
        })
      );
    }
  } catch (err) {
    console.error('[Slack] Edit modal send failed', { replyId, err: err.message });
    await db.query('UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2', ['flagged', replyId]);
    if (channelId && messageTs) {
      await slackService.updateSentConfirmationCard(
        client.slack_bot_token, channelId, messageTs,
        sentCardPayload(reply, ctx, {
          sentReply: messageText,
          actionKind: 'failed',
          userId: interaction.user.id,
          extraFooter: err.message,
        })
      );
    }
  }
}

async function handleApprove(replyId, interaction) {
  const { rows: [reply] } = await db.query(
    `UPDATE pending_replies SET status = $1, updated_at = now()
     WHERE id = $2 AND status IN ('pending', 'flagged') RETURNING *`,
    ['approved', replyId]
  );

  if (!reply) {
    console.warn('[Slack] Reply not found or already actioned', { replyId });
    return;
  }

  const { rows: [client] } = await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id]);
  const ctx = slackCardContextFromReply(reply);

  try {
    const sendResult = await sendReplyToPlatform(client, reply, reply.draft_reply) || {};

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', reply.draft_reply, replyId]
    );

    const { rows: [sentReply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
    if (sentReply) await scheduleAfterOutboundSend(client.id, sentReply);
    await learnFromApprovedReply({ reply, client, finalText: reply.draft_reply });

    let extraFooter = '';
    if (isSlackTestFixtureReply(reply)) {
      extraFooter = 'Test card — no SmartLead/HeyReach message sent.';
    }
    extraFooter += await maybeBookMeetingAfterSend(reply, client);
    if (sendResult.clientCcWarning) {
      extraFooter += `\n⚠️ ${sendResult.clientCcWarning}`;
    }

    await slackService.updateSentConfirmationCard(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      sentCardPayload(reply, ctx, {
        sentReply: reply.draft_reply,
        actionKind: 'approved',
        userId: interaction.user.id,
        extraFooter: extraFooter.trim() || undefined,
        ccUsed: ccUsedLabel(reply, client, sendResult),
      })
    );

    console.log('[Slack] Reply approved and sent', { replyId, platform: reply.platform, lead: reply.lead_name });
  } catch (err) {
    console.error('[Slack] Failed to send reply after approval', { replyId, err: err.message });
    await db.query('UPDATE pending_replies SET status = $1, updated_at = now() WHERE id = $2', ['flagged', replyId]);
    await slackService.updateSentConfirmationCard(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      sentCardPayload(reply, ctx, {
        sentReply: reply.draft_reply,
        actionKind: 'failed',
        userId: interaction.user.id,
        extraFooter: err.message,
      })
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
  const ctx = slackCardContextFromReply(reply);

  await slackService.updateSentConfirmationCard(
    client.slack_bot_token, interaction.channel.id, interaction.message.ts,
    sentCardPayload(reply, ctx, {
      sentReply: null,
      actionKind: 'rejected',
      userId: interaction.user.id,
    })
  );

  console.log('[Slack] Reply rejected', { replyId, lead: reply.lead_name });
}

module.exports = router;
