/**
 * RFC 5322 Message-ID for one prospect email.
 *
 * The reply webhook, the category webhook, and the inbox poller all carry
 * the same id (`<...@...outlook.com>`). That id is the identity of the email.
 * It is not a SmartLead stats id and it is not a time bucket.
 */

function canonicalInboundMessageId(raw) {
  let s = String(raw || '').replace(/\r?\n/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/^message-id:\s*/i, '').trim();
  const wrapped = s.match(/<[^<>\s]+@[^<>\s]+>/);
  if (wrapped) s = wrapped[0];
  s = s.trim().toLowerCase();
  if (!s.includes('@')) return '';
  if (!s.startsWith('<')) s = `<${s.replace(/^<|>$/g, '')}>`;
  if (!s.endsWith('>')) s = `${s}>`;
  return s;
}

function messageIdFromHeaderBlob(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string') return '';
  const labeled = raw.match(/message-id:\s*(<[^<>\s]+@[^<>\s]+>)/i);
  if (labeled) return canonicalInboundMessageId(labeled[1]);
  return '';
}

function messageIdFromHeaders(headers) {
  if (!headers) return '';
  if (typeof headers === 'string') return messageIdFromHeaderBlob(headers);
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h || typeof h !== 'object') continue;
      const name = String(h.name || h.key || '').toLowerCase();
      if (name !== 'message-id') continue;
      const id = canonicalInboundMessageId(h.value || h.val || '');
      if (id) return id;
    }
    return '';
  }
  if (typeof headers !== 'object') return '';
  return canonicalInboundMessageId(
    headers['message-id'] || headers['Message-ID'] || headers['Message-Id'] || headers.message_id || ''
  );
}

function messageIdOfMessage(message) {
  if (!message || typeof message !== 'object') return '';
  const keys = [
    'message_id', 'messageId', 'email_message_id', 'reply_message_id',
    'rfc_message_id', 'rfc822_message_id', 'internet_message_id',
    'original_message_id', 'originalMessageId', 'smtp_message_id', 'smtpMessageId',
  ];
  for (const key of keys) {
    const id = canonicalInboundMessageId(message[key]);
    if (id) return id;
  }
  const fromHeaders = messageIdFromHeaders(
    message.headers || message.email_headers || message.header
    || message.raw_headers || message.rawHeaders || message.header_text
  );
  if (fromHeaders) return fromHeaders;
  const nested = message.reply_message || message.replyMessage;
  if (nested && typeof nested === 'object' && nested !== message) {
    return messageIdOfMessage(nested);
  }
  return '';
}

module.exports = {
  canonicalInboundMessageId,
  messageIdOfMessage,
};
