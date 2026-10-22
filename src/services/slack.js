const { WebClient } = require('@slack/web-api');
const { cleanInboundReply, stripOutlookCss } = require('../utils/smartlead-webhook-helpers');
const { decodeHtmlEntities: decodeAllHtmlEntities } = require('../utils/html-entities');
const { isDeepRootsClient } = require('../utils/meeting-modality');
const { prepareFollowUpThreadTurns } = require('../utils/follow-up-thread-display');

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
  return decodeAllHtmlEntities(s)
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');
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
    const labels = {
      getleads: 'GetLeads',
      smartlead: 'Smartlead',
      aiark: 'AI Ark',
      prospeo: 'Prospeo',
      fullenrich: 'FullEnrich',
      source: '',
    };
    const pk = provider.toLowerCase();
    const providerLabel = Object.prototype.hasOwnProperty.call(labels, pk) ? labels[pk] : provider;
    return `\n📱 ${escMrkdwn(phone)}${providerLabel ? ` _(${escMrkdwn(providerLabel)})_` : ''}`;
  }
  // No phone on file: show nothing (Josh, Oct 20) — no empty/"not found" label.
  void phoneEnrichmentStatus;
  return '';
}

function normalizeLinkedinUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/linkedin\.com\//i.test(s)) return `https://${s.replace(/^\/+/, '')}`;
  return '';
}

const { CONSUMER_DOMAINS: CONSUMER_WEBSITE_HOST } = require('./prospect-enrich');

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
  const dm = v && (v.decision_maker || v.decisionMaker);
  const { decisionMakerText } = require('./decision-maker');
  const dmText = decisionMakerText(dm);
  const dmLine = dmText ? `\n👤 ${escMrkdwn(dmText)}` : '';
  if (!v || !v.status || v.status === 'unknown') {
    const why = String(v?.reason || 'unknown').replace(/[()]/g, '').trim() || 'unknown';
    const not = dm?.status === 'no' ? ' · not a fit: person is not a decision maker' : '';
    return `\n🎯 ICP: unknown (${escMrkdwn(why)})${escMrkdwn(not)}${dmLine}`;
  }
  const pct = Number.isFinite(Number(v.confidence)) ? `${Math.round(Number(v.confidence))}% ` : '';
  const reason = String(v.reason || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (v.status === 'qualified' && dm?.status === 'no') {
    return `\n🎯 ${escMrkdwn(`Not a fit: company fits (${pct}${reason || 'qualified'}) but the person replying is not a decision maker`)}${dmLine}`;
  }
  const word = v.status === 'qualified' ? 'qualified' : 'disqualified';
  const tail = v.status === 'qualified' && dm?.status === 'unknown' ? ' · decision maker unconfirmed' : '';
  return `\n🎯 ${escMrkdwn(`${pct}${word}: ${reason || word}${tail}`)}${dmLine}`;
}

/** Prefer the enriched full name when the reply only carried a first name. */
function bestFullName(leadName, leadFullName) {
  const a = String(leadName || '').trim();
  const b = String(leadFullName || '').trim();
  if (!b) return a;
  if (!a || /@/.test(a)) return b;
  const words = (x) => x.split(/\s+/).filter(Boolean).length;
  return words(b) > words(a) && b.toLowerCase().startsWith(a.split(/\s+/)[0].toLowerCase()) ? b : a;
}

