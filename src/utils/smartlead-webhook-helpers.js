/**
 * Optional SmartLead webhook enrichment: non-reply event skip, inbound text from history,
 * dedupe of bad REPLY rows that mirror last SENT (SmartLead/Android glitches).
 */

function stripHtmlToText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
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

function stripEmailQuotePrefix(raw) {
  let t = String(raw || '').replace(/\r\n/g, '\n');
  const splitRe = /\nOn .{8,200}?wrote:\s*\n/i;
  const idx = t.search(splitRe);
  if (idx > 0) t = t.slice(0, idx);
  t = t.replace(/\n-----Original Message-----\s*[\s\S]*/i, '');
  t = t.replace(/\n_{20,}\s*[\s\S]*/, '');
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
      let plain = stripHtmlToText(raw) || String(raw || '').trim();
      plain = stripEmailQuotePrefix(plain);
      plain = stripHtmlToText(plain) || String(plain || '').trim();
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

/** Only skip Slack for obvious OOO/auto-replies. Err on the side of posting everything else. */
function shouldSkipSlackForReply(text) {
  return looksLikeOutOfOffice(text);
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

/** Clear interest / openness to meet — run before NOT_INTERESTED on OTHER replies. */
function looksLikePositiveInterest(text) {
  const s = normWs(stripHtmlToText(text));
  if (!s) return false;
  if (looksLikeOutOfOffice(s) || looksLikeWrongPerson(s) || looksLikeNotInterested(s)) return false;
  if (/\b(stop|unsubscribe|remove me)\b/.test(s)) return false;
  if (/\bnot an msp\b/.test(s) || /\bwe are not an msp\b/.test(s)) return false;
  if (/\bswitched to a new provider\b/.test(s)) return false;
  if (/\bno thanks\b/.test(s)) return false;

  if (/\b(might be interested|very interested|i'?m interested|sounds great|tickets sound great)\b/.test(s)) return true;
  if (/\bopen to a call\b/.test(s)) return true;
  if (/\b(happy|would love|glad) to (chat|talk|meet|connect|discuss)\b/.test(s)) return true;
  if (/\blet'?s (talk|chat|meet|connect|discuss)\b/.test(s)) return true;
  if (/\binterested in (discussing|hearing|learning|chatting|talking)\b/.test(s)) return true;
  if (/\btell me more\b/.test(s)) return true;
  if (/\bwhere are (they|you) located\b/.test(s)) return true;
  if (/\b(schedule|book|set up) (a )?(call|time|meeting)\b/.test(s)) return true;
  if (/\btomorrow\b/.test(s) && /\b(call|chat|meet|time)\b/.test(s)) return true;
  return false;
}

module.exports = {
  stripHtmlToText,
  stripEmailQuotePrefix,
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
  shouldSkipSlackForReply,
  looksLikeWrongPerson,
  looksLikeNotInterested,
  looksLikePositiveInterest,
};
