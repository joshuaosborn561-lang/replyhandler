/**
 * Optional SmartLead webhook enrichment: non-reply event skip, inbound text from history,
 * dedupe of bad REPLY rows that mirror last SENT (SmartLead/Android glitches).
 */
const { decodeHtmlEntities } = require('./html-entities');
const { messageIdOfMessage } = require('./inbound-message-id');

/**
 * Outlook / Word HTML often leaves stylesheet text after tags are stripped
 * (`P {margin-top:0;margin-bottom:0;}` or `v\:* {behavior:url(#default#VML);}`).
 * That is not the prospect's message — drop it so FOLLOW_UP last-message
 * lines stay readable.
 */
function stripOutlookCss(s) {
  return String(s || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/(?:^|\s)(?:[a-z]{1,8}|[vow]\\?:\*|[#.][\w-]+)\s*\{[^}]{0,200}(?:margin|padding|behavior|font-size|color:|width:|height:|display:|url\()[^}]{0,200}\}/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtmlToText(s) {
  if (!s) return '';
  // Angle-bracket addresses look like tags to the stripper below. Unwrap them
  // first, or "From: Name <a@b.com>" loses its address and the quote-cut in
  // stripEmailQuotePrefix — which anchors on that address — stops matching.
  const stripped = String(s)
    .replace(/<([\w.+-]+@[\w.-]+\.[a-z]{2,})>/gi, '$1')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?(<\/style>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Keep block boundaries as newlines so quote/signature cutting still has anchors.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decoded = decodeHtmlEntities(stripped)
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripOutlookCss(decoded);
}

function normWs(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** First positive integer SmartLead lead id from webhook payload (prefer email_lead_id / sl_email_lead_id). */
function normalizeSmartleadLeadId(payload = {}, leadData = {}) {
  const candidates = [
    payload.email_lead_id,
    payload.emailLeadId,
    payload.sl_email_lead_id,
    payload.slEmailLeadId,
    payload.lead_id,
    payload.leadId,
    payload.lead?.id,
    leadData.email_lead_id,
    leadData.emailLeadId,
    leadData.lead_id,
    leadData.leadId,
    leadData.id,
    // sl_email_lead_map_id is a campaign-lead MAP id, not a lead id. Using it
    // broke message-history and thread context (Oct 20). Resolve by email instead.
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = Number(String(c).trim());
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return String(n);
  }
  return null;
}

/** Campaign id from SmartLead webhook / inbox row. */
function normalizeSmartleadCampaignId(payload = {}, leadData = {}) {
  const candidates = [
    payload.email_campaign_id,
    payload.emailCampaignId,
    payload.sl_campaign_id,
    payload.slCampaignId,
    payload.campaign_id,
    payload.campaignId,
    payload.campaign?.id,
    leadData.email_campaign_id,
    leadData.emailCampaignId,
    leadData.campaign_id,
    leadData.campaignId,
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = Number(String(c).trim());
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return String(n);
  }
  return null;
}

/**
 * Quote header: line-start "On … wrote:" and only when a date or an email
 * follows "On". A loose "On … wrote:" match was cutting real sentences
 * ("on our side the person who wrote:").
 *
 * Collapsed HTML is one line, so a header that also carries a year, a clock
 * time, or an email is broken onto its own line first. Weekday-only prose
 * in the middle of a sentence is left alone.
 */
const QUOTE_DAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs|thur|mon|tue|wed|thu|fri|sat|sun)';
const QUOTE_MONTH = '(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|may\\s+\\d{1,2})';
const QUOTE_DATE_OR_EMAIL = `(?:${QUOTE_DAY}|${QUOTE_MONTH}|\\d{1,4}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?|[\\w.+-]+@[\\w.-]+\\.[a-z]{2,})`;
const QUOTE_ON_WROTE_BODY = `On[ \\t]+[^\\n]{0,220}?${QUOTE_DATE_OR_EMAIL}[^\\n]{0,180}?wrote:`;
const QUOTE_ON_WROTE_LINE = new RegExp(`(?:^|\\n)[ \\t]*${QUOTE_ON_WROTE_BODY}`, 'i');
const QUOTE_ON_WROTE_COLLAPSED = new RegExp(
  `([^\\n])([ \\t]*On[ \\t]+[^\\n]{0,220}?(?:[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}|\\b\\d{4}\\b|\\b\\d{1,2}:\\d{2}\\b)[^\\n]{0,180}?wrote:)`,
  'i'
);

function stripEmailQuotePrefix(raw) {
  let t = String(raw || '').replace(/\r\n/g, '\n');
  t = t.replace(QUOTE_ON_WROTE_COLLAPSED, '$1\n$2');

  const cutAt = (re) => {
    const m = t.match(re);
    if (m && m.index > 0) t = t.slice(0, m.index);
  };

  cutAt(QUOTE_ON_WROTE_LINE);
  cutAt(/-----\s*Original Message\s*-----/i);
  cutAt(/_{20,}/);
  // Outlook-style quoted header. Requires an address right after so a sentence
  // containing "from:" is never mistaken for a quote boundary.
  cutAt(/\bFrom:\s+[^\n]{0,80}?<?[\w.+-]+@[\w.-]+/i);
  cutAt(/\bSent from my (iPhone|iPad|Android|Samsung)/i);

  return t.trim();
}

/**
 * Inline image refs only. The rest of a prospect's signature — title, phone,
 * booking link — is kept on purpose: it is useful context on the card.
 */
function stripEmailArtifacts(raw) {
  return String(raw || '')
    .replace(/\[cid:[^\]]+\]/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cleanup for a prospect reply: drop quoted thread history and image refs.
 * The prospect's own signature is deliberately left in — it carries their
 * title, phone and booking link.
 */
function looksLikeHtml(s) {
  return /<\/?[a-z!][^>]*>/i.test(String(s || ''));
}

function cleanInboundReply(raw) {
  let t = stripHtmlToText(raw);
  // Outlook sends some replies (auto-responses, "report phishing" clicks) as an
  // empty HTML shell: <html><body><div><br></div></body></html>. That strips to
  // "". Falling back to the raw markup made the tags the "reply" and then no
  // draft could be written. Real plain text still passes through untouched.
  if (!t && !looksLikeHtml(raw)) t = String(raw || '');
  t = stripEmailQuotePrefix(t);
  t = stripEmailArtifacts(t);
  return t.trim();
}

/**
 * cleanInboundReply, or the trimmed original when it is not markup. Markup that
 * strips to nothing is blank, never the tags themselves.
 */
function cleanInboundOrRaw(raw) {
  const cleaned = cleanInboundReply(raw);
  if (cleaned) return cleaned;
  return looksLikeHtml(raw) ? '' : String(raw || '').trim();
}

/**
 * True when a webhook payload includes a reply body and every copy of it
 * is an empty HTML shell (or whitespace). Missing fields are not blank:
 * a category event that simply omits the body must still be read from
 * history. A disclaimer or any other real sentence is not blank.
 */
function payloadInboundIsBlank(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const replyObj = payload.reply_message
    || payload.replyMessage
    || payload.reply
    || payload.latest_reply
    || payload.last_reply
    || null;
  const values = [];
  const push = (v) => {
    if (typeof v === 'string') values.push(v);
  };
  if (replyObj && typeof replyObj === 'object') {
    for (const key of ['text', 'body', 'html', 'email_body', 'preview_text', 'message', 'plain_text']) {
      push(replyObj[key]);
    }
  } else {
    push(replyObj);
  }
  for (const key of ['preview_text', 'reply_html', 'html', 'body_html', 'reply_body', 'reply_text', 'reply_message_body', 'body']) {
    push(payload[key]);
  }
  if (!values.length) return false;
  if (!values.every((v) => !cleanInboundOrRaw(v))) return false;
  return values.some((v) => looksLikeHtml(v));
}

function messageFromEmail(m) {
  const v = m && (m.from || m.From || m.sender || m.reply_from);
  return v ? String(v).trim().toLowerCase() : '';
}

function isLikelyDuplicateOfOutbound(prospectBody, outboundBody) {
  const a = normWs(prospectBody);
  const b = normWs(outboundBody);
  if (!a || !b) return false;
  if (a === b) return true;
  const prefixLen = Math.min(120, a.length, b.length);
  if (prefixLen >= 40 && a.slice(0, prefixLen) === b.slice(0, prefixLen)) return true;
  if (a.length >= 80 && b.includes(a.slice(0, 80))) return true;
  if (b.length >= 80 && a.includes(b.slice(0, 80))) return true;
  return false;
}

const SMARTLEAD_NON_REPLY_EVENTS = new Set([
  'EMAIL_SENT',
  'EMAIL_OPENED',
  'EMAIL_CLICKED',
  'EMAIL_BOUNCED',
  'EMAIL_UNSUBSCRIBED',
]);

function pickLatestInboundReply(histResponse, leadEmail) {
  if (!histResponse || typeof histResponse !== 'object') return { body: '', messageId: '' };
  const list = Array.isArray(histResponse.history)
    ? histResponse.history
    : Array.isArray(histResponse.messages)
      ? histResponse.messages
      : Array.isArray(histResponse)
        ? histResponse
        : [];
  const leadFrom = String(leadEmail || '').trim().toLowerCase();

  function collectRows(requireFromMatchLead) {
    const rows = [];
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const type = String(m.type || m.direction || '').toUpperCase();
      if (type !== 'REPLY' && type !== 'INBOUND') continue;
      const from = messageFromEmail(m);
      if (requireFromMatchLead && leadFrom && from && !from.includes(leadFrom) && leadFrom !== from) {
        continue;
      }
      const raw = fullestMessageText(m);
      const plain = cleanInboundReply(raw);
      if (!plain) continue;
      const time = String(m.time || m.sent_at || m.received_at || m.created_at || '');
      rows.push({
        time,
        body: plain,
        messageId: messageIdOfMessage(m),
        rawForDedupe: stripHtmlToText(raw) || String(raw || '').trim(),
      });
    }
    rows.sort((a, b) => a.time.localeCompare(b.time));
    return rows;
  }

  let lastSentBody = '';
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type === 'SENT' || type === 'OUTBOUND') {
      const raw = m.email_body || m.body || m.text || '';
      const p = stripHtmlToText(raw) || String(raw || '').trim();
      if (p) lastSentBody = p;
    }
  }

  const pickLatestNonDuplicate = (rows) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const { body, rawForDedupe, messageId } = rows[i];
      if (lastSentBody && isLikelyDuplicateOfOutbound(rawForDedupe || body, lastSentBody)) {
        continue;
      }
      return { body, messageId: messageId || '' };
    }
    return { body: '', messageId: '' };
  };

  const strictRows = collectRows(true);
  const strict = pickLatestNonDuplicate(strictRows);
  if (strict.body) return strict;
  const looseRows = collectRows(false);
  return pickLatestNonDuplicate(looseRows);
}

