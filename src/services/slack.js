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

module.exports = {
  postDraftApproval,
  postAlert,
  postError,
  postReminder,
  updateMessage,
};
