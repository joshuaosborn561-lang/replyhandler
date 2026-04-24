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
  if (/\bout of office\b/.test(s)) return true;
  if (/\bauto(?:matic)? reply\b/.test(s)) return true;
  if (/\bautoreply\b/.test(s)) return true;
  if (/\bon vacation\b/.test(s)) return true;
  if (/\breturn on\b/.test(s) && /\blimited access\b/.test(s)) return true;
  if (/\bi will have limited access to email\b/.test(s)) return true;
  if (/\bi am currently out of (the )?office\b/.test(s)) return true;
  if (/\bthank you for your (email|message)\b/.test(s) && /\bwill (respond|get back)\b/.test(s) && /\breturn\b/.test(s)) return true;
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

  // High priority: clear decline / no interest. Must run *before* positive "interested" heuristics
  // (otherwise "not interested in this service" wrongfully matches /\binterested in\b/ as positive).
  if (/\bwe are not interested\b/.test(s)) return true;
  if (/\b(i'?m|i am) not interested\b/.test(s)) return true;
  if (/\bnot interested in\b/.test(s)) return true;
  if (/\bnot interested at (this|the) time\b/.test(s)) return true;
  if (/\bnot interested\b/.test(s)) return true;
  if (/\bno interest (in|at|for)\b/.test(s)) return true;
  if (/\bnot pursuing\b/.test(s)) return true;
  if (/\bgoing to (have to |)pass\b/.test(s)) return true;
  if (/\bwill (have to )?pass (on this|on it)\b/.test(s)) return true;

  // Do not suppress clearly positive "interested" / engagement phrases.
  if (/\b(still|very|really) interested\b/.test(s)) return false;
  if (/\b(sounds good|let'?s (book|meet|chat|talk)|happy to (chat|meet|talk|learn)|would love to)\b/.test(s)) return false;
  if (/\binterested in (hearing|learning|seeing|your|a call|connecting|more|continuing)\b/.test(s)) return false;
  if (/^yes\b/.test(s)) return false;

  // Remaining clear negatives.
  if (/\bno thanks\b/.test(s)) return true;
  if (/\bplease stop\b/.test(s)) return true;
  if (/\bstop emailing\b/.test(s)) return true;
  if (/\bdo not contact\b/.test(s)) return true;
  if (/\bdon't contact\b/.test(s)) return true;
  if (/\bremove me\b/.test(s)) return true; // often overlaps REMOVE_ME
  if (/\bnot a fit\b/.test(s)) return true;
  if (/\bwe are all set\b/.test(s)) return true;
  return false;
}

/**
 * Map SmartLead webhook "category" / sentiment fields to our enum when present.
 * Returns null if nothing usable (caller should use the LLM + heuristics).
 */
function mapSmartleadCategoryString(raw) {
  if (raw == null) return null;
  const t = String(raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
  if (!t) return null;
  if (/(^|_)not_?interested(_|$)/.test(t) || t === 'negative' || t === 'declin(e|ed)' || t === 'rejected' || t === 'disinterested' || t === 'no') {
    return 'NOT_INTERESTED';
  }
  if (t === 'unsubscribe' || t === 'unsubscribed' || t === 'unsub') return 'REMOVE_ME';
  if (t === 'ooo' || t === 'out_of_office' || t === 'outofoffice' || t === 'autoresponder' || t === 'auto_responder') return 'OOO';
  if (t === 'wrong_person' || t === 'wrong_contact' || t === 'bounce' || t === 'invalid_lead') return 'WRONG_PERSON';
  if (t === 'interested' || t === 'positive' || t === 'hot' || t === 'engaged') return 'INTERESTED';
  if (t === 'question' || t === 'questions' || t === 'inquiry') return 'QUESTION';
  if (t === 'meeting' || t === 'meeting_booked' || t === 'calendar' || t === 'scheduling' || t === 'meeting_proposed') {
    return 'MEETING_PROPOSED';
  }
  if (t === 'competitor' || t === 'competition') return 'COMPETITOR';
  if (t === 'objection' || t === 'concern') return 'OBJECTION';
  return null;
}

function extractSmartleadCategoryFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const lead = payload.lead_data || payload.lead || {};
  const replyO = payload.reply_message || payload.replyMessage || payload.reply || null;
  const fromReply = replyO && typeof replyO === 'object'
    ? (replyO.category || replyO.email_category || replyO.sentiment || null)
    : null;
  const candidates = [
    payload.email_category,
    payload.emailCategory,
    payload.reply_category,
    payload.replyCategory,
    payload.message_category,
    payload.messageCategory,
    payload.lead_email_category,
    payload.leadEmailCategory,
    payload.sl_reply_category,
    payload.slReplyCategory,
    payload.category,
    payload.sentiment,
    payload.classification,
    lead.email_category,
    lead.emailCategory,
    lead.lead_email_category,
    fromReply,
  ];
  for (const c of candidates) {
    const mapped = mapSmartleadCategoryString(c);
    if (mapped) return mapped;
  }
  return null;
}

module.exports = {
  stripHtmlToText,
  stripEmailQuotePrefix,
  latestInboundFromSmartleadHistory,
  lastOutboundBodyFromSmartleadHistory,
  isLikelyDuplicateOfOutbound,
  parseInboundFromPayload,
  SMARTLEAD_NON_REPLY_EVENTS,
  envFlag,
  smartleadWebhookEnhancementsEnabled,
  looksLikeOutOfOffice,
  looksLikeWrongPerson,
  looksLikeNotInterested,
  mapSmartleadCategoryString,
  extractSmartleadCategoryFromPayload,
};
