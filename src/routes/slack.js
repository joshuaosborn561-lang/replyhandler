const { withSmartleadKey } = require('../services/campaign-routing');
const { Router } = require('express');
const db = require('../db');
const slackService = require('../services/slack');
const { postProspectSlackCard } = require('../services/slack-reply-post');
const slackVerify = require('../middleware/slackVerify');
const { digestRecipients } = require('../services/client-reply-digest');
const { alwaysForwardEmailsForProspectCc } = require('../services/client-cc');
const { sendReplyToPlatform, maybeBookMeetingAfterSend, isSlackTestFixtureReply } = require('../services/reply-send');
const { extractReferredContacts, parseReferralCcInput, referralCcCsv } = require('../utils/referred-contact');
const { filterOwnAddresses } = require('../utils/own-addresses');
const { ourIdentitiesFromThread } = require('../utils/reply-all');
const { scheduleAfterOutboundSend, cancelPendingForThread, heyreachConversationId } = require('../services/outbound-follow-up');
const { markDisqualified } = require('../services/disqualified-prospects');
const { markMeetingBooked } = require('../services/meeting-booked');
const smartlead = require('../services/smartlead');
const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');
const { learnFromApprovedReply } = require('../services/approved-reply-learning');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');
const { extractThreadMessages } = require('../utils/thread-transcript');
const { readFollowUpMeta } = require('../utils/follow-up-meta');
const { noticeIfClosed } = require('../services/card-click-guard');

const router = Router();

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

async function slackCardContextFromReply(reply, client) {
  let tc = reply.thread_context;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  const campaignId = reply.campaign_id;
  let campaignName = campaignNameFromReply(reply);
  let lastOutbound = '';

  if (reply.platform === 'heyreach' && tc && typeof tc === 'object' && !Array.isArray(tc)) {
    const meta = tc.heyreach && typeof tc.heyreach === 'object' ? tc.heyreach : {};
    campaignName = campaignName || meta.campaignName || null;
    lastOutbound = heyreachLastOutboundFromMessages(tc.messages);
  } else if (reply.platform === 'smartlead' && tc && typeof tc === 'object') {
    lastOutbound = lastOutboundBodyFromSmartleadHistory(tc) || '';
  }

  // Older rows only stored the numeric id — look up the human name once and persist it.
  if (
    !campaignName &&
    reply.platform === 'smartlead' &&
    client?.smartlead_api_key &&
    campaignId
  ) {
    campaignName = await smartlead.resolveCampaignName(client.smartlead_api_key, campaignId);
    if (campaignName && reply.id) {
      await db.query(
        `UPDATE pending_replies
            SET campaign_name = $1, updated_at = now()
          WHERE id = $2
            AND (campaign_name IS NULL OR campaign_name = '')`,
        [campaignName, reply.id]
      ).catch(() => {});
    }
  }

  const campaignDisplay = formatCampaignDisplay(campaignName, campaignId);
  const threadMessages = String(reply.classification || '').toUpperCase() === 'FOLLOW_UP'
    ? extractThreadMessages(reply.platform, tc, {
      maxMessages: 40,
      pinStart: true,
      extraMessages: [
        ...(reply.inbound_message ? [{ role: 'them', body: reply.inbound_message }] : []),
        ...((reply.sent_reply || lastOutbound)
          ? [{ role: 'us', body: reply.sent_reply || lastOutbound }]
          : []),
      ],
    })
    : undefined;
  return {
    campaignDisplay: campaignDisplay || undefined,
    lastOutboundMessage: lastOutbound || undefined,
    threadMessages,
  };
}

