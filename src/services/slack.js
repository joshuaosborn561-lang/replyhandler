const { WebClient } = require('@slack/web-api');

// Cache WebClient instances per token
const clientCache = new Map();

/** Slack section block text field max is 3000 chars — stay under for safety. */
const SLACK_SECTION_MAX = 2900;
const OUTBOUND_DISPLAY_MAX = 1400;
const INBOUND_DISPLAY_MAX = 2000;

function getClient(token) {
  if (!clientCache.has(token)) {
    clientCache.set(token, new WebClient(token));
  }
  return clientCache.get(token);
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Turn email HTML / messy copy into readable Slack plain text. */
function plainTextForSlack(raw) {
  let s = String(raw || '');
  if (!s.trim()) return '';
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/div>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

function truncateForSlack(s, maxLen = SLACK_SECTION_MAX) {
  const t = plainTextForSlack(s);
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 20).trimEnd()}… _(truncated)_`;
}

/** Slack mrkdwn: escape &, <, > so user copy does not break blocks. */
function escMrkdwn(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function phoneEnrichmentLine({ leadPhone, phoneProvider, phoneEnrichmentStatus } = {}) {
  const phone = String(leadPhone || '').trim();
  const provider = String(phoneProvider || '').trim();
  if (phone) {
    const providerLabel = {
      getleads: 'GetLeads',
      aiark: 'AI Ark',
      leadmagic: 'LeadMagic',
    }[provider.toLowerCase()] || provider;
    return `\n📱 ${escMrkdwn(phone)}${providerLabel ? ` _(${escMrkdwn(providerLabel)})_` : ''}`;
  }
  if (phoneEnrichmentStatus === 'not_found') {
    return '\n📱 _not found after GetLeads → AI Ark → LeadMagic_';
  }
  if (phoneEnrichmentStatus === 'failed') {
    return '\n📱 _enrichment failed_';
  }
  return '';
}

/** Slack block-quote inset (grey bar): prefix each line with `>`. */
function insetQuote(body) {
  const b = escMrkdwn(body);
  if (!b) return '_(not available)_';
  return b
    .split('\n')
    .map((line) => `>${line.length ? line : ' '}`)
    .join('\n');
}

function chunkForSlack(text, maxChunk = SLACK_SECTION_MAX) {
  const plain = plainTextForSlack(text);
  if (!plain) return [];
  if (plain.length <= maxChunk) return [plain];
  const chunks = [];
  let rest = plain;
  while (rest.length > maxChunk) {
    let cut = rest.lastIndexOf('\n', maxChunk);
    if (cut < maxChunk * 0.5) cut = rest.lastIndexOf(' ', maxChunk);
    if (cut < maxChunk * 0.3) cut = maxChunk;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function dividerBlock() {
  return { type: 'divider' };
}

function ccCheckboxBlock({ replyId, ccEmail, ccOnSend }) {
  const email = String(ccEmail || '').trim();
  if (!email || !replyId) return null;
  const label = email.length > 48 ? `${email.slice(0, 45)}…` : email;
  const option = {
    text: { type: 'plain_text', text: `CC ${label}` },
    value: String(replyId),
  };
  return {
    type: 'section',
    block_id: `cc_toggle_${replyId}`,
    text: { type: 'mrkdwn', text: '*Email options*' },
    accessory: {
      type: 'checkboxes',
      action_id: 'toggle_cc_client',
      options: [option],
      ...(ccOnSend ? { initial_options: [option] } : {}),
    },
  };
}

/** Always-on client-notify notice — forward list + round-robin pool. */
function ccAutoNoticeBlock({ ccEmails, ccRoundRobinEmails }) {
  const always = String(ccEmails || '').trim();
  const rr = String(ccRoundRobinEmails || '').trim();
  if (!always && !rr) return null;
  const lines = [];
  if (always) lines.push(`*Always notify:* ${escMrkdwn(always)}`);
  if (rr) lines.push(`*Round-robin (1 per send):* ${escMrkdwn(rr)}`);
  return {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `📬 Prospect reply has no CC — primary Gmail notify on Approve (thread + LinkedIn/website/email/cell)\n${lines.join('\n')}`,
    }],
  };
}

/**
 * Build one or more section blocks for a conversation step.
 * @param {object} opts
 * @param {string} opts.emoji - e.g. 📤
 * @param {string} opts.label - e.g. "You sent"
 * @param {string} opts.body - message text
 * @param {number|null} opts.maxLen - optional display cap (null = full text, chunked)
 * @param {boolean} opts.neverTruncate - draft replies: always show full text
 */
function conversationStepBlocks({ emoji, label, body, maxLen = null, neverTruncate = false }) {
  const plain = plainTextForSlack(body);
  if (!plain) {
    return [{
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji} *${label}*\n_(not available)_` },
    }];
  }

  let display = plain;
  if (!neverTruncate && maxLen != null && plain.length > maxLen) {
    display = truncateForSlack(plain, maxLen);
    const chunks = [display];
    return chunks.map((chunk, i) => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: i === 0 ? `${emoji} *${label}*\n${insetQuote(chunk)}` : insetQuote(chunk),
      },
    }));
  }

  const chunks = chunkForSlack(display);
  return chunks.map((chunk, i) => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: i === 0 ? `${emoji} *${label}*\n${insetQuote(chunk)}` : insetQuote(chunk),
    },
  }));
}

