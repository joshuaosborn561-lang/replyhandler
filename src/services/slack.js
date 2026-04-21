const { WebClient } = require('@slack/web-api');

// Cache WebClient instances per token
const clientCache = new Map();

function getClient(token) {
  if (!clientCache.has(token)) {
    clientCache.set(token, new WebClient(token));
  }
  return clientCache.get(token);
}

function truncateForSlack(s, maxLen = 2800) {
  const t = String(s || '').trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}…`;
}

/** Slack mrkdwn: escape &, <, > so user copy does not break blocks. */
function escMrkdwn(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Slack block-quote inset (grey bar): prefix each line with `>`. */
function insetQuote(body, maxLen = 2800) {
  let b = truncateForSlack(body, maxLen);
  b = escMrkdwn(b);
  if (!b) return '_(not available)_';
  return b
    .split('\n')
    .map((line) => `>${line.length ? line : ' '}`)
    .join('\n');
}

async function postDraftApproval(token, channelId, {
  replyId, leadName, leadEmail, platform, classification, draft, reasoning, inboundMessage,
  campaignDisplay, lastOutboundMessage,
}) {
  const slack = getClient(token);
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';
  const leadBlock = `*${escMrkdwn(leadName || 'Unknown')}*${leadEmail ? `\n${escMrkdwn(leadEmail)}` : ''}`;
  const draftText = draft != null && String(draft).trim() !== ''
    ? `*Draft reply:*\n${insetQuote(draft)}`
    : '';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📩 ${platform.toUpperCase()} Reply — ${classification}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Lead*\n${leadBlock}` },
        { type: 'mrkdwn', text: `*Campaign*\n${escMrkdwn(campLine)}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Classification:* ${escMrkdwn(classification)}\n*Reasoning:* ${escMrkdwn(reasoning)}`,
      },
    },
  ];

  if (lastOutboundMessage && String(lastOutboundMessage).trim()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Your last message:*\n${insetQuote(lastOutboundMessage)}` },
    });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Their reply:*\n${insetQuote(inboundMessage)}` },
  });

  if (draftText) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: draftText } });
  }

  blocks.push(
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
  );

  return slack.chat.postMessage({
    channel: channelId,
    text: `New ${platform} reply from ${leadName} — ${classification}`,
    blocks,
  });
}

async function postAlert(token, channelId, {
  leadName, platform, classification, inboundMessage, reasoning,
  campaignDisplay, lastOutboundMessage,
}) {
  const slack = getClient(token);
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🔔 ${classification} — ${platform.toUpperCase()}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Lead*\n*${escMrkdwn(leadName || 'Unknown')}*` },
        { type: 'mrkdwn', text: `*Campaign*\n${escMrkdwn(campLine)}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Classification:* ${escMrkdwn(classification)}\n*Reasoning:* ${escMrkdwn(reasoning)}`,
      },
    },
  ];

  if (lastOutboundMessage && String(lastOutboundMessage).trim()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Your last message:*\n${insetQuote(lastOutboundMessage)}` },
    });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Their reply:*\n${insetQuote(inboundMessage)}` },
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'ℹ️ No draft generated — alert only.' }],
  });

  return slack.chat.postMessage({
    channel: channelId,
    text: `${platform.toUpperCase()} alert: ${classification} from ${leadName}`,
    blocks,
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
