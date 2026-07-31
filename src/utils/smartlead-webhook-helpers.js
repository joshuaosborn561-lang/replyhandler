/**
 * Optional SmartLead webhook enrichment: non-reply event skip, inbound text from history,
 * dedupe of bad REPLY rows that mirror last SENT (SmartLead/Android glitches).
 */

function stripHtmlToText(s) {
  if (!s) return '';
  return String(s)
    // Keep block boundaries as newlines so quote/signature cutting still has anchors.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&rsquo;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    payload.sl_email_lead_map_id,
    payload.slEmailLeadMapId,
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
 * Cut quoted thread history off a reply. Anchors must not require a newline:
 * HTML replies arrive as one collapsed line, which made the old \n-anchored
 * patterns never match and left the whole quoted thread in the card.
 */
function stripEmailQuotePrefix(raw) {
  let t = String(raw || '').replace(/\r\n/g, '\n');

  const cutAt = (re) => {
    const m = t.match(re);
    if (m && m.index > 0) t = t.slice(0, m.index);
  };

  cutAt(/\bOn\s.{8,200}?\bwrote:/i);
  cutAt(/-----\s*Original Message\s*-----/i);
  cutAt(/_{20,}/);
  // Outlook-style quoted header. Requires an address right after so a sentence
  // containing "from:" is never mistaken for a quote boundary.
  cutAt(/\bFrom:\s+[^\n]{0,80}?<?[\w.+-]+@[\w.-]+/i);
  cutAt(/\bSent from my (iPhone|iPad|Android|Samsung)/i);

  return t.trim();
}

/** Inline image refs and the bracketed URL/address echoes Outlook leaves behind. */
function stripEmailArtifacts(raw) {
  return String(raw || '')
    .replace(/\[cid:[^\]]+\]/gi, ' ')
    .replace(/\[(https?:\/\/[^\]]+)\]/gi, ' ')
    .replace(/\[([\w.+-]+@[\w.-]+)\]/gi, ' ')
    .replace(/<(https?:\/\/[^>]+)>/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SIG_MARKER = /(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b(managing partner|president|ceo|cto|coo|cfo|founder|director|manager|vp|vice president|principal|owner|partner)\b|[\w.+-]+@[\w.-]+|\bcid:)/i;

/**
 * Drop a trailing signature block. Only cuts at a closing word ("Best, Chris")
 * when what follows actually looks like a signature — a phone number, a job
 * title, an address or an image ref — so a reply that merely ends politely is
 * left alone.
 */
function stripTrailingSignature(raw) {
  const t = String(raw || '');
  const re = /\b(best regards|kind regards|warm regards|best|thanks again|thanks|thank you|regards|cheers|sincerely|talk soon)\b[,!.]?[\s]+/gi;
  let cut = -1;
  for (const m of t.matchAll(re)) {
    const tail = t.slice(m.index + m[0].length);
    if (tail.length >= 8 && tail.length <= 600 && SIG_MARKER.test(tail)) { cut = m.index; break; }
  }
  return (cut > 0 ? t.slice(0, cut) : t).trim();
}

/** Full cleanup for a prospect reply: quotes, artifacts, signature. */
function cleanInboundReply(raw) {
  let t = stripHtmlToText(raw) || String(raw || '');
  t = stripEmailQuotePrefix(t);
  t = stripEmailArtifacts(t);
  t = stripTrailingSignature(t);
  return t.trim();
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

function latestInboundFromSmartleadHistory(histResponse, leadEmail) {
  if (!histResponse || typeof histResponse !== 'object') return '';
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
      const raw = m.email_body || m.body || m.text || '';
      const plain = cleanInboundReply(raw);
      if (!plain) continue;
      const time = String(m.time || m.sent_at || m.received_at || m.created_at || '');
      rows.push({ time, body: plain, rawForDedupe: stripHtmlToText(raw) || String(raw || '').trim() });
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
      const { body, rawForDedupe } = rows[i];
      if (lastSentBody && isLikelyDuplicateOfOutbound(rawForDedupe || body, lastSentBody)) {
        continue;
      }
      return body;
    }
    return '';
  };

  const strictRows = collectRows(true);
  const strict = pickLatestNonDuplicate(strictRows);
  if (strict) return strict;
  const looseRows = collectRows(false);
  return pickLatestNonDuplicate(looseRows);
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

function parseInboundFromPayload(replyObj, payload) {
  const base =
    (replyObj && typeof replyObj === 'object'
      ? (replyObj.body ||
        replyObj.message ||
        replyObj.text ||
        replyObj.plain_text ||
        stripHtmlToText(replyObj.html || replyObj.html_body))
      : replyObj) ||
    payload.reply_message_body ||
    payload.replyMessageBody ||
    payload.last_reply_body ||
    payload.lastReplyBody ||
    payload.reply_text ||
    payload.message ||
    payload.body ||
    '';
  return String(base || '').trim();
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
  if (looksLikeUnsubscribe(text)) return 'unsubscribe';
  if (looksLikeWrongPerson(text)) return 'wrong_person';
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
  return false;
}

module.exports = {
  stripHtmlToText,
  stripEmailQuotePrefix,
  stripEmailArtifacts,
  stripTrailingSignature,
  cleanInboundReply,
  latestInboundFromSmartleadHistory,
  lastOutboundBodyFromSmartleadHistory,
  isLikelyDuplicateOfOutbound,
  parseInboundFromPayload,
  normalizeSmartleadLeadId,
  normalizeSmartleadCampaignId,
  SMARTLEAD_NON_REPLY_EVENTS,
  envFlag,
  smartleadWebhookEnhancementsEnabled,
  looksLikeOutOfOffice,
  looksLikeUnsubscribe,
  shouldSkipSlackForReply,
  slackSuppressionReason,
  looksLikeWrongPerson,
  looksLikeNotInterested,
};