function buildConversationBlocks({
  lastOutboundMessage,
  inboundMessage,
  draft,
  priorLabel,
}) {
  const blocks = [];

  blocks.push(
    ...conversationStepBlocks({
      emoji: '📤',
      label: priorLabel || 'You sent',
      body: lastOutboundMessage,
      maxLen: OUTBOUND_DISPLAY_MAX,
    }),
  );

  blocks.push(dividerBlock());

  blocks.push(
    ...conversationStepBlocks({
      emoji: '📥',
      label: 'They replied',
      body: inboundMessage,
      maxLen: INBOUND_DISPLAY_MAX,
    }),
  );

  if (draft != null && String(draft).trim() !== '') {
    blocks.push(dividerBlock());
    blocks.push(
      ...conversationStepBlocks({
        emoji: '✍️',
        label: 'Suggested reply',
        body: draft,
        neverTruncate: true,
      }),
    );
  }

  return blocks;
}

function buildSentConfirmationBlocks({
  leadName,
  leadEmail,
  platform,
  classification,
  inboundMessage,
  lastOutboundMessage,
  contextLabel,
  campaignDisplay,
  sentReply,
  actionKind,
  userId,
  extraFooter,
  ccUsed,
}) {
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';
  const leadLine = `*${escMrkdwn(leadName || 'Unknown')}*${leadEmail ? ` · ${escMrkdwn(leadEmail)}` : ''}`;

  const headers = {
    approved: '✅ SENT — Approved & sent',
    edited: '✏️ SENT — Edited & sent',
    rejected: '❌ Rejected',
    failed: '⚠️ Send failed',
  };
  const footers = {
    approved: 'Approved & sent',
    edited: 'Edited & sent',
    rejected: 'Rejected',
    failed: 'Send failed',
  };
  const kind = headers[actionKind] ? actionKind : 'approved';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headers[kind] },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Lead*\n${leadLine}` },
        { type: 'mrkdwn', text: `*Campaign*\n${escMrkdwn(campLine)}` },
      ],
    },
    dividerBlock(),
    ...buildConversationBlocks({
      lastOutboundMessage,
      inboundMessage,
      draft: null,
      priorLabel: contextLabel || 'You sent',
    }),
  ];

  if (sentReply && String(sentReply).trim() && kind !== 'rejected') {
    blocks.push(dividerBlock());
    blocks.push(
      ...conversationStepBlocks({
        emoji: '📤',
        label: 'Sent to prospect',
        body: sentReply,
        neverTruncate: true,
      })
    );
  }

  const userBit = userId ? ` by <@${userId}>` : '';
  let footerText = `_${escMrkdwn(classification || 'reply')}${footers[kind] ? ` · ${footers[kind]}` : ''}${userBit}_`;
  if (ccUsed) {
    const email = typeof ccUsed === 'object' ? ccUsed.email : ccUsed;
    const mode = typeof ccUsed === 'object' ? (ccUsed.mode || 'gmail') : 'gmail';
    const rr = typeof ccUsed === 'object' ? ccUsed.roundRobin : null;
    let line = mode === 'gmail'
      ? `Primary Gmail notify → ${escMrkdwn(email)}`
      : `Copy forwarded to ${escMrkdwn(email)}`;
    if (rr) line += ` · RR this send: ${escMrkdwn(rr)}`;
    if (typeof ccUsed === 'object' && ccUsed.cellPhone) {
      line += ` · Cell: ${escMrkdwn(ccUsed.cellPhone)}`;
    }
    footerText += `\n_${line}_`;
  }
  if (extraFooter) footerText += `\n_${escMrkdwn(extraFooter)}_`;

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: footerText }],
  });

  return blocks;
}

async function updateSentConfirmationCard(token, channelId, messageTs, opts) {
  const slack = getClient(token);
  const blocks = buildSentConfirmationBlocks(opts);
  const preview = plainTextForSlack(opts.sentReply || opts.inboundMessage).slice(0, 120);
  const lead = opts.leadName || 'prospect';
  const text = `${opts.actionKind === 'rejected' ? 'Rejected' : 'Sent'} — ${lead}${preview ? `: ${preview}` : ''}`;

  return slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks,
  });
}

async function postDraftApproval(token, channelId, {
  replyId, leadName, leadEmail, platform, classification, draft, reasoning, inboundMessage,
  campaignDisplay, lastOutboundMessage, contextLabel, threadTs, inThread, ccEmail, ccOnSend,
  ccEmails, ccRoundRobinEmails, leadPhone, phoneProvider, phoneEnrichmentStatus,
}) {
  const slack = getClient(token);
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';
  const leadLine =
    `*${escMrkdwn(leadName || 'Unknown')}*${leadEmail ? ` · ${escMrkdwn(leadEmail)}` : ''}` +
    phoneEnrichmentLine({ leadPhone, phoneProvider, phoneEnrichmentStatus });
  const headerText = inThread
    ? `↩️ ${platform.toUpperCase()} — ${classification}`
    : `📩 ${platform.toUpperCase()} — ${classification}`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Lead*\n${leadLine}` },
        { type: 'mrkdwn', text: `*Campaign*\n${escMrkdwn(campLine)}` },
      ],
    },
    dividerBlock(),
    ...buildConversationBlocks({
      lastOutboundMessage,
      inboundMessage,
      draft,
      priorLabel: contextLabel || 'You sent',
    }),
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `_${escMrkdwn(classification)}${reasoning ? ` · ${escMrkdwn(reasoning)}` : ''}_`,
      }],
    },
  ];

  if (platform === 'smartlead') {
    const notice = ccAutoNoticeBlock({
      ccEmails: ccEmails || ccEmail,
      ccRoundRobinEmails,
    });
    if (notice) blocks.push(notice);
  }

  blocks.push({
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
    });

  const preview = plainTextForSlack(draft || inboundMessage).slice(0, 120);

  return slack.chat.postMessage({
    channel: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: `New ${platform} reply from ${leadName} — ${classification}${preview ? `: ${preview}` : ''}`,
    blocks,
  });
}

