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
};