/**
 * Every prospect reply in a thread, newest first.
 *
 * A reply that carries its own Message-ID is kept even when the body quotes
 * our last send. SmartLead stores that quote on the new email, and dropping
 * it made the poller treat the thread as the older card. A row that reuses a
 * SENT message id, or a body with no id that is only our outbound, is not a
 * second email.
 */
function listInboundReplies(histResponse, leadEmail) {
  void leadEmail;
  if (!histResponse || typeof histResponse !== 'object') return [];
  const list = Array.isArray(histResponse.history)
    ? histResponse.history
    : Array.isArray(histResponse.messages)
      ? histResponse.messages
      : Array.isArray(histResponse)
        ? histResponse
        : [];
  const sentIds = new Set();
  let lastSentBody = '';
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type !== 'SENT' && type !== 'OUTBOUND') continue;
    const id = messageIdOfMessage(m);
    if (id) sentIds.add(id);
    const raw = m.email_body || m.body || m.text || '';
    const plain = stripHtmlToText(raw) || String(raw || '').trim();
    if (plain) lastSentBody = plain;
  }
  const rows = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type !== 'REPLY' && type !== 'INBOUND') continue;
    const messageId = messageIdOfMessage(m);
    if (messageId && sentIds.has(messageId)) continue;
    const raw = fullestMessageText(m);
    const body = cleanInboundReply(raw);
    if (!body) continue;
    const rawForDedupe = stripHtmlToText(raw) || String(raw || '').trim();
    if (!messageId && lastSentBody && isLikelyDuplicateOfOutbound(rawForDedupe || body, lastSentBody)) {
      continue;
    }
    rows.push({
      time: String(m.time || m.sent_at || m.received_at || m.created_at || ''),
      body,
      messageId: messageId || '',
    });
  }
  rows.sort((a, b) => b.time.localeCompare(a.time));
  return rows;
}