async function postAlert(token, channelId, {
  leadName, leadEmail, leadPhone, phoneProvider, phoneEnrichmentStatus,
  platform, classification, inboundMessage, reasoning,
  campaignDisplay, lastOutboundMessage, contextLabel, threadTs, inThread,
}) {
  const slack = getClient(token);
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';
  const headerText = inThread
    ? `↩️ ${classification} — ${platform.toUpperCase()}`
    : `🔔 ${classification} — ${platform.toUpperCase()}`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text:
            `*Lead*\n*${escMrkdwn(leadName || 'Unknown')}*` +
            `${leadEmail ? ` · ${escMrkdwn(leadEmail)}` : ''}` +
            phoneEnrichmentLine({ leadPhone, phoneProvider, phoneEnrichmentStatus }),
        },
        { type: 'mrkdwn', text: `*Campaign*\n${escMrkdwn(campLine)}` },
      ],
    },
    dividerBlock(),
    ...buildConversationBlocks({
      lastOutboundMessage,
      inboundMessage,
      draft: null,
      priorLabel: contextLabel || 'You sent',
    }),
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `_${escMrkdwn(classification)}${reasoning ? ` · ${escMrkdwn(reasoning)}` : ''}_` },
        { type: 'mrkdwn', text: '_ℹ️ No draft — alert only_' },
      ],
    },
  ];

  return slack.chat.postMessage({
    channel: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
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

async function updateMessage(token, channelId, messageTs, text) {
  const slack = getClient(token);

  return slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks: [],
  });
}