function normDraft(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function sentCardPayload(reply, ctx, { sentReply, actionKind, userId, extraFooter, ccUsed }) {
  const followMeta = readFollowUpMeta(reply.thread_context);
  return {
    leadName: reply.lead_name,
    leadEmail: reply.lead_email,
    leadPhone: reply.lead_phone || undefined,
    phoneProvider: reply.lead_phone_provider || undefined,
    phoneEnrichmentStatus: reply.phone_enrichment_status || undefined,
    leadLinkedinUrl: reply.linkedin_url || undefined,
    leadWebsite: reply.lead_website || undefined,
    leadPhoneAlt: reply.lead_phone_alt || undefined,
    leadLocation: reply.lead_location || undefined,
    leadTimezone: reply.lead_timezone || undefined,
    leadFullName: reply.lead_full_name || undefined,
    leadIcpVerdict: reply.icp_verdict || undefined,
    platform: reply.platform,
    classification: reply.classification,
    inboundMessage: reply.inbound_message,
    lastOutboundMessage: ctx.lastOutboundMessage,
    contextLabel: 'You sent',
    campaignDisplay: ctx.campaignDisplay,
    threadMessages: ctx.threadMessages,
    sentReply,
    actionKind,
    userId,
    extraFooter,
    ccUsed,
    needsClient: followMeta.needsClient,
    whatToSend: followMeta.whatToSend,
  };
}

function ccUsedLabel(reply, client, sendResult) {
  if (reply.platform !== 'smartlead') return undefined;
  if (sendResult?.clientNotifySkipped) return undefined;
  if (sendResult?.clientCcWarning) return undefined;
  if (sendResult?.clientNotifyMode === 'rollup' || sendResult?.clientNotifyMode === 'off') {
    // Roll-up mode: the client is NOT emailed now. Say so only for replies queued for the 4:00pm CT email.
    if (sendResult.clientNotifyMode === 'off' || !sendResult.clientDigestQueued) return undefined;
    const to = digestRecipients(client).to.join(', ');
    if (!to) return undefined;
    return { email: to, mode: 'rollup', roundRobin: null, cellPhone: sendResult?.leadCellPhone || null };
  }
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

  // Follow-up sequence: "call back later" time picker. Validate before acknowledging.
  if (interaction.type === 'view_submission' && interaction.view?.callback_id === 'fseq_callback_modal') {
    const seqSvc = require('../services/followup-sequence');
    const errors = seqSvc.validateCallbackSubmission(interaction);
    if (errors) return res.status(200).json({ response_action: 'errors', errors });
    res.status(200).json({ response_action: 'clear' });
    try {
      await seqSvc.handleCallbackSubmit(interaction);
    } catch (err) {
      console.error('[Slack] Callback modal submit error', { err: err.message, stack: err.stack });
    }
    return;
  }

  // Nurture Day 30: edit modal. Validate before closing, then approve with the edited text.
  if (interaction.type === 'view_submission' && interaction.view?.callback_id === 'nurture_d30_edit_modal') {
    const nurtureSvc = require('../services/nurture-day30');
    const errors = nurtureSvc.validateEditSubmission(interaction);
    if (errors) return res.status(200).json({ response_action: 'errors', errors });
    res.status(200).json({ response_action: 'clear' });
    try {
      await nurtureSvc.handleEditSubmit(interaction);
    } catch (err) {
      console.error('[Slack] Nurture edit submit error', { err: err.message, stack: err.stack });
    }
    return;
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

    // A button on a reply someone else (or the booking bridge) already closed: say so, privately.
    // Approve still falls through so its handler can relabel the stale card.
    if (await noticeIfClosed(action, interaction)
      && !String(action.action_id).startsWith('approve_reply')) {
      return;
    }

    if (action.action_id === 'approve_reply') {
      await handleApprove(action.value, interaction);
    } else if (action.action_id === 'approve_reply_cc_client') {
      await handleApprove(action.value, interaction, { ccClientOnProspect: true });
    } else if (action.action_id === 'approve_reply_cc_referral') {
      await handleApprove(action.value, interaction, { referralCcFromRow: true });
    } else if (action.action_id === 'reject_reply') {
      await handleReject(action.value, interaction);
    } else if (action.action_id === 'dq_prospect') {
      await handleDisqualify(action.value, interaction);
    } else if (action.action_id === 'meeting_booked') {
      await handleMeetingBooked(action.value, interaction);
    } else if (action.action_id === 'open_edit_modal') {
      await handleOpenEditModal(action.value, interaction);
    } else if (action.action_id === 'toggle_cc_client') {
      await handleToggleCcClient(action);
    } else if (String(action.action_id || '').startsWith('fseq_')) {
      await require('../services/followup-sequence').handleCallButton(action, interaction);
    } else if (String(action.action_id || '').startsWith('nurture_d30_')) {
      await require('../services/nurture-day30').handleButton(action, interaction);
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

  const client = withSmartleadKey((await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id])).rows[0]);
  // Never offer Josh's inbox, Cayden or our own domains as a referral CC (older rows may have stored one).
  const detectedCc = reply.platform === 'smartlead'
    ? filterOwnAddresses(String(reply.referral_cc || '').trim() || referralCcCsv(extractReferredContacts(reply.inbound_message, {
      prospectEmail: reply.lead_email,
      prospectName: reply.lead_name,
    }))).join(', ')
    : '';
  const sendingInboxes = reply.platform === 'smartlead' ? ourIdentitiesFromThread(reply.thread_context) : [];
  await slackService.openEditReplyModal(client.slack_bot_token, interaction.trigger_id, {
    replyId,
    initialDraft: reply.draft_reply || '',
    channelId: interaction.channel?.id,
    messageTs: interaction.message?.ts,
    ccEmail: reply.platform === 'smartlead' ? (client.cc_emails || client.cc_email) : null,
    ccEmails: reply.platform === 'smartlead' ? (client.cc_emails || client.cc_email) : null,
    ccRoundRobinEmails: reply.platform === 'smartlead' ? client.cc_round_robin_emails : null,
    referralCc: detectedCc,
    // "CC client on this reply" checkbox: the Always-CC list, same as the card's Send + CC client button.
    ccClientEmails: reply.platform === 'smartlead'
      ? alwaysForwardEmailsForProspectCc(client, {
        leadEmail: reply.lead_email,
        exclude: sendingInboxes,
        excludeDomains: sendingInboxes.map((e) => e.split('@')[1]).filter(Boolean),
      })
      : '',
    ccOnSend: Boolean(reply.cc_on_send),
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
  const ccState = interaction.view.state.values?.referral_cc_block?.referral_cc_input;
  const referralCcField = ccState ? String(ccState.value || '') : null;

  const { rows: [reply] } = await db.query(
    `UPDATE pending_replies SET status = $1, updated_at = now()
     WHERE id = $2 AND status IN ('pending', 'flagged') RETURNING *`,
    ['approved', replyId]
  );

  if (!reply) {
    console.warn('[Slack] Edit submit: reply not found or already actioned', { replyId });
    return;
  }

  const client = withSmartleadKey((await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id])).rows[0]);

  const originalDraft = reply.draft_reply;
  const wasEdited = normDraft(messageText) !== normDraft(originalDraft);
  const ctx = await slackCardContextFromReply(reply, client);

  try {
    let referralCc = null;
    if (referralCcField != null) {
      const parsed = parseReferralCcInput(referralCcField, { prospectEmail: reply.lead_email });
      if (parsed.error) throw new Error(parsed.error);
      referralCc = parsed.emails;
    }
    const ccClientOnProspect = reply.platform === 'smartlead'
      && slackService.ccClientSelectedInModal(interaction.view.state.values);
    const sendResult = await sendReplyToPlatform(client, reply, messageText, {
      ccClientOnProspect,
      referralCc,
    }) || {};
    const skippedDuplicate = Boolean(sendResult.skippedDuplicate);

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, draft_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', messageText, replyId]
    );

    // Keep the AI draft Josh started from: the diff against what he sent is
    // the strongest voice signal the Friday learning job has. Best-effort —
    // the column arrives with migration 027 and a miss must not fail the send.
    if (wasEdited && originalDraft) {
      try {
        await db.query(
          'UPDATE pending_replies SET original_draft = COALESCE(original_draft, $1) WHERE id = $2',
          [originalDraft, replyId]
        );
      } catch (err) {
        console.warn('[Slack] Could not store original_draft (migration 027 not applied?)', { replyId, err: err.message });
      }
    }

    const { rows: [sentReply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
    if (!skippedDuplicate) {
      if (sentReply) await scheduleAfterOutboundSend(client.id, sentReply);
      await learnFromApprovedReply({ reply, client, finalText: messageText });
    }

    let extraFooter = '';
    if (skippedDuplicate) {
      extraFooter = 'Already sent this reply — skipped the duplicate.';
    } else {
      if (isSlackTestFixtureReply(reply)) {
        extraFooter = 'Test card — no SmartLead/HeyReach message sent.';
      }
      extraFooter += await maybeBookMeetingAfterSend({ ...reply, draft_reply: messageText, lead_email: reply.lead_email }, client);
      if (sendResult.clientCcWarning) {
        extraFooter += `\n⚠️ ${sendResult.clientCcWarning}`;
      }
      if (sendResult.clientNotifySkipped) {
        extraFooter += `\nTyler notify skipped — ${sendResult.clientNotifySkipReason}`;
      }
      if (sendResult.prospectCcEmails) {
        extraFooter += `\nProspect thread CC: ${sendResult.prospectCcEmails}`;
      }
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

/** Plain status update on the clicked card. Never throws. */
async function setCardStatus(token, interaction, text) {
  try {
    if (!token || !interaction?.channel?.id || !interaction?.message?.ts) return;
    await slackService.updateMessage(token, interaction.channel.id, interaction.message.ts, text);
  } catch (err) {
    console.warn('[Slack] Card status update failed', { err: err.message });
  }
}

async function handleApprove(replyId, interaction, { ccClientOnProspect = false, referralCcFromRow = false } = {}) {
  const { rows: [reply] } = await db.query(
    `UPDATE pending_replies SET status = $1, updated_at = now()
     WHERE id = $2 AND status IN ('pending', 'flagged') RETURNING *`,
    ['approved', replyId]
  );

  if (!reply) {
    console.warn('[Slack] Reply not found or already actioned', { replyId });
    const { rows: [existing] } = await db.query(
      `SELECT r.status, c.slack_bot_token FROM pending_replies r
         JOIN clients c ON c.id = r.client_id WHERE r.id = $1`,
      [replyId]
    ).catch(() => ({ rows: [] }));
    if (existing?.slack_bot_token) {
      const label = existing.status === 'sent'
        ? '✅ Already sent'
        : existing.status === 'approved'
          ? '⏳ Sending...'
          : `Already handled (${existing.status})`;
      await setCardStatus(existing.slack_bot_token, interaction, label);
    }
    return;
  }

  const client = withSmartleadKey((await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id])).rows[0]);
  await setCardStatus(client.slack_bot_token, interaction, '⏳ Sending...');
  const ctx = await slackCardContextFromReply(reply, client);

  try {
    let referralCc = null;
    if (referralCcFromRow) {
      const csv = String(reply.referral_cc || '').trim() || referralCcCsv(extractReferredContacts(reply.inbound_message, {
        prospectEmail: reply.lead_email,
        prospectName: reply.lead_name,
      }));
      const parsed = parseReferralCcInput(csv, { prospectEmail: reply.lead_email });
      if (parsed.error || !parsed.emails.length) {
        throw new Error(parsed.error || 'No referred email to CC. Nothing was sent.');
      }
      referralCc = parsed.emails;
    }
    const sendResult = await sendReplyToPlatform(client, reply, reply.draft_reply, {
      ccClientOnProspect,
      referralCc,
    }) || {};
    const skippedDuplicate = Boolean(sendResult.skippedDuplicate);

    await db.query(
      'UPDATE pending_replies SET status = $1, sent_reply = $2, updated_at = now() WHERE id = $3',
      ['sent', reply.draft_reply, replyId]
    );

    const { rows: [sentReply] } = await db.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
    if (!skippedDuplicate) {
      // Post-send bookkeeping must not turn a sent reply into a failed card.
      try {
        if (sentReply) await scheduleAfterOutboundSend(client.id, sentReply);
        await learnFromApprovedReply({ reply, client, finalText: reply.draft_reply });
      } catch (err) {
        console.warn('[Slack] Post-send bookkeeping failed', { replyId, err: err.message });
      }
    }

    let extraFooter = '';
    if (skippedDuplicate) {
      extraFooter = 'Already sent this reply — skipped the duplicate.';
    } else {
      if (isSlackTestFixtureReply(reply)) {
        extraFooter = 'Test card — no SmartLead/HeyReach message sent.';
      }
      extraFooter += await maybeBookMeetingAfterSend(reply, client);
      if (sendResult.clientCcWarning) {
        extraFooter += `\n⚠️ ${sendResult.clientCcWarning}`;
      }
      if (sendResult.clientNotifySkipped) {
        extraFooter += `\nTyler notify skipped — ${sendResult.clientNotifySkipReason}`;
      }
      if (sendResult.prospectCcEmails) {
        extraFooter += `\nProspect thread CC: ${sendResult.prospectCcEmails}`;
      }
      if (sendResult.referralCcEmails) {
        extraFooter += `\nReferred contact CC: ${sendResult.referralCcEmails}`;
      }
      if (sendResult.clientNotifyError) {
        extraFooter += `\n⚠️ Reply sent, but the client notify copy failed: ${sendResult.clientNotifyError}`;
      }
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
    ).catch(async (err) => {
      console.warn('[Slack] Sent card render failed', { replyId, err: err.message });
      await setCardStatus(client.slack_bot_token, interaction, skippedDuplicate ? '✅ Already sent' : '✅ Sent');
    });

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
  const { rows: [pending] } = await db.query(
    `SELECT * FROM pending_replies WHERE id = $1 AND status = 'pending'`,
    [replyId]
  );
  if (!pending) return;

  // FOLLOW_UP reject skips this step only — do not mark Not Interested
  // and do not cancel later cadence steps. The next scheduled follow-up
  // still posts.
  if (String(pending.classification || '').toUpperCase() === 'FOLLOW_UP') {
    const { rows: [reply] } = await db.query(
      `UPDATE pending_replies
          SET status = 'skipped', updated_at = now()
        WHERE id = $1 AND status = 'pending' AND classification = 'FOLLOW_UP'
        RETURNING *`,
      [replyId]
    );
    if (!reply) return;
    const client = withSmartleadKey((await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id])).rows[0]);
    const ctx = await slackCardContextFromReply(reply, client);
    await slackService.updateSentConfirmationCard(
      client.slack_bot_token, interaction.channel.id, interaction.message.ts,
      sentCardPayload(reply, ctx, {
        sentReply: null,
        actionKind: 'skipped',
        userId: interaction.user.id,
        extraFooter: 'Skipped — next follow-up still scheduled',
      })
    );
    console.log('[Slack] Follow-up step skipped — cadence continues', {
      replyId, lead: reply.lead_name, step: reply.follow_up_step,
    });
    return;
  }

  const { rows: [reply] } = await db.query(
    `UPDATE pending_replies
        SET status = $1, classification = 'NOT_INTERESTED', updated_at = now()
      WHERE id = $2 AND status = $3
      RETURNING *`,
    ['rejected', replyId, 'pending']
  );

  if (!reply) return;

  const client = withSmartleadKey((await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id])).rows[0]);
  const ctx = await slackCardContextFromReply(reply, client);

  let extraFooter = '';
  if (reply.platform === 'smartlead' && !isSlackTestFixtureReply(reply)) {
    try {
      const marked = await smartlead.markLeadNotInterested(
        client.smartlead_api_key,
        reply.campaign_id,
        reply.lead_id
      );
      extraFooter = 'SmartLead category set to Not Interested.';
      console.log('[Slack] SmartLead marked not interested', {
        replyId, lead: reply.lead_name, categoryId: marked.categoryId,
      });
    } catch (err) {
      extraFooter = `Rejected locally; SmartLead category update failed: ${err.message}`;
      console.error('[Slack] SmartLead not-interested update failed', {
        replyId, lead: reply.lead_name, err: err.message,
      });
    }
  }

  let cancelled = 0;
  try {
    cancelled = await cancelPendingForThread(client.id, {
      platform: reply.platform,
      campaignId: reply.campaign_id,
      leadId: reply.lead_id,
      conversationId: heyreachConversationId(reply),
    });
  } catch (err) {
    console.error('[Slack] Reject follow-up cancel failed', { replyId, err: err.message });
  }
  if (cancelled > 0) {
    extraFooter += extraFooter ? '\n' : '';
    extraFooter += `Cancelled ${cancelled} pending follow-up nudge${cancelled === 1 ? '' : 's'}.`;
  }

  await slackService.updateSentConfirmationCard(
    client.slack_bot_token, interaction.channel.id, interaction.message.ts,
    sentCardPayload(reply, ctx, {
      sentReply: null,
      actionKind: 'rejected',
      userId: interaction.user.id,
      extraFooter: extraFooter.trim() || undefined,
    })
  );

  console.log('[Slack] Reply rejected and marked not interested', { replyId, lead: reply.lead_name });
}