/** Work-email domain → https://domain. Free-mail never counts as a website. */
function websiteFromLeadEmail(leadEmail) {
  const e = String(leadEmail || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return '';
  return normalizeWebsiteUrl(e.slice(at + 1));
}

/** Non-mobile number (landline / VoIP / unverified) when no confirmed mobile was found. */
function altPhoneLine(leadPhone, leadPhoneAlt) {
  if (String(leadPhone || '').trim()) return '';
  const alt = String(leadPhoneAlt || '').trim();
  return alt ? `\n☎️ ${escMrkdwn(alt)} _(not a confirmed mobile)_` : '';
}

/** The PERSON's location + local time zone (not company HQ). */
function locationLine(leadLocation, leadTimezone) {
  const { timezoneForLocation, timezoneLabel } = require('./lead-location');
  const loc = String(leadLocation || '').trim();
  const tz = String(leadTimezone || '').trim() || timezoneForLocation(loc) || '';
  const tzText = timezoneLabel(tz);
  if (!loc && !tzText) return '\n📍 Location: not found';
  return `\n📍 ${escMrkdwn(loc || 'Location unknown')}${tzText ? ` · 🕒 ${escMrkdwn(tzText)}` : ' · 🕒 time zone unknown'}`;
}

function leadFieldText({
  leadName,
  leadFullName,
  leadEmail,
  leadPhone,
  leadPhoneAlt,
  phoneProvider,
  phoneEnrichmentStatus,
  leadLinkedinUrl,
  leadWebsite,
  leadLocation,
  leadTimezone,
  enrichmentReceipt,
  leadIcpVerdict,
} = {}) {
  const name = bestFullName(leadName, leadFullName);
  return (
    `*${escMrkdwn(name || 'Unknown')}*` +
    `${leadEmail ? ` · ${escMrkdwn(leadEmail)}` : ''}` +
    phoneEnrichmentLine({ leadPhone, phoneProvider, phoneEnrichmentStatus }) +
    altPhoneLine(leadPhone, leadPhoneAlt) +
    linkedinUrlLine(leadLinkedinUrl) +
    websiteUrlLine(normalizeWebsiteUrl(leadWebsite) || websiteFromLeadEmail(leadEmail)) +
    locationLine(leadLocation, leadTimezone) +
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
function ccAutoNoticeBlock({ ccEmails, ccRoundRobinEmails, clientName, replyAllCc }) {
  const always = String(ccEmails || '').trim();
  const rr = String(ccRoundRobinEmails || '').trim();
  const extra = (Array.isArray(replyAllCc) ? replyAllCc : String(replyAllCc || '').split(/[,;]+/))
    .map((e) => String(e || '').trim())
    .filter(Boolean);
  if (!always && !rr && !extra.length) return null;
  if (!always && !rr) {
    return {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `📬 Reply-all: CC ${extra.length} other ${extra.length === 1 ? 'person' : 'people'} on the thread: ${escMrkdwn(extra.join(', '))}`,
      }],
    };
  }
  const lines = [];
  if (always) {
    lines.push(isDeepRootsClient(clientName)
      ? `*Tyler notify (qualified + wants a call only):* ${escMrkdwn(always)}`
      : `*Always notify:* ${escMrkdwn(always)}`);
  }
  if (rr) lines.push(`*Round-robin (1 per send):* ${escMrkdwn(rr)}`);
  const intro = isDeepRootsClient(clientName)
    ? '📬 Tyler is emailed only when they look qualified (employees + $1–10M EBITDA) and want to schedule a call — not on every send'
    : extra.length
      ? `📬 Reply-all: CC ${extra.length} other ${extra.length === 1 ? 'person' : 'people'} on the thread (${escMrkdwn(extra.join(', '))}) — primary Gmail notify on Approve`
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

const LAST_THREAD_DISPLAY_MAX = 800;
const SLACK_BLOCK_LIMIT = 50;

/**
 * Latest turn on the thread — quoted email history stripped so the card
 * shows the actual last message, not the whole back-and-forth.
 */
function isPlaceholderInbound(text) {
  const s = String(text || '').trim().toLowerCase();
  return !s
    || s.startsWith('(no new reply')
    || s.includes('follow-up re-attempt');
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

function buildWillSendBlocks({
  draft,
  outgoingLabel = 'WILL SEND',
  outgoingBody = null,
}) {
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

function loopInClientBlock(needsClient, whatToSend) {
  if (!needsClient) return null;
  const what = String(whatToSend || 'info').replace(/\s+/g, ' ').trim() || 'info';
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*LOOP IN CLIENT:* ${escMrkdwn(what)}` },
  };
}

function sendCcClientActionsBlock(replyId) {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '📬 Approve & Send + CC client' },
        style: 'primary',
        action_id: 'approve_reply_cc_client',
        value: replyId,
      },
    ],
  };
}

function followUpThreadTurnBlocks(turn) {
  const emoji = turn.role === 'us' ? '📤' : '📥';
  return conversationStepBlocks({
    emoji,
    label: turn.label,
    body: turn.display,
    neverTruncate: true,
  });
}

/**
 * Oldest → newest thread for the FOLLOW_UP card. Returns card blocks plus
 * overflow turns (full cleaned history) when the 50-block budget is hit.
 */
function buildFollowUpThreadBlocks(threadMessages, { maxBlocks = 28 } = {}) {
  const turns = prepareFollowUpThreadTurns(threadMessages);
  const blocks = [];
  let fitted = 0;
  for (const turn of turns) {
    const piece = followUpThreadTurnBlocks(turn);
    if (blocks.length + piece.length > maxBlocks) break;
    blocks.push(...piece);
    fitted += 1;
  }
  const overflow = fitted < turns.length ? turns : [];
  return { blocks, overflow, turns };
}

/**
 * FOLLOW_UP layout: WILL SEND (full text), optional LOOP IN CLIENT, then
 * the full thread oldest → newest (signatures stripped; older turns ~400
 * chars; last two in full).
 */
function buildFollowUpConversationBlocks({
  lastOutboundMessage,
  inboundMessage,
  draft,
  threadMessages = null,
  outgoingLabel = 'WILL SEND',
  outgoingBody = null,
  needsClient = false,
  whatToSend = null,
  maxThreadBlocks = 28,
} = {}) {
  void lastOutboundMessage;
  void inboundMessage;
  const blocks = [];
  blocks.push(...buildWillSendBlocks({ draft, outgoingLabel, outgoingBody }));
  const loop = loopInClientBlock(needsClient, whatToSend);
  if (loop) {
    if (blocks.length) blocks.push(dividerBlock());
    blocks.push(loop);
  }
  const { blocks: thread, overflow } = buildFollowUpThreadBlocks(threadMessages, {
    maxBlocks: maxThreadBlocks,
  });
  if (thread.length) {
    if (blocks.length) blocks.push(dividerBlock());
    blocks.push(...thread);
  }
  blocks.overflowThread = overflow;
  return blocks;
}

function buildConversationBlocks({
  lastOutboundMessage,
  inboundMessage,
  draft,
  priorLabel,
  inboundLabel,
  /** FOLLOW_UP cards: WILL SEND + full thread. */
  followUpContext = false,
  /** Full back-and-forth when available: [{ role: 'us'|'them', body }]. */
  threadMessages = null,
  outgoingLabel,
  needsClient = false,
  whatToSend = null,
}) {
  if (followUpContext) {
    return buildFollowUpConversationBlocks({
      lastOutboundMessage,
      inboundMessage,
      draft,
      threadMessages,
      outgoingLabel,
      needsClient,
      whatToSend,
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
        text: { type: 'plain_text', text: '❌ Reject' },
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
  leadFullName, leadPhoneAlt, leadLocation, leadTimezone,
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
  needsClient = false,
  whatToSend = null,
}) {
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';
  // Keep the enriched cellphone + LinkedIn + website on the Lead line after
  // Approve/Reject/DQ — they used to vanish when the card flipped to confirmation.
  const leadLine = leadFieldText({
    leadName, leadEmail, leadPhone, phoneProvider, phoneEnrichmentStatus,
    leadLinkedinUrl, leadWebsite, enrichmentReceipt, leadIcpVerdict,
    leadFullName, leadPhoneAlt, leadLocation, leadTimezone,
  });
  const isFollowUp = String(classification || '').toUpperCase() === 'FOLLOW_UP';

  const headers = {
    approved: '✅ SENT — Approved & sent',
    edited: '✏️ SENT — Edited & sent',
    rejected: '❌ Rejected — not interested',
    skipped: '⏭️ Skipped — next follow-up still scheduled',
    disqualified: '🚫 DQ — no follow-ups',
    meeting_booked: '📅 Meeting booked — follow-ups stopped',
    failed: '⚠️ Send failed',
  };
  const footers = {
    approved: 'Approved & sent',
    edited: 'Edited & sent',
    rejected: 'Rejected · marked not interested',
    skipped: 'Skipped · next follow-up still scheduled',
    disqualified: 'Disqualified · excluded from follow-up nudges',
    meeting_booked: 'Meeting booked · follow-up sequence cancelled',
    failed: 'Send failed',
  };
  // Reject on a follow-up card skips that one send. It does not mean the
  // lead is not interested, and the next cadence step still posts.
  const kind = (isFollowUp && actionKind === 'rejected')
    ? 'skipped'
    : (headers[actionKind] ? actionKind : 'approved');

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
      ? buildFollowUpConversationBlocks({
          lastOutboundMessage,
          inboundMessage,
          draft: (sentReply && String(sentReply).trim()
            && kind !== 'rejected' && kind !== 'disqualified' && kind !== 'meeting_booked')
            ? sentReply
            : null,
          threadMessages,
          outgoingLabel: 'Sent to prospect',
          needsClient,
          whatToSend,
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

  return blocks;
}

async function updateSentConfirmationCard(token, channelId, messageTs, opts) {
  const slack = getClient(token);
  const blocks = buildSentConfirmationBlocks(opts);
  const preview = plainTextForSlack(opts.sentReply || opts.inboundMessage).slice(0, 120);
  const lead = opts.leadName || 'prospect';
  const followUpSkip = opts.actionKind === 'skipped'
    || (String(opts.classification || '').toUpperCase() === 'FOLLOW_UP' && opts.actionKind === 'rejected');
  const textPrefix = followUpSkip
    ? 'Skipped — next follow-up still scheduled'
    : opts.actionKind === 'rejected'
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

function followUpClientContactEmail({ ccEmails, ccEmail } = {}) {
  const raw = String(ccEmails || ccEmail || '');
  for (const part of raw.split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase();
    if (email.includes('@')) return email;
  }
  return '';
}

/** SmartLead draft cards: CC option whenever Always-forward exists. */
function shouldShowCcClientButton({ platform, ccEmails, ccEmail, showCcClientButton } = {}) {
  if (String(platform || '').toLowerCase() !== 'smartlead') return false;
  if (followUpClientContactEmail({ ccEmails, ccEmail })) return true;
  return Boolean(showCcClientButton);
}

function assembleFollowUpApprovalBlocks({
  replyId,
  metaBlocks,
  draft,
  threadMessages,
  needsClient,
  whatToSend,
  canCcClient,
  contextText,
  review,
}) {
  const willSend = buildWillSendBlocks({ draft, outgoingLabel: 'WILL SEND' });
  const loop = loopInClientBlock(needsClient, whatToSend);
  const head = [
    ...metaBlocks,
    dividerBlock(),
    ...willSend,
    draftApprovalActionsBlock(replyId),
  ];
  if (canCcClient) {
    head.push(sendCcClientActionsBlock(replyId));
  }
  if (loop) head.push(loop);

  const tail = [];
  if (review) {
    tail.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '⚠️ *needs review* — draft stated a fact that was not in the provided context. Do not send until checked.',
      }],
    });
  }
  tail.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: contextText }],
  });

  const remaining = Math.max(4, SLACK_BLOCK_LIMIT - head.length - tail.length - 1);
  const { blocks: thread, overflow } = buildFollowUpThreadBlocks(threadMessages, {
    maxBlocks: remaining,
  });
  const blocks = [...head];
  if (thread.length) {
    blocks.push(dividerBlock(), ...thread);
  }
  blocks.push(...tail);
  if (blocks.length > SLACK_BLOCK_LIMIT) {
    blocks.length = SLACK_BLOCK_LIMIT;
  }
  return { blocks, overflowThread: overflow };
}

function buildDraftApprovalCard({
  replyId, leadName, leadEmail, platform, classification, draft, reasoning, inboundMessage,
  campaignDisplay, lastOutboundMessage, contextLabel, inThread, ccEmail,
  ccEmails, ccRoundRobinEmails, leadPhone, phoneProvider, phoneEnrichmentStatus,
  threadPermalink, threadMessages, leadLinkedinUrl, leadWebsite, clientName, enrichmentReceipt,
  leadIcpVerdict, needsReview, needsClient = false, whatToSend = null,
  replyAllCc = null, showCcClientButton = false,
  leadFullName, leadPhoneAlt, leadLocation, leadTimezone,
}) {
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';
  const leadLine = leadFieldText({
    leadName, leadEmail, leadPhone, phoneProvider, phoneEnrichmentStatus,
    leadLinkedinUrl, leadWebsite, enrichmentReceipt, leadIcpVerdict,
    leadFullName, leadPhoneAlt, leadLocation, leadTimezone,
  });
  const isFollowUp = String(classification || '').toUpperCase() === 'FOLLOW_UP';
  const review = needsReview === true
    || /needs review/i.test(String(reasoning || ''));
  const headerText = inThread
    ? `↩️ ${platform.toUpperCase()} — ${classification}${review ? ' · needs review' : ''}`
    : `📩 ${platform.toUpperCase()} — ${classification}${review ? ' · needs review' : ''}`;

  let contextText = `_${escMrkdwn(classification)}${reasoning ? ` · ${escMrkdwn(reasoning)}` : ''}_`;
  if (threadPermalink) {
    const permalinkLabel = isFollowUp ? 'Original thread' : 'Earlier card';
    contextText += ` · <${threadPermalink}|${permalinkLabel}>`;
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

  let overflowThread = [];
  let blocks;
  if (isFollowUp) {
    const assembled = assembleFollowUpApprovalBlocks({
      replyId,
      metaBlocks,
      draft,
      threadMessages,
      needsClient,
      whatToSend,
      canCcClient: shouldShowCcClientButton({
        platform, ccEmails, ccEmail, showCcClientButton,
      }),
      contextText,
      review,
    });
    blocks = assembled.blocks;
    overflowThread = assembled.overflowThread || [];
  } else {
    const conversation = buildConversationBlocks({
      lastOutboundMessage,
      inboundMessage,
      draft,
      priorLabel: contextLabel || 'You sent',
      inboundLabel: 'They replied',
    });
    blocks = [
      ...metaBlocks,
      dividerBlock(),
      ...conversation,
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: contextText }],
      },
    ];
    if (review) {
      blocks.splice(blocks.length, 0, {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '⚠️ *needs review* — draft stated a fact that was not in the provided context. Do not send until checked.' }],
      });
    }
    const notice = platform === 'smartlead'
      ? ccAutoNoticeBlock({
          ccEmails: ccEmails || ccEmail,
          ccRoundRobinEmails,
          clientName,
          replyAllCc,
        })
      : null;
    if (notice) blocks.push(notice);
    blocks.push(draftApprovalActionsBlock(replyId));
    if (shouldShowCcClientButton({ platform, ccEmails, ccEmail, showCcClientButton })) {
      blocks.push(sendCcClientActionsBlock(replyId));
    }
  }

  const preview = plainTextForSlack(draft || inboundMessage).slice(0, 120);
  const text = `New ${platform} reply from ${leadName} — ${classification}${preview ? `: ${preview}` : ''}`;
  return { blocks, text, overflowThread };
}

function followUpHistoryOverflowBlocks(overflowTurns) {
  const turns = Array.isArray(overflowTurns) ? overflowTurns : [];
  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: '*Full thread*' },
  }];
  for (const turn of turns) {
    const emoji = turn.role === 'us' ? '📤' : '📥';
    blocks.push(...conversationStepBlocks({
      emoji,
      label: turn.label,
      body: turn.body || turn.display,
      neverTruncate: true,
    }));
  }
  return blocks;
}

async function postFollowUpHistoryThread(token, channelId, threadTs, overflowTurns) {
  if (!token || !channelId || !threadTs) return null;
  const turns = Array.isArray(overflowTurns) ? overflowTurns : [];
  if (!turns.length) return null;
  const slack = getClient(token);
  const all = followUpHistoryOverflowBlocks(turns);
  const chunks = [];
  const budget = SLACK_BLOCK_LIMIT - 1;
  let cur = [];
  for (const block of all) {
    if (cur.length >= budget) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(block);
  }
  if (cur.length) chunks.push(cur);
  let last = null;
  for (const blocks of chunks) {
    last = await slack.chat.postMessage({
      channel: channelId,
      thread_ts: String(threadTs),
      text: 'Full thread',
      blocks,
    });
  }
  return last;
}

async function postDraftApproval(token, channelId, opts) {
  const slack = getClient(token);
  const { blocks, text, overflowThread } = buildDraftApprovalCard(opts);
  const result = await slack.chat.postMessage({
    channel: channelId,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    text,
    blocks,
  });
  if (overflowThread && overflowThread.length && result?.ts) {
    try {
      await postFollowUpHistoryThread(token, channelId, result.ts, overflowThread);
    } catch (err) {
      console.warn('[Slack] Follow-up thread overflow post failed', { err: err.message });
    }
  }
  return result;
}

/** Rewrite an already-posted approval card in place (compact FOLLOW_UP layout). */
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
  leadFullName, leadPhoneAlt, leadLocation, leadTimezone,
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
              leadFullName, leadPhoneAlt, leadLocation, leadTimezone,
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

function pitchHiddenSummaryText(n) {
  const count = Number(n) || 0;
  return `${count} pitch${count === 1 ? '' : 'es'} hidden today`;
}

/** One-line daily notice when at least one cold inbound pitch was suppressed. */
async function postPitchHiddenSummary(token, channelId, n) {
  const slack = getClient(token);
  const text = pitchHiddenSummaryText(n);
  return slack.chat.postMessage({
    channel: channelId,
    text,
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
  bestFullName,
  locationLine,
  websiteFromLeadEmail,
  icpVerdictLine,
  linkedinUrlLine,
  websiteUrlLine,
  normalizeLinkedinUrl,
  normalizeWebsiteUrl,
  postAlert,
  updateAlertCard,
  buildAlertCard,
  postError,
  pitchHiddenSummaryText,
  postPitchHiddenSummary,
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
  buildWillSendBlocks,
  loopInClientBlock,
  sendCcClientActionsBlock,
  postFollowUpHistoryThread,
  followUpClientContactEmail,
  shouldShowCcClientButton,
};
