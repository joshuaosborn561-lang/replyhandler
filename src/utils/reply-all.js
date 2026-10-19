/**
 * Reply to the actual inbound sender, and CC every other human on the thread.
 *
 * Latest inbound from/to/cc/message id come from SmartLead message-history.
 * Our sending accounts, their domains, duplicates, and auto-reply addresses
 * stay off the CC list. Loop-in client CC (#106) is merged at send time.
 */

const AUTO_REPLY_LOCAL = /^(no[-_]?reply|do[-_]?not[-_]?reply|donotreply|mailer-daemon|postmaster|bounce|bounces|notifications?|alerts?|automated?|mailer|daemon|noreply)$/i;

function historyMessages(historyResponse) {
  if (!historyResponse || typeof historyResponse !== 'object') return [];
  if (Array.isArray(historyResponse.history)) return historyResponse.history;
  if (Array.isArray(historyResponse.messages)) return historyResponse.messages;
  if (Array.isArray(historyResponse)) return historyResponse;
  return [];
}

function normalizeEmail(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const angle = s.match(/<([^>]+@[^>]+)>/);
  const candidate = (angle ? angle[1] : s).trim().toLowerCase();
  if (!candidate.includes('@')) return '';
  return candidate.replace(/[<>\s]/g, '');
}

function displayNameFromAddress(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const angle = s.match(/^(.*?)\s*<[^>]+@[^>]+>/);
  if (angle && angle[1].trim()) {
    return angle[1].replace(/^["']|["']$/g, '').trim();
  }
  return '';
}

function emailsFromValue(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    return value.flatMap(emailsFromValue);
  }
  if (typeof value === 'object') {
    const nested = value.email || value.address || value.from || value.value;
    if (nested) return emailsFromValue(nested);
    return [];
  }
  return String(value)
    .split(/[,;]+/)
    .map(normalizeEmail)
    .filter(Boolean);
}

function firstAddressField(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const v = obj[key];
    if (v == null || v === '') continue;
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'object') {
      const nested = v.email || v.address || v.name || v.value;
      if (nested) return nested;
    }
  }
  return '';
}

function isInboundRow(m) {
  const type = String(m?.type || m?.direction || m?.role || '').toUpperCase();
  if (type === 'REPLY' || type === 'INBOUND' || type === 'PROSPECT') return true;
  if (type === 'SENT' || type === 'OUTBOUND') return false;
  if (m?.is_reply === true || m?.isReply === true) return true;
  return false;
}

function rowTime(m) {
  return String(m?.time || m?.sent_at || m?.received_at || m?.created_at || m?.timestamp || '');
}

function latestInboundMessage(historyResponse) {
  const list = historyMessages(historyResponse);
  const inbound = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (!isInboundRow(m)) continue;
    inbound.push(m);
  }
  if (!inbound.length) return null;
  inbound.sort((a, b) => rowTime(a).localeCompare(rowTime(b)));
  return inbound[inbound.length - 1];
}

function extractInboundHeaders(message) {
  if (!message || typeof message !== 'object') {
    return { from: '', fromRaw: '', to: [], cc: [], messageId: '', time: '' };
  }
  const fromRaw = firstAddressField(message, [
    'from', 'from_email', 'fromEmail', 'sender', 'sender_email', 'reply_from',
    'from_address', 'fromAddress',
  ]);
  const toRaw = message.to || message.to_email || message.toEmail || message.to_emails
    || message.toEmails || message.recipient || message.recipients || '';
  const ccRaw = message.cc || message.cc_email || message.ccEmail || message.cc_emails
    || message.ccEmails || message.cc_address || '';
  const messageId = message.message_id || message.messageId || message.reply_message_id
    || message.replyMessageId || message.email_message_id || '';
  return {
    from: normalizeEmail(fromRaw),
    fromRaw: String(fromRaw || ''),
    fromName: displayNameFromAddress(fromRaw)
      || String(message.from_name || message.fromName || message.sender_name || '').trim(),
    to: emailsFromValue(toRaw),
    cc: emailsFromValue(ccRaw),
    messageId: messageId ? String(messageId).trim() : '',
    time: rowTime(message),
  };
}

