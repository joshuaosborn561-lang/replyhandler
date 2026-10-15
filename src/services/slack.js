const { WebClient } = require('@slack/web-api');
const { cleanInboundReply, stripOutlookCss } = require('../utils/smartlead-webhook-helpers');
const { isDeepRootsClient } = require('../utils/meeting-modality');

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
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/div>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s);
  s = stripOutlookCss(s);
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

function enrichmentReceiptLine(receipt) {
  if (!receipt || typeof receipt !== 'object') return '';
  const hit = receipt.emailTier || receipt.phoneTier || receipt.tier_hit || null;
  const spend = Number(receipt.spentUsd ?? receipt.spent_usd);
  const bits = [];
  if (hit) bits.push(String(hit));
  if (Number.isFinite(spend)) bits.push(`$${spend.toFixed(2)}`);
  if (!bits.length) return '';
  return `\n🧾 ${escMrkdwn(bits.join(' · '))}`;
}

function phoneEnrichmentLine({ leadPhone, phoneProvider, phoneEnrichmentStatus } = {}) {
  const phone = String(leadPhone || '').trim();
  const provider = String(phoneProvider || '').trim();
  if (phone) {
    const providerLabel = {
      getleads: 'GetLeads',
      smartlead: 'Smartlead',
      aiark: 'AI Ark',
      prospeo: 'Prospeo',
      fullenrich: 'FullEnrich',
    }[provider.toLowerCase()] || provider;
    return `\n📱 ${escMrkdwn(phone)}${providerLabel ? ` _(${escMrkdwn(providerLabel)})_` : ''}`;
  }
  // After enrichment finishes with no cell — plain English, not provider jargon.
  if (
    phoneEnrichmentStatus === 'not_found' ||
    phoneEnrichmentStatus === 'failed'
  ) {
    return '\n📱 _phone number not found_';
  }
  return '';
}

function normalizeLinkedinUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/linkedin\.com\//i.test(s)) return `https://${s.replace(/^\/+/, '')}`;
  return '';
}

const CONSUMER_WEBSITE_HOST = /gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com/i;

function normalizeWebsiteUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const url = /^https?:\/\//i.test(s) ? s : (s.includes('.') && !s.includes(' ') ? `https://${s}` : '');
  if (!url) return '';
  const host = url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  if (CONSUMER_WEBSITE_HOST.test(host)) return '';
  return url;
}

function clickableUrlLine(emoji, url) {
  let label = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  if (label.length > 60) label = `${label.slice(0, 57)}…`;
  return `\n${emoji} <${url}|${escMrkdwn(label)}>`;
}

/** Clickable LinkedIn on the Lead field — or "LinkedIn: not found", never silent omit. */
function linkedinUrlLine(leadLinkedinUrl) {
  const url = normalizeLinkedinUrl(leadLinkedinUrl);
  if (url) return clickableUrlLine('🔗', url);
  return '\n🔗 LinkedIn: not found';
}

/** Clickable company website — or "Website: not found". Free-mail hosts are not a website. */
function websiteUrlLine(leadWebsite) {
  const url = normalizeWebsiteUrl(leadWebsite);
  if (url) return clickableUrlLine('🌐', url);
  return '\n🌐 Website: not found';
}

/**
 * ICP line on every reply card. Topup icp-llm stores fit + P(PASS);
 * display is "{n}% qualified|disqualified: {reason}" or "ICP: unknown (reason)".
 */
function icpVerdictLine(leadIcpVerdict) {
  const v = leadIcpVerdict && typeof leadIcpVerdict === 'object' ? leadIcpVerdict : null;
  if (!v || !v.status || v.status === 'unknown') {
    const why = String(v?.reason || 'unknown').replace(/[()]/g, '').trim() || 'unknown';
    return `\n🎯 ICP: unknown (${escMrkdwn(why)})`;
  }
  const word = v.status === 'qualified' ? 'qualified' : 'disqualified';
  const pct = Number.isFinite(Number(v.confidence)) ? `${Math.round(Number(v.confidence))}% ` : '';
  const reason = String(v.reason || word).replace(/\s+/g, ' ').trim().slice(0, 180);
  return `\n🎯 ${escMrkdwn(`${pct}${word}: ${reason}`)}`;
}