/**
 * True when the newest REPLY in a SmartLead history has no prospect text at
 * all (empty body or an empty HTML shell, no attachment text). Older replies
 * with real text do not count: the webhook is about the newest one, and
 * drafting against an older reply would answer the wrong email.
 */
function latestInboundReplyIsBlank(histResponse) {
  if (!histResponse || typeof histResponse !== 'object') return false;
  const list = Array.isArray(histResponse.history)
    ? histResponse.history
    : Array.isArray(histResponse.messages)
      ? histResponse.messages
      : Array.isArray(histResponse)
        ? histResponse
        : [];
  const replies = list.filter((m) => {
    if (!m || typeof m !== 'object') return false;
    const type = String(m.type || m.direction || '').toUpperCase();
    return type === 'REPLY' || type === 'INBOUND';
  });
  if (!replies.length) return false;
  replies.sort((a, b) => String(a.time || a.received_at || '').localeCompare(String(b.time || b.received_at || '')));
  const last = replies[replies.length - 1];
  return !cleanInboundReply(fullestMessageText(last));
}

function latestInboundFromSmartleadHistory(histResponse, leadEmail) {
  return latestInboundReplyMeta(histResponse, leadEmail).body;
}

function latestInboundReplyMeta(histResponse, leadEmail) {
  const picked = pickLatestInboundReply(histResponse, leadEmail);
  return { body: picked.body || '', messageId: picked.messageId || '' };
}

