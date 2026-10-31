const { WebClient } = require('@slack/web-api');
const { heyreachCanApprove } = require('./heyreach-card-gate');
const { cleanInboundReply, stripOutlookCss } = require('../utils/smartlead-webhook-helpers');
const { referralCcButtonText } = require('../utils/referred-contact');
const { decodeHtmlEntities: decodeAllHtmlEntities } = require('../utils/html-entities');
const { isDeepRootsClient } = require('../utils/meeting-modality');
const { prepareFollowUpThreadTurns } = require('../utils/follow-up-thread-display');

// Cache WebClient instances per token
const clientCache = new Map();

/** Slack section block text field max is 3000 chars. Chunk under that; never slice prospect text away. */
const SLACK_SECTION_MAX = 2900;
const SLACK_TEXT_HARD_MAX = 3000;

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
  // No phone on file: the reason line comes from phoneMissingLine (Josh, Oct 27).
  void phoneEnrichmentStatus;
  return '';
}

/**
 * No phone on the card: one short line saying why (Josh, Oct 27 2026), so a
 * FullEnrich miss reads differently from out of credits. Empty when we have a
 * phone or an alt number, or when no reason is known yet (card still posting).
 */
function phoneMissingLine({
  leadPhone, leadPhoneAlt, phoneEnrichmentStatus, enrichmentReceipt,
} = {}) {
  if (String(leadPhone || '').trim() || String(leadPhoneAlt || '').trim()) return '';
  const { phoneMissingText } = require('../utils/phone-lookup-reason');
  const text = phoneMissingText(enrichmentReceipt?.phoneLookup, phoneEnrichmentStatus);
  return text ? `\n${escMrkdwn(text)}` : '';
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
  if (v && v.status === 'unknown' && /^no ICP$/i.test(String(v.reason || '').trim())) {
    // Josh, Oct 29 2026: no ICP from the client's onboarding call means "not on file", never a score.
    return `\n🎯 ICP: not on file${dmLine}`;
  }
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
  skipIcp = false,
} = {}) {
  const name = bestFullName(leadName, leadFullName);
  return (
    `*${escMrkdwn(name || 'Unknown')}*` +
    `${leadEmail ? ` · ${escMrkdwn(leadEmail)}` : ''}` +
    phoneEnrichmentLine({ leadPhone, phoneProvider, phoneEnrichmentStatus }) +
    altPhoneLine(leadPhone, leadPhoneAlt) +
    phoneMissingLine({ leadPhone, leadPhoneAlt, phoneEnrichmentStatus, enrichmentReceipt }) +
    linkedinUrlLine(leadLinkedinUrl) +
    websiteUrlLine(normalizeWebsiteUrl(leadWebsite) || websiteFromLeadEmail(leadEmail)) +
    locationLine(leadLocation, leadTimezone) +
    (skipIcp ? '' : icpVerdictLine(leadIcpVerdict)) +
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

/** True while client notifications go out as the 4:00pm CT roll-up (PROSPECT_REPLY_NOTIFY_MODE, default rollup). */
function notifyModeIsRollup(env = process.env) {
  const v = String(env.PROSPECT_REPLY_NOTIFY_MODE || '').trim().toLowerCase();
  return v !== 'instant' && v !== 'off';
}

/** Client-notify notice. ccEmails here is notify_emails (the roll-up list), not portal CC. */
function ccAutoNoticeBlock({ ccEmails, clientName, replyAllCc }) {
  const always = String(ccEmails || '').trim();
  const extra = (Array.isArray(replyAllCc) ? replyAllCc : String(replyAllCc || '').split(/[,;]+/))
    .map((e) => String(e || '').trim())
    .filter(Boolean);
  if (!always && !extra.length) return null;
  if (!always) {
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
      : `*Client notifications:* ${escMrkdwn(always)}`);
  }
  const rollup = notifyModeIsRollup();
  const intro = isDeepRootsClient(clientName)
    ? '📬 Tyler is emailed only when they look qualified (employees + $1–10M EBITDA) and want to schedule a call — not on every send'
    : extra.length
      ? `📬 Reply-all: CC ${extra.length} other ${extra.length === 1 ? 'person' : 'people'} on the thread (${escMrkdwn(extra.join(', '))}) — ${rollup ? 'client gets the 4:00 PM CT roll-up' : 'primary Gmail notify on Approve'}`
      : rollup
        ? '📬 Prospect reply has no CC — the client gets the 4:00 PM CT roll-up (use "Send + CC client" to copy them on this reply)'
        : '📬 Prospect reply has no CC — primary Gmail notify on Approve (thread + LinkedIn/website/email/cell)';
  return {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `${intro}\n${lines.join('\n')}`,
    }],
  };
}