function leadFieldText({
  leadName,
  leadEmail,
  leadPhone,
  phoneProvider,
  phoneEnrichmentStatus,
  leadLinkedinUrl,
  leadWebsite,
  enrichmentReceipt,
  leadIcpVerdict,
} = {}) {
  return (
    `*${escMrkdwn(leadName || 'Unknown')}*` +
    `${leadEmail ? ` · ${escMrkdwn(leadEmail)}` : ''}` +
    phoneEnrichmentLine({ leadPhone, phoneProvider, phoneEnrichmentStatus }) +
    linkedinUrlLine(leadLinkedinUrl) +
    websiteUrlLine(leadWebsite) +
    icpVerdictLine(leadIcpVerdict) +
    enrichmentReceiptLine(enrichmentReceipt)
  );
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
function ccAutoNoticeBlock({ ccEmails, ccRoundRobinEmails, clientName }) {
  const always = String(ccEmails || '').trim();
  const rr = String(ccRoundRobinEmails || '').trim();
  if (!always && !rr) return null;
  const lines = [];
  if (always) {
    lines.push(isDeepRootsClient(clientName)
      ? `*Tyler notify (qualified + wants a call only):* ${escMrkdwn(always)}`
      : `*Always notify:* ${escMrkdwn(always)}`);
  }
  if (rr) lines.push(`*Round-robin (1 per send):* ${escMrkdwn(rr)}`);
  const intro = isDeepRootsClient(clientName)
    ? '📬 Tyler is emailed only when they look qualified (employees + $1–10M EBITDA) and want to schedule a call — not on every send'
    : '📬 Prospect reply has no CC — primary Gmail notify on Approve (thread + LinkedIn/website/email/cell)';
  return {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `${intro}\n${lines.join('\n')}`,
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

/** One turn on the exchange. Longer emails are cut so a thread still fits one Slack message. */
const EXCHANGE_TURN_MAX = 1600;
/** Headroom for the lead line, the draft, and the buttons above the transcript. */
const EXCHANGE_TURN_CAP = 24;
/** Slack rejects oversized block payloads. Stay under this for the transcript text. */
const EXCHANGE_CHAR_BUDGET = 12000;

function isPlaceholderInbound(text) {
  const s = String(text || '').trim().toLowerCase();
  return !s
    || s.startsWith('(no new reply')
    || s.includes('follow-up re-attempt');
}

function normTurn(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function exchangeWhen(time) {
  if (!time) return '';
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
}

function lastThreadTurn({ threadMessages, inboundMessage, lastOutboundMessage, preferThem = false } = {}) {
  const history = Array.isArray(threadMessages)
    ? threadMessages.filter((m) => m && m.body && String(m.body).trim())
    : [];

  const fromHistory = (wantThem) => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const last = history[i];
      if (wantThem && last.role !== 'them') continue;
      const raw = String(last.body || '');
      if (last.role === 'them' && isPlaceholderInbound(raw)) continue;
      const body = last.role === 'them' ? cleanInboundReply(raw) : plainTextForSlack(raw);
      if (body && !isPlaceholderInbound(body)) {
        return { role: last.role === 'us' ? 'us' : 'them', body };
      }
    }
    return null;
  };

  if (preferThem) {
    const theirs = fromHistory(true);
    if (theirs) return theirs;
    const inbound = cleanInboundReply(inboundMessage || '');
    if (inbound && !isPlaceholderInbound(inbound)) return { role: 'them', body: inbound };
  }

  const last = fromHistory(false);
  if (last) return last;
  const inbound = cleanInboundReply(inboundMessage || '');
  if (inbound && !isPlaceholderInbound(inbound)) return { role: 'them', body: inbound };
  const ours = plainTextForSlack(lastOutboundMessage || '');
  if (ours) return { role: 'us', body: ours };
  return null;
}

function turnBody(role, raw, { stripQuotes }) {
  const body = role === 'them' && stripQuotes
    ? cleanInboundReply(raw)
    : plainTextForSlack(raw);
  if (!body || isPlaceholderInbound(body)) return '';
  return body;
}

/**
 * Chronological turns for the FOLLOW_UP card.
 * Once the thread is already split into separate messages, quoted reply
 * chains are cut off each inbound so a turn is that message, not a second
 * copy of the earlier ones. A single leftover blob keeps its quotes — that
 * blob is the only copy of the exchange.
 */
function collectExchangeTurns({
  threadMessages,
  inboundMessage,
  lastOutboundMessage,
  omitTrailingBody,
} = {}) {
  const history = Array.isArray(threadMessages)
    ? threadMessages.filter((m) => m && m.body && String(m.body).trim())
    : [];
  const stripQuotes = history.length >= 2;
  const turns = [];
  const push = (role, raw, time) => {
    const who = role === 'us' ? 'us' : 'them';
    const body = turnBody(who, raw, { stripQuotes });
    if (!body) return;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === who && normTurn(prev.body) === normTurn(body)) return;
    turns.push({ role: who, body, time: time || '' });
  };

  if (history.length) {
    for (const m of history) push(m.role, m.body, m.time);
  } else {
    if (lastOutboundMessage) push('us', lastOutboundMessage);
    if (inboundMessage) push('them', inboundMessage);
  }

  const omit = normTurn(omitTrailingBody);
  if (omit && turns.length) {
    const last = turns[turns.length - 1];
    if (last.role === 'us' && normTurn(last.body) === omit) turns.pop();
  }
  return turns;
}

function capExchangeTurns(turns) {
  let list = turns.map((t, i) => ({ ...t, n: i + 1 }));
  if (list.length > EXCHANGE_TURN_CAP) {
    const omitted = list.length - EXCHANGE_TURN_CAP;
    const head = list.slice(0, 2);
    const tail = list.slice(list.length - (EXCHANGE_TURN_CAP - 2));
    list = [...head, { role: 'omitted', omitted }, ...tail];
  }

  const bodyLen = (items) => items.reduce((n, t) => n + (t.body ? t.body.length : 0), 0);
  while (bodyLen(list) > EXCHANGE_CHAR_BUDGET) {
    const real = list.filter((t) => t.role !== 'omitted');
    if (real.length <= 4) {
      const over = bodyLen(list) - EXCHANGE_CHAR_BUDGET;
      const share = Math.ceil(over / Math.max(real.length, 1)) + 1;
      list = list.map((t) => {
        if (!t.body || t.body.length <= 240) return t;
        const next = t.body.slice(0, Math.max(240, t.body.length - share)).trimEnd();
        return { ...t, body: `${next}…` };
      });
      if (bodyLen(list) <= EXCHANGE_CHAR_BUDGET) break;
      break;
    }
    const dropAt = list.findIndex((t, i) => i >= 2 && t.role !== 'omitted');
    if (dropAt < 0) break;
    list.splice(dropAt, 1);
    const marker = list.find((t) => t.role === 'omitted');
    if (marker) marker.omitted += 1;
    else list.splice(2, 0, { role: 'omitted', omitted: 1 });
  }
  return list;
}

function buildFollowUpExchangeBlocks({
  threadMessages,
  inboundMessage,
  lastOutboundMessage,
  omitTrailingBody,
} = {}) {
  const turns = capExchangeTurns(collectExchangeTurns({
    threadMessages,
    inboundMessage,
    lastOutboundMessage,
    omitTrailingBody,
  }));
  if (!turns.length) return [];

  const blocks = [
    dividerBlock(),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Email exchange*' },
    },
  ];

  for (const turn of turns) {
    if (turn.role === 'omitted') {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_… ${turn.omitted} earlier message${turn.omitted === 1 ? '' : 's'} not shown …_`,
        }],
      });
      continue;
    }
    const when = exchangeWhen(turn.time);
    const who = turn.role === 'us' ? 'You' : 'Them';
    blocks.push(
      ...conversationStepBlocks({
        emoji: turn.role === 'us' ? '📤' : '📥',
        label: when ? `${turn.n} · ${who} · ${when}` : `${turn.n} · ${who}`,
        body: turn.body,
        maxLen: EXCHANGE_TURN_MAX,
      }),
    );
  }
  return blocks;
}

function buildFollowUpOutgoingBlocks({
  draft,
  outgoingLabel = 'Suggested follow-up',
  outgoingBody = null,
} = {}) {
  const sendBody = outgoingBody != null ? outgoingBody : draft;
  if (sendBody == null || String(sendBody).trim() === '') return [];
  const isSent = /sent/i.test(String(outgoingLabel || ''));
  return conversationStepBlocks({
    emoji: isSent ? '📤' : '✍️',
    label: outgoingLabel,
    body: sendBody,
    neverTruncate: true,
  });
}

/**
 * FOLLOW_UP layout: the send first, then every turn in the thread.
 * The send stays above the transcript so Slack "See more" cannot hide the draft.
 */
function buildFollowUpConversationBlocks({
  lastOutboundMessage,
  inboundMessage,
  draft,
  threadMessages = null,
  outgoingLabel = 'Suggested follow-up',
  outgoingBody = null,
} = {}) {
  const sendBody = outgoingBody != null ? outgoingBody : draft;
  const omitTrailingBody = /sent/i.test(String(outgoingLabel || '')) ? sendBody : null;
  return [
    ...buildFollowUpOutgoingBlocks({ draft, outgoingLabel, outgoingBody }),
    ...buildFollowUpExchangeBlocks({
      threadMessages,
      inboundMessage,
      lastOutboundMessage,
      omitTrailingBody,
    }),
  ];
}

function buildConversationBlocks({
  lastOutboundMessage,
  inboundMessage,
  draft,
  priorLabel,
  inboundLabel,
  /** FOLLOW_UP cards render the send, then the whole exchange. */
  followUpContext = false,
  /** Full back-and-forth when available: [{ role: 'us'|'them', body }]. */
  threadMessages = null,
}) {
  if (followUpContext) {
    return buildFollowUpConversationBlocks({
      lastOutboundMessage,
      inboundMessage,
      draft,
      threadMessages,
    });
  }

  const blocks = [];
  const theirLabel = inboundLabel || 'They replied';
  const ourLabel = priorLabel || 'You sent';

  blocks.push(
    ...conversationStepBlocks({
      emoji: '📤',
      label: ourLabel,
      body: lastOutboundMessage,
      maxLen: OUTBOUND_DISPLAY_MAX,
    }),
  );

  blocks.push(dividerBlock());

  blocks.push(
    ...conversationStepBlocks({
      emoji: '📥',
      label: theirLabel,
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

/** Approve / Edit / Reject / DQ / Meeting booked — shared so FOLLOW_UP can pin them up top. */
function draftApprovalActionsBlock(replyId) {
  return {
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
        text: { type: 'plain_text', text: '❌ Reject & not interested' },
        style: 'danger',
        action_id: 'reject_reply',
        value: replyId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🚫 DQ' },
        action_id: 'dq_prospect',
        value: replyId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '📅 Meeting booked' },
        action_id: 'meeting_booked',
        value: replyId,
      },
    ],
  };
}

function buildSentConfirmationBlocks({
  leadName,
  leadEmail,
  leadPhone,
  phoneProvider,
  phoneEnrichmentStatus,
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
  threadMessages,
  leadLinkedinUrl,
  leadWebsite,
  enrichmentReceipt,
  leadIcpVerdict,
}) {
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';
  // Keep the enriched cellphone + LinkedIn + website on the Lead line after
  // Approve/Reject/DQ — they used to vanish when the card flipped to confirmation.
  const leadLine = leadFieldText({
    leadName, leadEmail, leadPhone, phoneProvider, phoneEnrichmentStatus,
    leadLinkedinUrl, leadWebsite, enrichmentReceipt, leadIcpVerdict,
  });
  const isFollowUp = String(classification || '').toUpperCase() === 'FOLLOW_UP';

  const headers = {
    approved: '✅ SENT — Approved & sent',
    edited: '✏️ SENT — Edited & sent',
    rejected: '❌ Rejected — not interested',
    disqualified: '🚫 DQ — no follow-ups',
    meeting_booked: '📅 Meeting booked — follow-ups stopped',
    failed: '⚠️ Send failed',
  };
  const footers = {
    approved: 'Approved & sent',
    edited: 'Edited & sent',
    rejected: 'Rejected · marked not interested',
    disqualified: 'Disqualified · excluded from follow-up nudges',
    meeting_booked: 'Meeting booked · follow-up sequence cancelled',
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
    ...(isFollowUp
      ? buildFollowUpOutgoingBlocks({
          draft: (sentReply && String(sentReply).trim()
            && kind !== 'rejected' && kind !== 'disqualified' && kind !== 'meeting_booked')
            ? sentReply
            : null,
          outgoingLabel: 'Sent to prospect',
        })
      : buildConversationBlocks({
          lastOutboundMessage,
          inboundMessage,
          draft: null,
          priorLabel: contextLabel || 'You sent',
          inboundLabel: 'They replied',
        })),
  ];

  if (!isFollowUp && sentReply && String(sentReply).trim()
      && kind !== 'rejected' && kind !== 'disqualified' && kind !== 'meeting_booked') {
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

  if (isFollowUp) {
    const sentShown = sentReply && String(sentReply).trim()
      && kind !== 'rejected' && kind !== 'disqualified' && kind !== 'meeting_booked';
    blocks.push(...buildFollowUpExchangeBlocks({
      threadMessages,
      inboundMessage,
      lastOutboundMessage,
      omitTrailingBody: sentShown ? sentReply : null,
    }));
  }

  return blocks;
}

async function updateSentConfirmationCard(token, channelId, messageTs, opts) {
  const slack = getClient(token);
  const blocks = buildSentConfirmationBlocks(opts);
  const preview = plainTextForSlack(opts.sentReply || opts.inboundMessage).slice(0, 120);
  const lead = opts.leadName || 'prospect';
  const textPrefix = opts.actionKind === 'rejected'
    ? 'Rejected — not interested'
    : opts.actionKind === 'disqualified'
      ? 'DQ'
      : opts.actionKind === 'meeting_booked'
        ? 'Meeting booked'
        : 'Sent';
  const text = `${textPrefix} — ${lead}${preview ? `: ${preview}` : ''}`;

  return slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks,
  });
}

function buildDraftApprovalCard({
  replyId, leadName, leadEmail, platform, classification, draft, reasoning, inboundMessage,
  campaignDisplay, lastOutboundMessage, contextLabel, inThread, ccEmail,
  ccEmails, ccRoundRobinEmails, leadPhone, phoneProvider, phoneEnrichmentStatus,
  threadPermalink, threadMessages, leadLinkedinUrl, leadWebsite, clientName, enrichmentReceipt,
  leadIcpVerdict,
}) {
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';
  const leadLine = leadFieldText({
    leadName, leadEmail, leadPhone, phoneProvider, phoneEnrichmentStatus,
    leadLinkedinUrl, leadWebsite, enrichmentReceipt, leadIcpVerdict,
  });
  const isFollowUp = String(classification || '').toUpperCase() === 'FOLLOW_UP';
  const headerText = inThread
    ? `↩️ ${platform.toUpperCase()} — ${classification}`
    : `📩 ${platform.toUpperCase()} — ${classification}`;

  let contextText = `_${escMrkdwn(classification)}${reasoning ? ` · ${escMrkdwn(reasoning)}` : ''}_`;
  if (threadPermalink) {
    contextText += ` · <${threadPermalink}|Original thread>`;
  }

  const metaBlocks = [
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
  ];

  const conversation = isFollowUp
    ? null
    : buildConversationBlocks({
      lastOutboundMessage,
      inboundMessage,
      draft,
      priorLabel: contextLabel || 'You sent',
      inboundLabel: 'They replied',
    });

  const blocks = isFollowUp
    ? [
        // Lead → suggested send → buttons, then the whole email exchange.
        // The send and the buttons stay above the transcript so Slack
        // "See more" cannot hide them.
        ...metaBlocks,
        dividerBlock(),
        ...buildFollowUpOutgoingBlocks({ draft }),
        draftApprovalActionsBlock(replyId),
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: contextText }],
        },
        ...buildFollowUpExchangeBlocks({
          threadMessages,
          inboundMessage,
          lastOutboundMessage,
        }),
      ]
    : [
        ...metaBlocks,
        dividerBlock(),
        ...conversation,
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: contextText }],
        },
      ];

  if (!isFollowUp && platform === 'smartlead') {
    const notice = ccAutoNoticeBlock({
      ccEmails: ccEmails || ccEmail,
      ccRoundRobinEmails,
      clientName,
    });
    if (notice) blocks.push(notice);
  }

  // Non-follow-up cards keep actions at the bottom (short cards).
  if (!isFollowUp) {
    blocks.push(draftApprovalActionsBlock(replyId));
  }

  const preview = plainTextForSlack(draft || inboundMessage).slice(0, 120);
  const text = `New ${platform} reply from ${leadName} — ${classification}${preview ? `: ${preview}` : ''}`;
  return { blocks, text };
}

async function postDraftApproval(token, channelId, opts) {
  const slack = getClient(token);
  const { blocks, text } = buildDraftApprovalCard(opts);
  return slack.chat.postMessage({
    channel: channelId,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    text,
    blocks,
  });
}

/** Rewrite an already-posted approval card in place. */
async function updateDraftApprovalCard(token, channelId, messageTs, opts) {
  const slack = getClient(token);
  const { blocks, text } = buildDraftApprovalCard(opts);
  return slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks,
  });
}

function buildAlertCard({
  replyId, leadName, leadEmail, leadPhone, phoneProvider, phoneEnrichmentStatus,
  leadLinkedinUrl, leadWebsite, enrichmentReceipt, leadIcpVerdict,
  platform, classification, inboundMessage, reasoning,
  campaignDisplay, lastOutboundMessage, contextLabel, inThread,
}) {
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
            `*Lead*\n` +
            leadFieldText({
              leadName, leadEmail, leadPhone, phoneProvider, phoneEnrichmentStatus,
              leadLinkedinUrl, leadWebsite, enrichmentReceipt, leadIcpVerdict,
            }),
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

  if (replyId) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🚫 DQ' },
          action_id: 'dq_prospect',
          value: replyId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📅 Meeting booked' },
          action_id: 'meeting_booked',
          value: replyId,
        },
      ],
    });
  }

  return {
    blocks,
    text: `${(platform || '').toUpperCase()} alert: ${classification} from ${leadName}`,
  };
}

async function postAlert(token, channelId, opts) {
  const slack = getClient(token);
  const { blocks, text } = buildAlertCard(opts);
  return slack.chat.postMessage({
    channel: channelId,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    text,
    blocks,
  });
}

async function updateAlertCard(token, channelId, messageTs, opts) {
  const slack = getClient(token);
  const { blocks, text } = buildAlertCard(opts);
  return slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
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

/** Plain notice for Cayden when the portal claims, releases, or notes a lead. */
async function postClientActionNotice(token, channelId, text, threadTs) {
  const slack = getClient(token);
  return slack.chat.postMessage({
    channel: channelId,
    text,
    ...(threadTs ? { thread_ts: String(threadTs) } : {}),
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

/** Best-effort Slack permalink for an existing channel message. */
async function getPermalink(token, channelId, messageTs) {
  if (!token || !channelId || !messageTs) return null;
  try {
    const slack = getClient(token);
    const res = await slack.chat.getPermalink({
      channel: channelId,
      message_ts: String(messageTs),
    });
    return res?.permalink || null;
  } catch (err) {
    console.warn('[Slack] getPermalink failed', { channelId, messageTs, err: err.message });
    return null;
  }
}

module.exports = {
  postDraftApproval,
  updateDraftApprovalCard,
  buildDraftApprovalCard,
  leadFieldText,
  icpVerdictLine,
  linkedinUrlLine,
  websiteUrlLine,
  normalizeLinkedinUrl,
  normalizeWebsiteUrl,
  postAlert,
  updateAlertCard,
  buildAlertCard,
  postError,
  postClientActionNotice,
  postProspectFollowUpReminder,
  updateMessage,
  updateSentConfirmationCard,
  buildSentConfirmationBlocks,
  buildConversationBlocks,
  buildFollowUpConversationBlocks,
  lastThreadTurn,
  draftApprovalActionsBlock,
  openEditReplyModal,
  postMorningDigestHeader,
  postAttentionDigestHeader,
  postPendingApprovalDigest,
  getPermalink,
};