function lastOutboundBodyFromSmartleadHistory(histResponse) {
  if (!histResponse || typeof histResponse !== 'object') return '';
  const list = Array.isArray(histResponse.history)
    ? histResponse.history
    : Array.isArray(histResponse.messages)
      ? histResponse.messages
      : Array.isArray(histResponse)
        ? histResponse
        : [];
  let last = '';
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type === 'SENT' || type === 'OUTBOUND') {
      const raw = m.email_body || m.body || m.text || '';
      const p = stripHtmlToText(raw) || String(raw || '').trim();
      if (p) last = p;
    }
  }
  return last;
}

function looksLikeCss(s) {
  const t = String(s || '');
  return /@font-face|mso-|\{font-family|\bMsoNormal\b|<style/i.test(t.slice(0, 2000));
}

/**
 * Keep the longer copy when both sides are the same reply under the shared
 * inbound normalizer (the same rules dedupe uses). A different reply stays
 * `current`, so a new short message is not replaced by an older long one.
 */
function preferFullerInbound(current, candidate) {
  const cRaw = String(current || '').trim();
  const nRaw = String(candidate || '').trim();
  if (!nRaw) return cRaw;
  if (!cRaw) return nRaw;
  const { normalizeInboundText, sameNormalizedInbound } = require('../services/reply-dedupe');
  const c = normalizeInboundText(cRaw);
  const n = normalizeInboundText(nRaw);
  if (!n) return cRaw;
  if (!c) return nRaw;
  if (!sameNormalizedInbound(c, n)) return cRaw;
  return n.length > c.length ? nRaw : cRaw;
}

function plainField(value) {
  if (value == null) return '';
  const s = String(value).trim();
  if (!s || looksLikeCss(s)) return '';
  if (/<[a-z!/]/i.test(s)) return stripHtmlToText(s) || '';
  return s;
}

/**
 * Text fields keep their old priority. HTML replaces that text only when it
 * is the same reply and longer (a preview), not when it is a different body.
 */
function textThenHtml(obj, textFields) {
  if (!obj || typeof obj !== 'object') return '';
  let text = '';
  for (const field of textFields) {
    const plain = plainField(obj[field]);
    if (plain) { text = plain; break; }
  }
  const htmlRaw = stripHtmlToText(obj.html || obj.html_body || obj.body_html || obj.email_html || '');
  const html = htmlRaw && !looksLikeCss(htmlRaw) ? htmlRaw : '';
  if (!text) return html;
  if (!html) return text;
  return preferFullerInbound(text, html);
}

/** HTML-converted text wins over a short webhook `text` preview of the same reply. */
function fullestMessageText(m) {
  return textThenHtml(m, ['email_body', 'body', 'message', 'text', 'plain_text']);
}

function parseInboundFromPayload(replyObj, payload = {}) {
  const fromReply = replyObj && typeof replyObj === 'object'
    ? textThenHtml(replyObj, ['body', 'message', 'text', 'plain_text', 'email_body'])
    : plainField(replyObj);
  const fromPayload = textThenHtml({
    html: payload.reply_html || payload.html || payload.body_html || payload.reply_message_html,
    html_body: payload.reply_body_html,
    plain_text: payload.plain_text,
    body: payload.reply_message_body || payload.replyMessageBody || payload.last_reply_body || payload.lastReplyBody,
    message: payload.message,
    text: payload.reply_text || payload.replyText,
    email_body: payload.email_body,
  }, ['body', 'message', 'text', 'plain_text', 'email_body']);
  return preferFullerInbound(fromReply, fromPayload) || plainField(payload.body);
}

function envFlag(name, defaultTrue = true) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultTrue;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function smartleadWebhookEnhancementsEnabled() {
  const v = process.env.SMARTLEAD_WEBHOOK_ENHANCEMENTS;
  if (v === undefined || v === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function looksLikeOutOfOffice(text) {
  const s = normWs(text);
  if (!s) return false;
  // Common OOO / auto-reply phrases.
  if (/\bout of (the )?office\b/.test(s)) return true;
  if (/\bauto(?:matic)? reply\b/.test(s)) return true;
  if (/\bautoreply\b/.test(s)) return true;
  if (/\bon vacation\b/.test(s)) return true;
  if (/\breturn on\b/.test(s) && /\blimited access\b/.test(s)) return true;
  if (/\b(i will have|with|have|has) limited access to (my )?(email|inbox|messages)\b/.test(s)) return true;
  if (/\blimited email access\b/.test(s)) return true;
  if (/\bi am currently out of (the )?office\b/.test(s)) return true;
  if (/\bwill be returning\b/.test(s)) return true;
  if (/\bthank you for your (email|message)\b/.test(s) && /\bwill (respond|get back)\b/.test(s) && /\breturn\b/.test(s)) return true;
  return false;
}

/**
 * Legal disclaimers and security-gateway footers. A reply that is only these
 * has no human text. A real reply that also carries the footer keeps the
 * human sentences.
 */
const DISCLAIMER_MARKS = [
  /the information contained in this (?:e-?mail|email|communication|message)/i,
  /intended solely for/i,
  /intended only for the (?:use|recipient|individual|entity)/i,
  /if you are not the (?:intended )?recipient/i,
  /if you have received this (?:e-?mail|email|communication|message) in error/i,
  /disclosure,\s*copying,\s*distribution/i,
  /privileged and confidential/i,
  /this (?:e-?mail|email|message) and any (?:files|attachments)/i,
  /confidentiality notice/i,
  /unauthorized (?:review|use|disclosure)/i,
];

const BOILERPLATE_CRUMB = /\b(mimecast|proofpoint|barracuda|ironport|fortimail|sophos|avanan|disclaimer|confidential|recipient|malware|viruses|originated from outside|external sender|email security|cyber resilience)\b/i;

function disclaimerScore(text) {
  const s = String(text || '');
  return DISCLAIMER_MARKS.reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
}

function isDisclaimerText(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (/^disclaimer\s*:?\s*$/i.test(s)) return true;
  return disclaimerScore(s) >= 2;
}

function isScannerText(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (/\bscanned for (?:viruses|malware|spam|threats)\b/i.test(s)) return true;
  if (/\bthis (?:e-?mail|email|message) has been (?:scanned|checked) for\b/i.test(s)) return true;
  if (/\bmimecast\b/i.test(s) && /\b(?:scanned|archived|malware|email security|cyber|virus)\b/i.test(s)) return true;
  if (/\bproofpoint\b/i.test(s) && /\b(?:scanned|protected|encryption|security|virus|spam)\b/i.test(s)) return true;
  if (/\bbarracuda\b/i.test(s) && /\b(?:scanned|email security|spam|virus|networks|sentinel)\b/i.test(s)) return true;
  if (/\b(?:cisco\s+ironport|ironport|fortimail|sophos|avanan|abnormal security)\b/i.test(s) && /\b(?:scanned|security|protected|spam|virus)\b/i.test(s)) return true;
  if (/\bthis (?:message|e-?mail|email) is from an external sender\b/i.test(s)) return true;
  if (/\byou don'?t often get email from\b/i.test(s)) return true;
  if (/\boriginated from outside\b/i.test(s)) return true;
  if (/\bdo not click links or open attachments\b/i.test(s)) return true;
  if (/^\[?\s*external\s*\]?$/i.test(s)) return true;
  return false;
}

function isBoilerplateText(text) {
  return isDisclaimerText(text) || isScannerText(text);
}

function looksLikeHumanSentence(sentence) {
  return /\b(i|we|i'm|let's|please|can you|could you|would you|want|yes|yeah|yep|ok|okay|sure|thanks|thank you|sounds good|let me|what|when|where|how|who)\b/i.test(sentence);
}

function sentenceIsBoilerplate(sentence, paragraph) {
  const s = String(sentence || '').trim();
  if (!s) return true;
  if (/^disclaimer\b/i.test(s)) return true;
  if (isScannerText(s)) return true;
  if (disclaimerScore(s) >= 1 && !looksLikeHumanSentence(s)) return true;
  if (disclaimerScore(s) >= 1 && disclaimerScore(paragraph) >= 2 && !looksLikeHumanSentence(s)) return true;
  if (/\blearn why this is important\b/i.test(s)) return true;
  if (/\bunless you recogni[sz]e the sender\b/i.test(s)) return true;
  return false;
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripBoilerplateChunk(chunk) {
  const c = String(chunk || '').trim();
  if (!c) return '';
  const sentences = splitSentences(c);
  const units = sentences.length ? sentences : [c];
  let kept = units.filter((s) => !sentenceIsBoilerplate(s, c));
  if (isBoilerplateText(c)) {
    kept = kept.filter((s) => looksLikeHumanSentence(s) && !sentenceIsBoilerplate(s, c));
  }
  if (kept.length === units.length && !isBoilerplateText(c)) return c;
  return kept.join(' ').trim();
}

function plainForBoilerplate(raw) {
  let t = stripHtmlToText(raw);
  if (!t && !looksLikeHtml(raw)) t = String(raw || '');
  t = stripEmailQuotePrefix(t);
  return String(t || '').trim();
}

/** Drop disclaimer / scanner footer text. Human sentences stay. */
function removeSecurityBoilerplate(plain) {
  const trimmed = String(plain || '').trim();
  if (!trimmed) return '';
  const paragraphs = trimmed.split(/\n{2,}/);
  const keptParas = [];
  let removed = false;
  for (const para of paragraphs) {
    const flat = para.replace(/\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    const next = stripBoilerplateChunk(flat);
    if (next !== flat) removed = true;
    if (next) keptParas.push(next);
  }
  if (!removed) return trimmed;
  return keptParas.join('\n\n').trim();
}

const TITLE_LINE = /^(senior|sr\.?|junior|jr\.?|lead|head|chief|director|manager|vp|vice president|president|founder|co-founder|owner|partner|principal|designer|engineer|counsel|attorney|analyst|coordinator|specialist|administrator|associate|officer|consultant)\b/i;

function isHardSignatureLine(line) {
  const l = String(line || '').trim();
  if (!l || l.length > 120) return false;
  if (/^--\s*$/.test(l)) return true;
  if (/^sent from my\b/i.test(l)) return true;
  if (/^https?:\/\/\S+$/i.test(l) || /^www\.\S+$/i.test(l)) return true;
  if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(l)) return true;
  if (/^\+?[\d\s().-]{10,}$/.test(l)) return true;
  if (TITLE_LINE.test(l) && !/[.?!]/.test(l)) return true;
  return false;
}

function isNameLine(line) {
  const l = String(line || '').trim();
  if (!l || l.length > 60 || /[.!?]/.test(l)) return false;
  const words = l.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[\p{L}][\p{L}'’.-]+$/u.test(w));
}

/** "Kayla Debiec" is a signature. "Sounds good" is a sentence. */
function isProperName(text) {
  const s = String(text || '').trim();
  if (!isNameLine(s)) return false;
  return s.split(/\s+/).every((w) => /^[\p{Lu}][\p{L}'’.-]+$/u.test(w));
}

/**
 * A block that is only a signature: name, title, email, phone.
 * A sentence ("See my note.") is not a signature, even with an address under it.
 */
function paragraphIsSignatureOnly(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return true;
  if (looksLikeHumanSentence(s)) return false;
  const withoutEmails = s.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '');
  if (/[.!?]/.test(withoutEmails)) return false;
  const hasContact = /@/.test(s)
    || /\b\d{3}[\s).-]?\d{3}[\s.-]?\d{4}\b/.test(s)
    || /\b(designer|director|manager|president|founder|engineer|counsel|partner)\b/i.test(s);
  return hasContact && s.split(/\s+/).length <= 30;
}

/** Trailing phone / title / name block. A real sentence above it stays. */
function withoutSignatureBlock(text) {
  const kept = String(text || '').split('\n');
  let sawFurniture = false;
  while (kept.length) {
    const last = kept[kept.length - 1].trim();
    if (!last) {
      kept.pop();
      continue;
    }
    if (isHardSignatureLine(last)) {
      kept.pop();
      sawFurniture = true;
      continue;
    }
    if (sawFurniture && isNameLine(last)) {
      kept.pop();
      continue;
    }
    break;
  }
  return kept.join('\n').trim();
}

/**
 * Prospect text the classifier and referral check should read.
 * Quoted history and disclaimer / scanner footers are removed.
 * The stored reply and the Slack card keep the original full text.
 */
function humanTextForClassification(raw) {
  const plain = plainForBoilerplate(raw);
  if (!plain) return '';
  return removeSecurityBoilerplate(plain).trim();
}

/**
 * True when, after quoted history and a trailing signature, the only
 * remaining content is a legal disclaimer and/or a virus-scan footer.
 */
function isDisclaimerOrScannerOnly(text) {
  const plain = plainForBoilerplate(text);
  if (!plain) return false;
  const stripped = removeSecurityBoilerplate(plain);
  const boilerplatePresent = isBoilerplateText(plain) || normWs(stripped) !== normWs(plain);
  let human = withoutSignatureBlock(stripped).trim();
  if (boilerplatePresent && (paragraphIsSignatureOnly(human) || isProperName(human))) human = '';
  if (human) return false;
  return boilerplatePresent;
}

/** Mailbox is dead: not monitored, no longer active, no longer in use. */
function looksLikeUnmonitoredMailbox(text) {
  const s = normWs(text);
  if (!s) return false;
  if (/\b(not regularly monitored|no longer monitored|is not monitored)\b/.test(s)) return true;
  if (/\b(inbox|e-?mail|mailbox|address)\b/.test(s) && /\b(no longer active|no longer in use|not monitored)\b/.test(s)) return true;
  return false;
}

/** A mailbox rule that forwards the thread. Not a person handing us to a colleague. */
function looksLikeAutoForward(text) {
  const s = normWs(text);
  if (!s) return false;
  return /\bforward(?:ing)? (?:your |this |the )?(?:e-?mail|message|mail)\b/.test(s);
}

/**
 * The sender has left. A current employee pointing at a colleague does not match.
 */
function looksLikeDeparture(text) {
  const s = normWs(text);
  if (!s) return false;
  if (/\bno longer (?:employed|with|works?|working|part of)\b/.test(s)) return true;
  if (/\bno longer (?:a|an) (?:[a-z]+ ){0,3}(?:representative|employee|member)\b/.test(s)) return true;
  if (/\b(?:has left|left|leaving) (?:the )?(?:company|organization|org|team|firm)\b/.test(s)) return true;
  if (/\b(?:i am|i'm|i have|i've|has|is) retired\b/.test(s)) return true;
  if (/\bretired from\b/.test(s)) return true;
  if (/\b(?:i have|i've|has) moved on\b/.test(s)) return true;
  if (/\bmoved on from\b/.test(s)) return true;
  if (/\b(?:do not|don't|dont) work (?:here|there) anymore\b/.test(s)) return true;
  if (/\bno longer work(?:s|ing)? (?:here|there)\b/.test(s)) return true;
  if (/\bnot (?:the )?right (?:person|contact)\b/.test(s) && /\b(?:left|leaving|retired|no longer)\b/.test(s)) return true;
  return false;
}

/**
 * Why this human reply must not become a referral card.
 * Null when a current employee may be handing the thread to someone else.
 * Quotes and disclaimer footers are not the human reply.
 */
function referralTextBlockReason(text) {
  const human = humanTextForClassification(text);
  const body = human || text;
  if (!String(body || '').trim()) return null;
  if (looksLikeOutOfOffice(body)) return 'ooo';
  if (looksLikeAutomatedNotice(body)) return 'automated_notice';
  if (looksLikeUnsubscribe(body)) return 'unsubscribe';
  if (looksLikeDeparture(body)) return 'departure';
  if (looksLikeNotInterested(body)) return 'not_interested';
  return null;
}

/**
 * Mailbox changes, departure auto-replies, ticket bots, and replies whose
 * only content is a legal disclaimer or a security-gateway footer. Rules
 * only — no model — so a classifier outage cannot turn these into a draft.
 */
function looksLikeAutomatedNotice(text) {
  const s = normWs(text);
  if (!s) return false;
  if (looksLikeUnmonitoredMailbox(text)) return true;
  if (looksLikeAutoForward(text)) return true;
  if (/\bmoved to a new server\b/.test(s)) return true;
  if (/\bnew e-?mail address\b/.test(s)) return true;
  if (/\bplease use the new e-?mail\b/.test(s)) return true;
  if (/\bmailbox (is )?no longer monitored\b/.test(s)) return true;
  if (/\bthis is an automated message\b/.test(s)) return true;
  if (/\bticket\s*#/.test(s)) return true;
  if (/\bwe have received your request\b/.test(s)) return true;
  // Dead or unwatched mailbox: "this email account is no longer active",
  // "the address is no longer in use", "inbox is not regularly monitored".
  if (/\b(e-?mail|inbox|mailbox|account|address|box)\b[^.!?]{0,60}\b(is |are )?no longer (in use|active|valid|in service|being used|checked|monitored|being monitored)\b/.test(s)) return true;
  if (/\b(e-?mail|inbox|mailbox|account|address|box)\b[^.!?]{0,40}\b(is |are )?(not|isn'?t) (regularly |actively |being )?(monitored|checked|attended)\b/.test(s)) return true;
  const departed = /\b(no longer employed|no longer with|has left|no longer part of|no longer a (sales )?(rep|representative|employee|member)|is no longer (at|employed at))\b/.test(s);
  const handoff = /\b(reach out|contact|e-?mail|direct|forward|send|inquiries)\b/.test(s);
  if (departed && handoff) return true;
  if (isDisclaimerOrScannerOnly(text)) return true;
  return false;
}

/**
 * A person still in the seat handing the thread to a colleague.
 * Departure auto-replies stay wrong-person / automated notices.
 */
function looksLikeLiveColleagueReferral(text) {
  const s = normWs(text);
  if (!s) return false;
  if (looksLikeAutomatedNotice(text)) return false;
  if (looksLikeDeparture(text)) return false;
  if (/\b(no longer employed|no longer with|no longer works?|has left)\b/.test(s)) return false;
  if (!/\bnot (the )?right (person|contact)\b/.test(s)) return false;
  return /\b(talk|speak) to (my|our) colleague\b/.test(s) && /\bhandles this\b/.test(s);
}

/**
 * Only skip Slack for obvious OOO/auto-replies, unsubscribe requests, and
 * wrong-person bounces. Everything else — including "not interested" and any
 * objection — must still reach Slack. Err on the side of posting.
 */
function shouldSkipSlackForReply(text) {
  return Boolean(slackSuppressionReason(text));
}

/** Which rule silenced this reply, or null if it should reach Slack. For logging. */
function slackSuppressionReason(text) {
  if (looksLikeOutOfOffice(text)) return 'ooo';
  if (looksLikeAutomatedNotice(text)) return 'automated_notice';
  if (looksLikeUnsubscribe(text)) return 'unsubscribe';
  if (looksLikeWrongPerson(text)) return 'wrong_person';
  if (/\bnot seeking\b/.test(normWs(text))) return 'not_interested';
  return null;
}

/** Explicit opt-out requests only — never a soft "not interested". */
function looksLikeUnsubscribe(text) {
  const s = normWs(text);
  if (!s) return false;
  if (/\bunsubscribe\b/.test(s)) return true;
  if (/\bopt(ed)? out\b/.test(s)) return true;
  if (/\bremove me\b/.test(s)) return true;
  if (/\btake me off\b/.test(s)) return true;
  if (/\bdo not (contact|email)\b/.test(s)) return true;
  if (/\bdon'?t (contact|email) me\b/.test(s)) return true;
  if (/\bstop (emailing|contacting|messaging)\b/.test(s)) return true;
  return false;
}

function looksLikeWrongPerson(text) {
  const s = normWs(text);
  if (!s) return false;
  if (looksLikeDeparture(text)) return true;
  if (looksLikeLiveColleagueReferral(text)) return false;
  // Common "wrong person / no longer employed" / redirect phrases.
  if (/\bno longer employed\b/.test(s)) return true;
  if (/\bno longer with\b/.test(s)) return true;
  if (/\bno longer works?\b/.test(s)) return true;
  if (/\bhas left\b/.test(s) && /\b(company|organization|org|team)\b/.test(s)) return true;
  if (/\bplease contact\b/.test(s) && /\bregarding\b/.test(s)) return true;
  if (/\bplease (reach|contact)\b/.test(s) && /\binstead\b/.test(s)) return true;
  if (/\bwrong person\b/.test(s)) return true;
  if (/\bnot (the )?right (person|contact)\b/.test(s)) return true;
  return false;
}

function looksLikeNotInterested(text) {
  const s = normWs(text);
  if (!s) return false;
  if (/\bnot seeking\b/.test(s)) return true;

  // High-priority clear declines first. This must run before positive "interested in"
  // checks because "not interested in this service" contains "interested in".
  if (/\bwe are not interested\b/.test(s)) return true;
  if (/\b(i'?m|i am) not interested\b/.test(s)) return true;
  if (/\bnot interested in\b/.test(s)) return true;
  if (/\bnot interested at (this|the) time\b/.test(s)) return true;
  if (/\bnot interested\b/.test(s)) return true;
  if (/\bno interest (in|at|for)\b/.test(s)) return true;
  if (/\bnot pursuing\b/.test(s)) return true;
  if (/\bgoing to (have to )?pass\b/.test(s)) return true;
  if (/\bwill (have to )?pass (on this|on it)\b/.test(s)) return true;

  // Do not suppress clearly-positive / ambiguous interest.
  if (/\b(still|very|really) interested\b/.test(s)) return false;
  if (/\b(sounds good|let'?s (book|meet|chat|talk)|happy to (chat|meet|talk|learn)|would love to)\b/.test(s)) return false;
  if (/\binterested in (hearing|learning|seeing|your|a call|connecting|more|continuing)\b/.test(s)) return false;
  if (/^yes\b/.test(s)) return false;

  // Strong negative / clear "no" signals only.
  if (/\bno thanks\b/.test(s)) return true;
  if (/\bno thank you\b/.test(s)) return true;
  if (/\bplease stop\b/.test(s)) return true;
  if (/\bstop emailing\b/.test(s)) return true;
  if (/\bdo not contact\b/.test(s)) return true;
  if (/\bdon't contact\b/.test(s)) return true;
  if (/\bremove me\b/.test(s)) return true; // often overlaps REMOVE_ME
  if (/\bnot a fit\b/.test(s)) return true;
  if (/\bwe are all set\b/.test(s)) return true;
  // Polite brush-off. "Good luck with the search" is a no. A soft maybe
  // ("will speak internally to our board") does not match.
  if (/\bgood luck with (the |your )?(search|hunt|outreach)\b/.test(s)) return true;
  if (/\bbest of luck\b/.test(s)) return true;
  return false;
}

module.exports = {
  stripHtmlToText,
  stripOutlookCss,
  stripEmailQuotePrefix,
  stripEmailArtifacts,
  cleanInboundReply,
  cleanInboundOrRaw,
  payloadInboundIsBlank,
  looksLikeHtml,
  latestInboundReplyIsBlank,
  latestInboundFromSmartleadHistory,
  latestInboundReplyMeta,
  listInboundReplies,
  lastOutboundBodyFromSmartleadHistory,
  isLikelyDuplicateOfOutbound,
  parseInboundFromPayload,
  preferFullerInbound,
  fullestMessageText,
  normalizeSmartleadLeadId,
  normalizeSmartleadCampaignId,
  SMARTLEAD_NON_REPLY_EVENTS,
  envFlag,
  smartleadWebhookEnhancementsEnabled,
  looksLikeOutOfOffice,
  looksLikeAutomatedNotice,
  looksLikeUnmonitoredMailbox,
  looksLikeAutoForward,
  looksLikeDeparture,
  referralTextBlockReason,
  humanTextForClassification,
  isDisclaimerOrScannerOnly,
  looksLikeLiveColleagueReferral,
  looksLikeUnsubscribe,
  shouldSkipSlackForReply,
  slackSuppressionReason,
  looksLikeWrongPerson,
  looksLikeNotInterested,
};