function sectionMrkdwn(emoji, label, chunk, isFirst) {
  const quoted = insetQuote(chunk);
  return isFirst ? `${emoji} *${label}*\n${quoted}` : quoted;
}

/**
 * Largest prefix of `rest` whose rendered section stays within Slack's
 * 3000-char text limit. Breaks on a newline or space the way chunkForSlack does.
 */
function takeFittingPrefix(rest, render) {
  if (render(rest).length <= SLACK_TEXT_HARD_MAX) return rest;
  let lo = 1;
  let hi = rest.length - 1;
  let best = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (render(rest.slice(0, mid)).length <= SLACK_TEXT_HARD_MAX) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const preferred = chunkForSlack(rest, best)[0] || '';
  if (
    preferred
    && rest.startsWith(preferred)
    && render(preferred).length <= SLACK_TEXT_HARD_MAX
  ) {
    return preferred;
  }
  let cut = best;
  const window = rest.slice(0, best);
  const nl = window.lastIndexOf('\n');
  const sp = window.lastIndexOf(' ');
  if (nl >= Math.floor(best * 0.5)) cut = nl;
  else if (sp >= Math.floor(best * 0.5)) cut = sp;
  let piece = rest.slice(0, cut).trimEnd();
  if (!piece || render(piece).length > SLACK_TEXT_HARD_MAX) {
    piece = rest.slice(0, best).trimEnd();
  }
  while (piece.length > 1 && render(piece).length > SLACK_TEXT_HARD_MAX) {
    piece = piece.slice(0, -1).trimEnd();
  }
  return piece || rest.slice(0, 1);
}

/** Full plain text, split so every section block is under 3000 chars. */
function splitPlainForSections(plain, emoji, label) {
  const chunks = [];
  let rest = String(plain || '').trim();
  while (rest) {
    const isFirst = chunks.length === 0;
    const piece = takeFittingPrefix(rest, (chunk) => sectionMrkdwn(emoji, label, chunk, isFirst));
    chunks.push(piece);
    if (piece.length >= rest.length) break;
    rest = rest.slice(piece.length).trimStart();
  }
  return chunks;
}

/**
 * Build one or more section blocks for a conversation step.
 * Prospect and outbound text are shown in full, chunked under 3000 chars.
 * @param {object} opts
 * @param {string} opts.emoji - e.g. 📤
 * @param {string} opts.label - e.g. "You sent"
 * @param {string} opts.body - message text
 */