/**
 * DQ = out of ICP. Cancels pending follow-up nudges and blocks future ones
 * for this prospect. Works on draft cards and alert-only cards.
 */
async function handleDisqualify(replyId, interaction) {
  const { rows: [reply] } = await db.query(
    `SELECT * FROM pending_replies
      WHERE id = $1
        AND status IN ('pending', 'alert_only', 'flagged')`,
    [replyId]
  );
  if (!reply) {
    console.warn('[Slack] DQ: reply not found or already actioned', { replyId });
    return;
  }

  const client = withSmartleadKey((await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id])).rows[0]);
  const result = await markDisqualified({
    clientId: client.id,
    reply,
    reason: 'slack_dq',
    slackUserId: interaction.user?.id || null,
  });
  const ctx = await slackCardContextFromReply(reply, client);
  const cancelled = result.cancelledFollowUps || 0;

  await slackService.updateSentConfirmationCard(
    client.slack_bot_token, interaction.channel.id, interaction.message.ts,
    sentCardPayload(reply, ctx, {
      sentReply: null,
      actionKind: 'disqualified',
      userId: interaction.user.id,
      extraFooter: cancelled > 0
        ? `Cancelled ${cancelled} pending follow-up nudge${cancelled === 1 ? '' : 's'}.`
        : 'No pending follow-up nudges. Future nudges blocked.',
    })
  );

  console.log('[Slack] Prospect disqualified', {
    replyId, lead: reply.lead_name, cancelledFollowUps: cancelled,
  });
}

