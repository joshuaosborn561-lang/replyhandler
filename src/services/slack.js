const { WebClient } = require('@slack/web-api');

// Cache WebClient instances per token
const clientCache = new Map();

function getClient(token) {
  if (!clientCache.has(token)) {
    clientCache.set(token, new WebClient(token));
  }
  return clientCache.get(token);
}

async function postDraftApproval(token, channelId, { replyId, leadName, leadEmail, platform, classification, draft, reasoning, inboundMessage }) {
  const slack = getClient(token);

  return slack.chat.postMessage({
    channel: channelId,
    text: `New ${platform} reply from ${leadName} — ${classification}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📩 ${platform.toUpperCase()} Reply — ${classification}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*From:* ${leadName}${leadEmail ? ` (${leadEmail})` : ''}\n*Classification:* ${classification}\n*Reasoning:* ${reasoning}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Their message:*\n>${inboundMessage.split('\n').join('\n>')}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Draft reply:*\n${draft}` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve & Send' },
            style: 'primary',
            action_id: 'approve_reply',
            value: replyId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Edit & send' },
            action_id: 'open_edit_modal',
            value: replyId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Reject' },
            style: 'danger',
            action_id: 'reject_reply',
            value: replyId,
          },
        ],
      },
    ],
  });
}

async function postAlert(token, channelId, { leadName, platform, classification, inboundMessage, reasoning }) {
  const slack = getClient(token);

  return slack.chat.postMessage({
    channel: channelId,
    text: `${platform.toUpperCase()} alert: ${classification} from ${leadName}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🔔 ${classification} — ${platform.toUpperCase()}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*From:* ${leadName}\n*Classification:* ${classification}\n*Reasoning:* ${reasoning}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Their message:*\n>${inboundMessage.split('\n').join('\n>')}` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'ℹ️ No draft generated — alert only.' }],
      },
    ],
  });
}

async function postError(token, channelId, { leadName, platform, error }) {
  const slack = getClient(token);

  return slack.chat.postMessage({
    channel: channelId,
    text: `⚠️ Draft generation failed for ${leadName} (${platform}). Please reply manually. Error: ${error}`,
  });
}

async function postProspectFollowUpReminder(token, channelId, {
  leadName, platform, campaignId, leadKey, hours,
}) {
  const slack = getClient(token);
  const plat = (platform || '').toUpperCase();
  const shortKey = leadKey && String(leadKey).length > 80 ? `${String(leadKey).slice(0, 80)}…` : leadKey;
  const meta = [campaignId && `campaign ${campaignId}`, shortKey && `thread ${shortKey}`].filter(Boolean).join(' · ');
  const text = `📬 *Follow-up nudge:* no reply from *${leadName || 'prospect'}* in ${hours}h after your last ${plat} message.${meta ? ` _(${meta})_` : ''}`;

  return slack.chat.postMessage({
    channel: channelId,
    text,
  });
}

async function postReminder(token, channelId, messageTs, { replyId, leadName, minutes, escalate }) {
  const slack = getClient(token);

  const text = escalate
    ? `<!here> 🚨 Reply to *${leadName}* has been pending for ${minutes} minutes. Please take action now.`
    : `⏰ Reminder: Reply to *${leadName}* has been pending for ${minutes} minutes.`;

  return slack.chat.postMessage({
    channel: channelId,
    thread_ts: messageTs,
    text,
  });
}

async function updateMessage(token, channelId, messageTs, text) {
  const slack = getClient(token);

  return slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks: [],
  });
}

async function openEditReplyModal(token, triggerId, { replyId, initialDraft, channelId, messageTs }) {
  const slack = getClient(token);
  const meta = JSON.stringify({ replyId, channelId, messageTs });

  return slack.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'edit_reply_modal',
      private_metadata: meta,
      title: { type: 'plain_text', text: 'Edit reply' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'draft_block',
          label: { type: 'plain_text', text: 'Message to send to the prospect' },
          element: {
            type: 'plain_text_input',
            action_id: 'draft_input',
            multiline: true,
            ...((initialDraft && String(initialDraft).trim())
              ? { initial_value: String(initialDraft).slice(0, 2900) }
              : {}),
          },
        },
      ],
    },
  });
}

/**
 * Threaded reminder attached to a still-pending approval card.
 * Asks "did you already reply?" with two buttons:
 *   already_replied_yes -> mark the row sent, update the parent card
 *   already_replied_no  -> post the draft below with Approve/Edit/Reject again
 */
async function postPendingNudge(token, channelId, messageTs, { replyId, leadName, minutes }) {
  const slack = getClient(token);
  return slack.chat.postMessage({
    channel: channelId,
    thread_ts: messageTs,
    text: `:bell: You haven't actioned the draft to *${leadName}* yet (${minutes} min). Did you already reply to them (e.g. on a warm call)?`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:bell: You haven't actioned the draft to *${leadName}* yet (*${minutes} min*). Did you already reply to them (e.g. on a warm call)?` },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ Yes, already replied' }, action_id: 'already_replied_yes', value: replyId, style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: '❌ No, show me the draft' }, action_id: 'already_replied_no', value: replyId },
          { type: 'button', text: { type: 'plain_text', text: '💤 Snooze 30 min' }, action_id: 'snooze_nudge_30', value: replyId },
        ],
      },
    ],
  });
}

/**
 * Post the morning digest header; individual follow-up approval cards follow as children posts.
 */
async function postMorningDigestHeader(token, channelId, { count, dateLabel }) {
  const slack = getClient(token);
  return slack.chat.postMessage({
    channel: channelId,
    text: `:sunrise: Morning follow-up digest (${dateLabel})`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🌅 Morning follow-up digest — ${dateLabel}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: count === 0
          ? 'No silent prospects from yesterday — nice.'
          : `*${count}* prospect${count === 1 ? '' : 's'} went silent yesterday. AI-drafted follow-ups below — review and hit Approve / Edit & send.` },
      },
    ],
  });
}

module.exports = {
  postDraftApproval,
  postAlert,
  postError,
  postProspectFollowUpReminder,
  postReminder,
  updateMessage,
  openEditReplyModal,
  postPendingNudge,
  postMorningDigestHeader,
};