function firstNameFromSender({ fromName, from, fallbackName } = {}) {
  const named = String(fromName || '').trim();
  if (named) return named.split(/\s+/)[0];
  const fallback = String(fallbackName || '').trim();
  if (fallback && fallback.toLowerCase() !== 'unknown') return fallback.split(/\s+/)[0];
  const local = String(from || '').split('@')[0] || '';
  const token = local.split(/[._-]+/)[0];
  if (token && token.length >= 2 && !/^\d+$/.test(token)) {
    return token.charAt(0).toUpperCase() + token.slice(1);
  }
  return 'there';
}

function isAutoReplyAddress(email) {
  const e = normalizeEmail(email);
  if (!e) return true;
  const local = e.split('@')[0] || '';
  return AUTO_REPLY_LOCAL.test(local);
}

function domainOf(email) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  return at >= 0 ? e.slice(at + 1) : '';
}

function ourIdentitiesFromThread(historyResponse) {
  const emails = new Set();
  for (const m of historyMessages(historyResponse)) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type !== 'SENT' && type !== 'OUTBOUND') continue;
    const fromRaw = firstAddressField(m, ['from', 'from_email', 'fromEmail', 'sender', 'sender_email']);
    const email = normalizeEmail(fromRaw);
    if (email) emails.add(email);
  }
  return [...emails];
}

function collectOurEmails(accountEmails, historyResponse) {
  const out = new Set();
  for (const e of emailsFromValue(accountEmails)) out.add(e);
  for (const e of ourIdentitiesFromThread(historyResponse)) out.add(e);
  return out;
}

function collectOurDomains(ourEmails, extraDomains) {
  const out = new Set();
  for (const e of ourEmails) {
    const d = domainOf(e);
    if (d) out.add(d);
  }
  for (const d of extraDomains || []) {
    const s = String(d || '').trim().toLowerCase().replace(/^@/, '');
    if (s) out.add(s);
  }
  return out;
}

function shouldExclude(email, { ourEmails, ourDomains, recipient }) {
  const e = normalizeEmail(email);
  if (!e) return true;
  if (e === recipient) return true;
  if (ourEmails.has(e)) return true;
  const d = domainOf(e);
  if (d && ourDomains.has(d)) return true;
  if (isAutoReplyAddress(e)) return true;
  return false;
}

/**
 * Recipient = latest inbound From. CC = every other human on that message
 * (to + cc) plus the original campaign lead if they were on the thread,
 * minus our mailboxes/domains, duplicates, and auto-reply addresses.
 */
function buildReplyAll({
  history,
  accountEmails = [],
  extraOurDomains = [],
  originalLeadEmail = '',
  fallbackName = '',
} = {}) {
  const inbound = latestInboundMessage(history);
  const headers = extractInboundHeaders(inbound);
  const recipient = headers.from || normalizeEmail(originalLeadEmail);
  const ourEmails = collectOurEmails(accountEmails, history);
  const ourDomains = collectOurDomains(ourEmails, extraOurDomains);

  const seen = new Set();
  const cc = [];
  const consider = [
    ...headers.to,
    ...headers.cc,
    normalizeEmail(originalLeadEmail),
  ];
  for (const raw of consider) {
    const e = normalizeEmail(raw);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    if (shouldExclude(e, { ourEmails, ourDomains, recipient })) continue;
    cc.push(e);
  }

  const senderFirstName = firstNameFromSender({
    fromName: headers.fromName,
    from: headers.from,
    fallbackName,
  });
  const senderDisplayName = headers.fromName
    || (senderFirstName !== 'there' ? senderFirstName : fallbackName)
    || '';

  return {
    recipient: recipient || '',
    cc,
    ccCsv: cc.join(', '),
    replyMessageId: headers.messageId || '',
    replyEmailTime: headers.time || '',
    senderEmail: headers.from || recipient || '',
    senderFirstName,
    senderDisplayName,
    inboundHeaders: headers,
  };
}

function mergeCcLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const e of emailsFromValue(list)) {
      if (seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

module.exports = {
  historyMessages,
  normalizeEmail,
  emailsFromValue,
  latestInboundMessage,
  extractInboundHeaders,
  firstNameFromSender,
  isAutoReplyAddress,
  ourIdentitiesFromThread,
  buildReplyAll,
  mergeCcLists,
};