/**
 * Meeting booked = stop the follow-up cadence and record a booked meeting.
 * Does not DQ the prospect.
 */
async function handleMeetingBooked(replyId, interaction) {
  const { rows: [reply] } = await db.query(
    `SELECT * FROM pending_replies
      WHERE id = $1
        AND status IN ('pending', 'alert_only', 'flagged')`,
    [replyId]
  );
  if (!reply) {
    console.warn('[Slack] Meeting booked: reply not found or already actioned', { replyId });
    return;
  }

  const client = withSmartleadKey((await db.query('SELECT * FROM clients WHERE id = $1', [reply.client_id])).rows[0]);
  const result = await markMeetingBooked({
    clientId: client.id,
    reply,
    slackUserId: interaction.user?.id || null,
  });
  const ctx = await slackCardContextFromReply(reply, client);
  const cancelled = result.cancelledFollowUps || 0;

  await slackService.updateSentConfirmationCard(
    client.slack_bot_token, interaction.channel.id, interaction.message.ts,
    sentCardPayload(reply, ctx, {
      sentReply: null,
      actionKind: 'meeting_booked',
      userId: interaction.user.id,
      extraFooter: cancelled > 0
        ? `Cancelled ${cancelled} pending follow-up nudge${cancelled === 1 ? '' : 's'}.`
        : 'Follow-up sequence stopped.',
    })
  );

  console.log('[Slack] Meeting booked', {
    replyId, lead: reply.lead_name, cancelledFollowUps: cancelled,
  });
}

// Card builders reused by services that retire a card outside a button click
// (services/retire-slack-cards.js). Kept here so the card-layout guard tests still see them.
router.cardHelpers = { slackCardContextFromReply, sentCardPayload };

module.exports = router;