async function openEditReplyModal(token, triggerId, {
  replyId, initialDraft, channelId, messageTs, ccEmail, ccOnSend, ccEmails, ccRoundRobinEmails,
}) {
  const slack = getClient(token);
  const meta = JSON.stringify({ replyId, channelId, messageTs });

  const blocks = [
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
  ];

  const notice = ccAutoNoticeBlock({
    ccEmails: ccEmails || ccEmail,
    ccRoundRobinEmails,
  });
  if (notice) {
    blocks.push({
      type: 'section',
      text: notice.elements[0],
    });
  }

  return slack.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'edit_reply_modal',
      private_metadata: meta,
      title: { type: 'plain_text', text: 'Edit reply' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks,
    },
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

async function postAttentionDigestHeader(token, channelId, {
  digestType, dateLabel, pendingCount, followUpCount,
}) {
  const slack = getClient(token);
  const label = digestType === 'afternoon' ? '3pm follow-up check' : 'Morning follow-up digest';
  const total = (pendingCount || 0) + (followUpCount || 0);
  return slack.chat.postMessage({
    channel: channelId,
    text: `:spiral_calendar_pad: ${label} (${dateLabel})`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📋 ${label} — ${dateLabel}` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: total === 0
            ? 'Nothing needs attention right now.'
            : `*${pendingCount || 0}* unreplied Slack card${pendingCount === 1 ? '' : 's'} and *${followUpCount || 0}* follow-up${followUpCount === 1 ? '' : 's'} need attention.`,
        },
      },
    ],
  });
}

async function postPendingApprovalDigest(token, channelId, { pending, dateLabel }) {
  const slack = getClient(token);
  const rows = (pending || []).slice(0, 25).map((p, i) => {
    const created = p.created_at ? new Date(p.created_at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown time';
    const campaign = p.campaign_id ? ` campaign ${p.campaign_id}` : '';
    return `${i + 1}. *${escMrkdwn(p.lead_name || 'Unknown')}* (${escMrkdwn((p.platform || '').toUpperCase())}${campaign}) — ${escMrkdwn(p.classification || 'pending')} — ${escMrkdwn(created)} CT`;
  });
  return slack.chat.postMessage({
    channel: channelId,
    text: `Pending approval cards (${dateLabel})`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Pending Slack cards you have not actioned:*\n${rows.join('\n') || 'None'}`,
        },
      },
    ],
  });
}

module.exports = {
  postDraftApproval,
  postAlert,
  postError,
  postProspectFollowUpReminder,
  updateMessage,
  updateSentConfirmationCard,
  buildSentConfirmationBlocks,
  openEditReplyModal,
  postMorningDigestHeader,
  postAttentionDigestHeader,
  postPendingApprovalDigest,
};
