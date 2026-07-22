/**
 * Detect when a prospect is asking for (or clearly accepting) a booking/Calendly link,
 * based on the latest inbound + prior thread (especially our last outbound).
 */

function messageListFromThread(threadContext) {
  if (!threadContext) return [];
  if (typeof threadContext === 'string') {
    try { return messageListFromThread(JSON.parse(threadContext)); } catch { return []; }
  }
  if (Array.isArray(threadContext)) return threadContext;
  if (Array.isArray(threadContext.messages)) return threadContext.messages;
  if (Array.isArray(threadContext.history)) return threadContext.history;
  return [];
}

function messageText(m) {
  if (!m || typeof m !== 'object') return '';
  return String(m.message || m.body || m.text || m.email_body || m.content || '').trim();
}

function isUsMessage(m) {
  if (!m || typeof m !== 'object') return false;
  const role = String(m.role || m.sender || m.from || m.type || m.direction || '').toLowerCase();
  if (role === 'us' || role === 'me' || role === 'user' || role === 'sent' || role === 'outbound') return true;
  if (role === 'prospect' || role === 'lead' || role === 'correspondent' || role === 'reply' || role === 'inbound') return false;
  return false;
}

function lastOutboundText(threadContext) {
  const list = messageListFromThread(threadContext);
  let last = '';
  for (const m of list) {
    const t = messageText(m);
    if (!t) continue;
    if (isUsMessage(m)) last = t;
  }
  // SmartLead history often uses type SENT/REPLY
  if (!last) {
    for (const m of list) {
      const type = String(m.type || m.direction || '').toUpperCase();
      const t = messageText(m);
      if (!t) continue;
      if (type === 'SENT' || type === 'OUTBOUND') last = t;
    }
  }
  return last;
}

function outboundOfferedToSendBookingLink(threadContext) {
  const last = lastOutboundText(threadContext).toLowerCase();
  if (!last) return false;
  if (/https?:\/\/\S*(calendly|cal\.com|savvycal|booking)/i.test(last)) return true;
  return (
    /send (you )?(a |the )?(booking |calendly |calendar )?link/.test(last)
    || /booking link if/.test(last)
    || /if (neither|none) (of )?those work/.test(last)
    || /happy to send .{0,40}(link|calendar)/.test(last)
    || /want me to send .{0,40}(link|calendar)/.test(last)
    || /i can send .{0,40}(booking|calendly|calendar) link/.test(last)
  );
}

/**
 * True when the prospect is asking for the booking link, or accepting our offer to send it.
 */
function looksLikeBookingLinkRequest(inboundMessage, threadContext) {
  const raw = String(inboundMessage || '').trim();
  if (!raw) return false;
  const m = raw.toLowerCase().replace(/\s+/g, ' ');

  // Explicit ask for the link / calendar
  if (
    /\b(calendly|cal\.com|savvycal)\b/.test(m)
    || /\b(booking|calendar|schedule) link\b/.test(m)
    || /\bsend (me )?(the |a )?(link|calendar|calendly|booking)\b/.test(m)
    || /\b(share|drop|email|forward) (me )?(the |a )?(link|calendar|calendly)\b/.test(m)
    || /\bi('?ll| will)? (take|use|grab) (the )?link\b/.test(m)
    || /\bjust send (the |me the )?link\b/.test(m)
  ) {
    return true;
  }

  // Short acceptance after we offered to send a booking link
  if (outboundOfferedToSendBookingLink(threadContext) && m.length <= 160) {
    if (
      /^(sure|yes|yeah|yep|yup|ok|okay|please|go ahead|sounds good|that works|works for me|perfect|great|absolutely)\b/.test(m)
      || /\b(send it|send over|fire away|go for it)\b/.test(m)
      || /\b(neither|none) (work|works|do)\b/.test(m)
      || /\bthose (don'?t|do not) work\b/.test(m)
      || /\bsend (the )?link\b/.test(m)
    ) {
      return true;
    }
  }

  return false;
}

/** Strip common booking URLs from a draft (used when we must not include the link yet). */
function stripBookingUrls(text, bookingLink) {
  let s = String(text || '');
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  if (link) {
    s = s.split(link).join('').replace(/[ \t]+\n/g, '\n').trim();
  }
  s = s.replace(/https?:\/\/(?:www\.)?(?:calendly\.com|cal\.com|savvycal\.com)\/\S+/gi, '');
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

module.exports = {
  looksLikeBookingLinkRequest,
  outboundOfferedToSendBookingLink,
  lastOutboundText,
  stripBookingUrls,
};