function conversationStepBlocks({ emoji, label, body }) {
  const plain = plainTextForSlack(body);
  if (!plain) {
    return [{
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji} *${label}*\n_(not available)_` },
    }];
  }

  const chunks = splitPlainForSections(plain, emoji, label);
  return chunks.map((chunk, i) => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: sectionMrkdwn(emoji, label, chunk, i === 0),
    },
  }));
}


/**
 * One message for the card body: HTML/quoted history/signature stripped, cut at a
 * word boundary near `max` chars. Josh, Oct 29 2026: he must never click into a
 * thread to understand the context before sending.
 */
function trimForCard(raw, { max = 600, ours = false } = {}) {
  let t = ours ? plainTextForSlack(raw) : cleanInboundReply(raw);
  if (!t) return '';
  t = String(t).replace(/\r\n/g, '\n');
  t = t.replace(/-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i, '');
  t = t.replace(/\n\s*On\s[^\n]{0,200}(?:\n[^\n]{0,120})?\bwrote:[\s\S]*$/i, '');
  t = t.replace(/^\s*On\s[^\n]{0,200}\bwrote:[\s\S]*$/i, '');
  t = t.replace(/\n\s*From:\s[^\n]+\n\s*(?:Sent|Date):[\s\S]*$/i, '');
  t = t.replace(/\n\s*On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s[^\n]*[\s\S]*$/i, '');
  t = t.replace(/\n\s*>[\s\S]*$/, '');
  t = t.replace(/\n\s*-- ?\n[\s\S]*$/, '');
  t = t.replace(/\n\s*Sent from my [\s\S]*$/i, '');
  t = t.replace(/\n\s*(?:Best|Thanks|Thank you|Regards|Best regards|Kind regards|Cheers|Sincerely|Talk soon),?\s*\n[\s\S]*$/i, '');
  t = t.trim();
  if (ours) {
    // A trailing "Name Company" line with no sentence punctuation is our signature.
    const parts = t.split(/\n\s*\n/);
    if (parts.length > 1) {
      const last = parts[parts.length - 1].trim();
      if (last.length <= 70 && !/[.?!:]/.test(last) && last.split(/\s+/).length <= 7) parts.pop();
    }
    t = parts.join('\n\n').trim();
  }
  t = t.replace(/\n\s*\n+/g, '\n').trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    t = `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
  }
  return t;
}

/** "🗣 You said": our last sent message, about 300 chars. Empty when we have none. */
function youSaidBlocks(lastOutbound) {
  const t = trimForCard(lastOutbound, { max: 300, ours: true });
  if (!t) return [];
  return conversationStepBlocks({ emoji: '🗣', label: 'You said', body: t });
}

/** "📥 They replied": their latest message, about 600 chars. */
function theyRepliedBlocks(inbound) {
  const t = trimForCard(inbound, { max: 600 });
  return conversationStepBlocks({ emoji: '📥', label: 'They replied', body: t || inbound });
}

const SLACK_BLOCK_LIMIT = 50;

/** Keep header and tail on the card. Extra body blocks go to a thread reply. */
function fitCardBlocks(head, body, tail) {
  const budget = SLACK_BLOCK_LIMIT - head.length - tail.length;
  if (budget >= body.length) {
    return { blocks: [...head, ...body, ...tail], overflowBlocks: [] };
  }
  if (budget <= 0) {
    return {
      blocks: [...head, ...tail].slice(0, SLACK_BLOCK_LIMIT),
      overflowBlocks: body,
    };
  }
  return {
    blocks: [...head, ...body.slice(0, budget), ...tail],
    overflowBlocks: body.slice(budget),
  };
}

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

function referredContactSection(contacts) {
  const list = (Array.isArray(contacts) ? contacts : []).filter((c) => c && c.email);
  if (!list.length) return null;
  const title = list.length === 1 ? 'Referred contact' : 'Referred contacts';
  const lines = list.map((c) => (c.name ? `${c.name} — ${c.email}` : c.email));
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${title}*\n${lines.map((line) => escMrkdwn(line)).join('\n')}` },
  };
}

function referralCcActionsBlock(replyId, contacts) {
  const label = referralCcButtonText(contacts);
  if (!label) return null;
  return {
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: label },
      action_id: 'approve_reply_cc_referral',
      value: String(replyId),
    }],
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
 * the thread oldest → newest (signatures stripped; prospect turns in full;
 * our older turns ~400 chars; last two in full).
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
    }),
  );

  blocks.push(dividerBlock());

  blocks.push(
    ...conversationStepBlocks({
      emoji: '📥',
      label: theirLabel,
      body: inboundMessage,
    }),
  );

  if (draft != null && String(draft).trim() !== '') {
    blocks.push(dividerBlock());
    blocks.push(
      ...conversationStepBlocks({
        emoji: '✍️',
        label: 'Suggested reply',
        body: draft,
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

function linkedinReplyButton(url) {
  const href = normalizeLinkedinUrl(url);
  if (!href) return null;
  return {
    type: 'button',
    text: { type: 'plain_text', text: 'Reply on LinkedIn' },
    url: href,
    action_id: 'reply_on_linkedin',
  };
}

/** DQ, Meeting booked, and a LinkedIn link. No Approve, Edit, or Reject. */
function heyreachLimitedActionsBlock(replyId, linkedinUrl) {
  const elements = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '🚫 DQ' },
      action_id: 'dq_prospect',
      value: String(replyId),
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: '📅 Meeting booked' },
      action_id: 'meeting_booked',
      value: String(replyId),
    },
  ];
  const link = linkedinReplyButton(linkedinUrl);
  if (link) elements.push(link);
  return { type: 'actions', elements };
}

/**
 * HeyReach hides Approve unless the row can actually send. Every other
 * platform keeps the full Approve / Edit / Reject row.
 */
function approvalActionsForCard(opts = {}) {
  if (String(opts.platform || '').toLowerCase() !== 'heyreach') return null;
  const explicit = opts.heyreachCanSend;
  const canSend = explicit === true || explicit === false
    ? explicit
    : heyreachCanApprove({
      replyId: opts.replyId,
      leadId: opts.leadId,
      conversationId: opts.conversationId,
      linkedInAccountId: opts.linkedInAccountId ?? opts.linkedinAccountId,
      hasApiKey: Boolean(opts.hasHeyreachApiKey || opts.heyreachApiKey),
    });
  if (canSend) return null;
  return heyreachLimitedActionsBlock(opts.replyId, opts.linkedinReplyUrl || opts.leadLinkedinUrl);
}

function replaceActionsWithStatus(blocks, statusText) {
  const kept = (Array.isArray(blocks) ? blocks : []).filter((block) => block && block.type !== 'actions');
  const line = String(statusText || '').trim();
  if (line) {
    kept.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: line.slice(0, 2900) }],
    });
  }
  return kept;
}

function buildSentConfirmationBlocks({
  replyId,
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
    // Closed by the booking bridge (or as a sibling of another card), not by a button click.
    meeting_booked_auto: '📅 Meeting booked — no action needed',
    failed: '⚠️ Send failed',
    superseded: 'Superseded by newer card',
  };
  const footers = {
    approved: 'Approved & sent',
    edited: 'Edited & sent',
    rejected: 'Rejected · marked not interested',
    skipped: 'Skipped · next follow-up still scheduled',
    disqualified: 'Disqualified · excluded from follow-up nudges',
    meeting_booked: 'Meeting booked · follow-up sequence cancelled',
    meeting_booked_auto: 'Meeting booked · no action needed',
    failed: 'Send failed — use Retry',
    superseded: 'Superseded by newer card',
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
            && kind !== 'rejected' && kind !== 'disqualified' && kind !== 'meeting_booked' && kind !== 'meeting_booked_auto')
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
      && kind !== 'rejected' && kind !== 'disqualified' && kind !== 'meeting_booked' && kind !== 'meeting_booked_auto') {
    blocks.push(dividerBlock());
    blocks.push(
      ...conversationStepBlocks({
        emoji: '📤',
        label: 'Sent to prospect',
        body: sentReply,
      })
    );
  }

  const userBit = userId ? ` by <@${userId}>` : '';
  let footerText = `_${escMrkdwn(classification || 'reply')}${footers[kind] ? ` · ${footers[kind]}` : ''}${userBit}_`;
  if (ccUsed) {
    const email = typeof ccUsed === 'object' ? ccUsed.email : ccUsed;
    const mode = typeof ccUsed === 'object' ? (ccUsed.mode || 'gmail') : 'gmail';
    const rr = typeof ccUsed === 'object' ? ccUsed.roundRobin : null;
    let line = mode === 'rollup'
      ? `Queued for the 4:00 PM CT client roll-up → ${escMrkdwn(email)}`
      : mode === 'gmail'
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

  if (kind === 'failed' && replyId) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Retry' },
        style: 'primary',
        action_id: 'retry_send',
        value: String(replyId),
      }],
    });
  }

  if (blocks.length > SLACK_BLOCK_LIMIT) {
    const tailCount = (kind === 'failed' && replyId) ? 2 : 1;
    const tail = blocks.slice(-tailCount);
    const headRoom = SLACK_BLOCK_LIMIT - tail.length;
    const overflowBlocks = blocks.slice(headRoom, blocks.length - tail.length);
    const fitted = [...blocks.slice(0, headRoom), ...tail];
    fitted.overflowBlocks = overflowBlocks;
    return fitted;
  }
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
      : opts.actionKind === 'superseded'
        ? 'Superseded by newer card'
        : opts.actionKind === 'failed'
          ? 'Send failed'
          : (opts.actionKind === 'meeting_booked' || opts.actionKind === 'meeting_booked_auto')
            ? (opts.actionKind === 'meeting_booked_auto' ? 'Meeting booked, no action needed' : 'Meeting booked')
            : 'Sent';
  const text = `${textPrefix} — ${lead}${preview ? `: ${preview}` : ''}`;

  const result = await slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks,
  });
  if (blocks.overflowBlocks && blocks.overflowBlocks.length) {
    try {
      await postBlockOverflowThread(token, channelId, messageTs, blocks.overflowBlocks);
    } catch (err) {
      console.warn('[Slack] Confirmation overflow post failed', { err: err.message });
    }
  }
  return result;
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

/**
 * Josh, Oct 29 2026: cards were bloated, repeated the contact details, and pushed the
 * buttons below the fold. New order on reply AND follow-up cards:
 *   1. one-line header: lead · title · company · client
 *   2. the action buttons
 *   3. contact details, once, on one line (phone, email, LinkedIn, website)
 *   4. the lead's message
 *   5. the draft
 *   6. one context line for everything secondary (type, campaign, ICP, location, spend)
 */

const PHONE_LABELS = {
  mobile: 'mobile',
  landline: 'landline',
  'landline or mobile': 'landline or mobile',
  voip: 'VoIP',
  'toll-free': 'toll-free',
  invalid: 'invalid number',
};

/** Label for a number we hold but cannot call a confirmed mobile. Veriphone result, else the fallback. */
function altPhoneLabel(enrichmentReceipt) {
  const raw = String(enrichmentReceipt?.phoneLabel || '').trim().toLowerCase();
  return PHONE_LABELS[raw] || 'not a confirmed mobile';
}

/** One line: phone (what kind), email, LinkedIn, website. Each shows once. */
function compactContactLine({
  leadEmail, leadPhone, leadPhoneAlt, phoneEnrichmentStatus, enrichmentReceipt,
  leadLinkedinUrl, leadWebsite,
} = {}) {
  const parts = [];
  const phone = String(leadPhone || '').trim();
  const alt = String(leadPhoneAlt || '').trim();
  if (phone) {
    parts.push(`📱 ${escMrkdwn(phone)} _(mobile)_`);
  } else if (alt) {
    parts.push(`☎️ ${escMrkdwn(alt)} _(${altPhoneLabel(enrichmentReceipt)})_`);
  } else {
    const { phoneMissingText } = require('../utils/phone-lookup-reason');
    const why = phoneMissingText(enrichmentReceipt?.phoneLookup, phoneEnrichmentStatus);
    parts.push(why ? `📵 ${escMrkdwn(why)}` : '📵 no phone');
  }
  const email = String(leadEmail || '').trim();
  if (email) parts.push(`✉️ ${escMrkdwn(email)}`);
  const li = normalizeLinkedinUrl(leadLinkedinUrl);
  parts.push(li ? `🔗 <${li}|LinkedIn>` : '🔗 no LinkedIn');
  const site = normalizeWebsiteUrl(leadWebsite) || websiteFromLeadEmail(leadEmail);
  if (site) {
    const label = site.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '').slice(0, 40);
    parts.push(`🌐 <${site}|${escMrkdwn(label)}>`);
  } else {
    parts.push('🌐 no website');
  }
  return { type: 'section', text: { type: 'mrkdwn', text: parts.join('  ·  ') } };
}

/** "Jane Doe · Owner · Acme Roofing · Client". One line, 150 chars max (Slack header limit). */
function cardHeaderBlock({ name, title, company, clientName }) {
  const text = [name || 'Unknown lead', title, company, clientName]
    .map((x) => String(x || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  return {
    type: 'header',
    text: { type: 'plain_text', text: text.length > 150 ? `${text.slice(0, 149)}…` : text },
  };
}

function oneLineText(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Everything secondary on a single context block. */
function secondaryContextBlock({
  platform, classification, review, reasoning, campaignDisplay, leadIcpVerdict, skipIcp,
  leadLocation, leadTimezone, enrichmentReceipt, threadPermalink, isFollowUp,
  lastOutboundMessage, extra = [],
} = {}) {
  const bits = [];
  bits.push(`*${escMrkdwn(String(platform || '').toUpperCase())} · ${escMrkdwn(classification)}${review ? ' · needs review' : ''}*`);
  if (reasoning) bits.push(escMrkdwn(oneLineText(reasoning, 140)));
  const camp = String(campaignDisplay || '').trim();
  if (camp && camp !== '—') bits.push(`📣 ${escMrkdwn(oneLineText(camp, 70))}`);
  if (!skipIcp) {
    const icp = icpVerdictLine(leadIcpVerdict).replace(/^\n/, '').replace(/\n/g, ' · ');
    if (icp) bits.push(icp);
  }
  const loc = locationLine(leadLocation, leadTimezone).replace(/^\n/, '');
  if (loc && !/not found$/.test(loc)) bits.push(loc);
  const receipt = enrichmentReceiptLine(enrichmentReceipt).replace(/^\n/, '');
  if (receipt) bits.push(receipt);
  for (const e of extra) if (e) bits.push(e);
  if (threadPermalink) bits.push(`<${threadPermalink}|${isFollowUp ? 'Original thread' : 'Earlier card'}>`);
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: bits.join('  ·  ').slice(0, 2900) }],
  };
}

function needsReviewBlock() {
  return {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '⚠️ *needs review* — draft stated a fact that was not in the provided context. Do not send until checked.',
    }],
  };
}

/** Thread history (oldest to newest) minus the latest prospect turn, which already sits above the draft. */
function threadWithoutLatestReply(threadMessages, latestReply) {
  const list = Array.isArray(threadMessages) ? [...threadMessages] : [];
  const probe = oneLineText(plainTextForSlack(latestReply), 60).toLowerCase();
  if (!probe) return list;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m && String(m.role || '').toLowerCase() === 'them') {
      const body = oneLineText(plainTextForSlack(m.body), 400).toLowerCase();
      if (body.includes(probe.slice(0, 40))) list.splice(i, 1);
      break;
    }
  }
  return list;
}

function assembleFollowUpApprovalBlocks({
  replyId,
  topBlocks,
  contactBlock,
  theirBlocks = [],
  draft,
  threadMessages,
  needsClient,
  whatToSend,
  canCcClient,
  contextBlock,
  review,
  actionsBlock = null,
}) {
  const willSend = buildWillSendBlocks({ draft, outgoingLabel: 'WILL SEND' });
  const loop = loopInClientBlock(needsClient, whatToSend);
  // Josh, Oct 29 2026: the buttons stay at the bottom, after the draft and the context line.
  const head = [...topBlocks];
  const buttons = [actionsBlock || draftApprovalActionsBlock(replyId)];
  if (canCcClient) {
    buttons.push(sendCcClientActionsBlock(replyId));
  }
  const afterButtons = [contactBlock, ...theirBlocks, ...(theirBlocks.length && willSend.length ? [dividerBlock()] : []), ...willSend];
  if (loop) afterButtons.push(loop);

  const tail = [];
  if (review) tail.push(needsReviewBlock());
  tail.push(contextBlock);
  tail.push(...buttons);

  const used = head.length + afterButtons.length + tail.length;
  const remaining = Math.max(4, SLACK_BLOCK_LIMIT - used - 1);
  const { blocks: thread, overflow } = buildFollowUpThreadBlocks(threadMessages, {
    maxBlocks: remaining,
  });
  const blocks = [...head, ...afterButtons];
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
  referredContacts = null,
  mention = null,
  followupContext = null,
  leadTitle = null, leadCompany = null, leadData = null, payload = null,
  leadId = null, conversationId = null, linkedInAccountId = null, linkedinAccountId = null,
  heyreachCanSend = null, linkedinReplyUrl = null, hasHeyreachApiKey = false, heyreachApiKey = null,
}) {
  void phoneProvider; void inThread; void contextLabel;
  const isFollowUp = String(classification || '').toUpperCase() === 'FOLLOW_UP';
  const review = needsReview === true
    || /needs review/i.test(String(reasoning || ''));

  const ctxLead = followupContext?.lead || {};
  let title = String(leadTitle || ctxLead.title || '').trim();
  if (!title) {
    try {
      title = require('./decision-maker').extractLeadTitle(leadData, payload) || '';
    } catch { title = ''; }
  }
  const company = String(leadCompany || ctxLead.company || '').trim();
  const name = bestFullName(leadName, leadFullName) || ctxLead.name || '';
  const client = String(clientName || followupContext?.clientName || '').trim();

  const topBlocks = [
    ...(mention ? [{ type: 'section', text: { type: 'mrkdwn', text: String(mention) } }] : []),
    cardHeaderBlock({ name, title, company, clientName: client }),
  ];
  const contactBlock = compactContactLine({
    leadEmail: leadEmail || ctxLead.email,
    leadPhone: leadPhone || ctxLead.phone,
    leadPhoneAlt,
    phoneEnrichmentStatus,
    enrichmentReceipt,
    leadLinkedinUrl,
    leadWebsite: leadWebsite || ctxLead.website,
  });

  const extra = [];
  if (followupContext) {
    if (followupContext.offer) extra.push(`🎁 ${escMrkdwn(oneLineText(followupContext.offer, 120))}`);
    if (followupContext.meeting) extra.push(`🗓️ ${escMrkdwn(followupContext.meeting.label)}: ${escMrkdwn(followupContext.meeting.text)}`);
    const l = followupContext.links || {};
    if (l.replyCard) extra.push(`<${l.replyCard}|Original reply card>`);
    if (l.smartlead) extra.push(`<${l.smartlead}|Smartlead thread>`);
  }
  const contextBlock = secondaryContextBlock({
    platform, classification, review, reasoning,
    campaignDisplay: campaignDisplay || followupContext?.campaign,
    leadIcpVerdict: followupContext ? (followupContext.icp || leadIcpVerdict) : leadIcpVerdict,
    leadLocation, leadTimezone, enrichmentReceipt, threadPermalink, isFollowUp,
    lastOutboundMessage, extra,
  });

  let overflowThread = [];
  let overflowBlocks = [];
  let blocks;
  if (isFollowUp) {
    const latestReply = (followupContext && followupContext.reply) || inboundMessage;
    const sentText = lastOutboundMessage || followupContext?.lastSent || '';
    const theirBlocks = [
      ...youSaidBlocks(sentText),
      ...(String(latestReply || '').trim() && !isPlaceholderInbound(latestReply)
        ? theyRepliedBlocks(latestReply)
        : []),
    ];
    const assembled = assembleFollowUpApprovalBlocks({
      replyId,
      topBlocks,
      contactBlock,
      theirBlocks,
      draft,
      threadMessages: [],
      needsClient,
      whatToSend,
      canCcClient: shouldShowCcClientButton({
        platform, ccEmails, ccEmail, showCcClientButton,
      }),
      contextBlock,
      review,
      actionsBlock: approvalActionsForCard({
        replyId, platform, leadId, conversationId, linkedInAccountId, linkedinAccountId,
        heyreachCanSend, linkedinReplyUrl, leadLinkedinUrl, hasHeyreachApiKey, heyreachApiKey,
      }) || draftApprovalActionsBlock(replyId),
    });
    blocks = assembled.blocks;
    overflowThread = assembled.overflowThread || [];
  } else {
    const body = [
      ...youSaidBlocks(lastOutboundMessage),
      ...theyRepliedBlocks(inboundMessage),
    ];
    if (draft != null && String(draft).trim() !== '') {
      body.push(dividerBlock());
      body.push(...conversationStepBlocks({ emoji: '✍️', label: 'Suggested reply', body: draft }));
    }
    const head = [...topBlocks, contactBlock];

    const tail = [];
    if (review) tail.push(needsReviewBlock());
    tail.push(contextBlock);
    const notice = platform === 'smartlead'
      ? ccAutoNoticeBlock({
          ccEmails: ccEmails || ccEmail,
          ccRoundRobinEmails,
          clientName,
          replyAllCc,
        })
      : null;
    if (notice) tail.push(notice);
    if (String(platform || '').toLowerCase() === 'smartlead') {
      const referred = referredContactSection(referredContacts);
      if (referred) tail.push(referred);
    }
    // Buttons last, after the draft and the context line.
    tail.push(approvalActionsForCard({
      replyId, platform, leadId, conversationId, linkedInAccountId, linkedinAccountId,
      heyreachCanSend, linkedinReplyUrl, leadLinkedinUrl, hasHeyreachApiKey, heyreachApiKey,
    }) || draftApprovalActionsBlock(replyId));
    if (String(platform || '').toLowerCase() === 'smartlead') {
      const referralBtn = referralCcActionsBlock(replyId, referredContacts);
      if (referralBtn) tail.push(referralBtn);
    }
    if (shouldShowCcClientButton({ platform, ccEmails, ccEmail, showCcClientButton })) {
      tail.push(sendCcClientActionsBlock(replyId));
    }
    const fitted = fitCardBlocks(head, body, tail);
    blocks = fitted.blocks;
    overflowBlocks = fitted.overflowBlocks;
  }

  const preview = plainTextForSlack(draft || inboundMessage).slice(0, 120);
  const text = `New ${platform} reply from ${leadName} — ${classification}${preview ? `: ${preview}` : ''}`;
  return { blocks, text, overflowThread, overflowBlocks };
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

async function postBlockOverflowThread(token, channelId, threadTs, blocks) {
  if (!token || !channelId || !threadTs) return null;
  const all = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (!all.length) return null;
  const slack = getClient(token);
  const queue = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Rest of the message*' },
    },
    ...all,
  ];
  let last = null;
  for (let i = 0; i < queue.length; i += SLACK_BLOCK_LIMIT) {
    const slice = queue.slice(i, i + SLACK_BLOCK_LIMIT);
    last = await slack.chat.postMessage({
      channel: channelId,
      thread_ts: String(threadTs),
      text: 'Rest of the message',
      blocks: slice,
    });
  }
  return last;
}

async function postDraftApproval(token, channelId, opts) {
  const slack = getClient(token);
  const { blocks, text, overflowThread, overflowBlocks } = buildDraftApprovalCard(opts);
  const result = await slack.chat.postMessage({
    channel: channelId,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    text,
    blocks,
  });
  if (result?.ts) {
    if (overflowThread && overflowThread.length) {
      try {
        await postFollowUpHistoryThread(token, channelId, result.ts, overflowThread);
      } catch (err) {
        console.warn('[Slack] Follow-up thread overflow post failed', { err: err.message });
      }
    }
    if (overflowBlocks && overflowBlocks.length) {
      try {
        await postBlockOverflowThread(token, channelId, result.ts, overflowBlocks);
      } catch (err) {
        console.warn('[Slack] Reply overflow post failed', { err: err.message });
      }
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
  linkedinReplyUrl,
}) {
  const campLine = (campaignDisplay && String(campaignDisplay).trim()) ? String(campaignDisplay).trim() : '—';
  const headerText = inThread
    ? `↩️ ${classification} — ${platform.toUpperCase()}`
    : `🔔 ${classification} — ${platform.toUpperCase()}`;

  const head = [
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
  ];
  const conversation = buildConversationBlocks({
    lastOutboundMessage,
    inboundMessage,
    draft: null,
    priorLabel: contextLabel || 'You sent',
  });
  const tail = [{
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `_${escMrkdwn(classification)}${reasoning ? ` · ${escMrkdwn(reasoning)}` : ''}_` },
      { type: 'mrkdwn', text: '_ℹ️ No draft — alert only_' },
    ],
  }];
  if (replyId) {
    tail.push({
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
    if (String(platform || '').toLowerCase() === 'heyreach') {
      const link = linkedinReplyButton(linkedinReplyUrl || leadLinkedinUrl);
      if (link) tail[tail.length - 1].elements.push(link);
    }
  }
  const fitted = fitCardBlocks(head, conversation, tail);

  return {
    blocks: fitted.blocks,
    overflowBlocks: fitted.overflowBlocks,
    text: `${(platform || '').toUpperCase()} alert: ${classification} from ${leadName}`,
  };
}

async function postAlert(token, channelId, opts) {
  const slack = getClient(token);
  const { blocks, text, overflowBlocks } = buildAlertCard(opts);
  const result = await slack.chat.postMessage({
    channel: channelId,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    text,
    blocks,
  });
  const threadTs = result?.ts || opts.threadTs;
  if (overflowBlocks && overflowBlocks.length && threadTs) {
    try {
      await postBlockOverflowThread(token, channelId, threadTs, overflowBlocks);
    } catch (err) {
      console.warn('[Slack] Alert overflow post failed', { err: err.message });
    }
  }
  return result;
}

async function updateAlertCard(token, channelId, messageTs, opts) {
  const slack = getClient(token);
  const { blocks, text, overflowBlocks } = buildAlertCard(opts);
  const result = await slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks,
  });
  if (overflowBlocks && overflowBlocks.length) {
    try {
      await postBlockOverflowThread(token, channelId, messageTs, overflowBlocks);
    } catch (err) {
      console.warn('[Slack] Alert overflow post failed', { err: err.message });
    }
  }
  return result;
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

/** chat.update that keeps the blocks it is given. Never sends an empty block list. */
async function updateMessageKeepingBlocks(token, channelId, messageTs, text, blocks) {
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (!token || !channelId || !messageTs || !list.length) return null;
  const slack = getClient(token);
  return slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text: String(text || '').slice(0, 3000),
    blocks: list.slice(0, SLACK_BLOCK_LIMIT),
  });
}

const CC_CLIENT_BLOCK_ID = 'cc_client_block';
const CC_CLIENT_ACTION_ID = 'cc_client_input';

/**
 * Optional "CC client on this reply" checkbox for the Edit modal. Same effect as the card's
 * "Approve & Send + CC client" button: the client's Always-CC list goes on the prospect thread.
 */
// Slack caps checkbox/option text at 75 characters; a longer label makes views.open fail
// with invalid_blocks and the Edit button looks dead.
const OPTION_TEXT_MAX = 75;
const CC_CLIENT_LABEL_PREFIX = 'CC client on this reply: ';

function ccClientOptionText(emails) {
  const list = String(emails || '').trim();
  const room = OPTION_TEXT_MAX - CC_CLIENT_LABEL_PREFIX.length;
  const label = list.length > room ? `${list.slice(0, room - 1)}…` : list;
  return `${CC_CLIENT_LABEL_PREFIX}${label}`;
}

function ccClientModalBlock({ ccClientEmails, ccOnSend } = {}) {
  const emails = String(ccClientEmails || '').trim();
  if (!emails) return null;
  const option = {
    text: { type: 'plain_text', text: ccClientOptionText(emails) },
    value: 'cc_client',
  };
  return {
    type: 'input',
    optional: true,
    block_id: CC_CLIENT_BLOCK_ID,
    label: { type: 'plain_text', text: 'Client copy' },
    element: {
      type: 'checkboxes',
      action_id: CC_CLIENT_ACTION_ID,
      options: [option],
      ...(ccOnSend ? { initial_options: [option] } : {}),
    },
  };
}

/** True when the Edit modal's "CC client" box is ticked. */
function ccClientSelectedInModal(values) {
  const sel = values?.[CC_CLIENT_BLOCK_ID]?.[CC_CLIENT_ACTION_ID]?.selected_options;
  return Array.isArray(sel) && sel.length > 0;
}

function buildEditReplyBlocks({ initialDraft, referralCc, ccClientEmails, ccOnSend } = {}) {
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
  const cc = String(referralCc || '').trim();
  if (cc) {
    blocks.push({
      type: 'input',
      optional: true,
      block_id: 'referral_cc_block',
      label: { type: 'plain_text', text: 'CC address — clear this to send with no CC' },
      element: {
        type: 'plain_text_input',
        action_id: 'referral_cc_input',
        initial_value: cc.slice(0, 2900),
      },
    });
  }
  const ccClient = ccClientModalBlock({ ccClientEmails, ccOnSend });
  if (ccClient) blocks.push(ccClient);
  return blocks;
}

async function openEditReplyModal(token, triggerId, {
  replyId, initialDraft, channelId, messageTs, ccEmail, ccOnSend, ccEmails, ccRoundRobinEmails,
  referralCc, ccClientEmails,
}) {
  const slack = getClient(token);
  const meta = JSON.stringify({ replyId, channelId, messageTs });

  const blocks = buildEditReplyBlocks({ initialDraft, referralCc, ccClientEmails, ccOnSend });

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
  getClient,
  escMrkdwn,
  plainTextForSlack,
  conversationStepBlocks,
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
  approvalActionsForCard,
  heyreachLimitedActionsBlock,
  linkedinReplyButton,
  replaceActionsWithStatus,
  updateMessageKeepingBlocks,
  openEditReplyModal,
  buildEditReplyBlocks,
  ccClientModalBlock,
  ccClientOptionText,
  ccClientSelectedInModal,
  notifyModeIsRollup,
  referralCcActionsBlock,
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
