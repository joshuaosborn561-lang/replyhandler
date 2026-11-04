'use strict';

/**
 * Separate heads-up when Josh CCs a client on a prospect reply (Nov 4 2026).
 * One email from the primary Gmail (Josh), to the addresses just placed on
 * the SmartLead cc. Not a SmartLead cc and not a forward of the thread.
 * Nothing here runs unless that CC list is non-empty.
 */

const db = require('../db');
const gmail = require('./gmail-send');
const {
  historyMessages,
  normalizeEmail,
  latestInboundMessage,
  extractInboundHeaders,
} = require('../utils/reply-all');

const SUBJECT = "Check spam: we CC'd you";

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fromOf(message) {
  if (!message || typeof message !== 'object') return '';
  return normalizeEmail(
    message.from || message.from_email || message.fromEmail || message.sender || message.sender_email || ''
  );
}

function isSent(message) {
  const type = String(message?.type || message?.direction || '').toUpperCase();
  return type === 'SENT' || type === 'OUTBOUND';
}

function statsOf(message) {
  return String(message?.stats_id || message?.email_stats_id || message?.emailStatsId || message?.statsId || '');
}

/**
 * Mailbox the prospect thread actually went out from.
 * The SENT row we replied to (stats id), else the latest SENT from, else
 * the address the prospect wrote to. Empty when none of those are present.
 */
function sendingInboxFromThread(history, statsId) {
  const sent = historyMessages(history).filter(isSent);
  if (statsId) {
    const hit = sent.find((m) => statsOf(m) === String(statsId));
    const email = hit && fromOf(hit);
    if (email) return email;
  }
  const ordered = [...sent].sort((a, b) => String(a.time || a.sent_at || '').localeCompare(String(b.time || b.sent_at || '')));
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const email = fromOf(ordered[i]);
    if (email) return email;
  }
  const inbound = latestInboundMessage(history);
  const headers = extractInboundHeaders(inbound);
  const lead = headers.from;
  const to = (headers.to || []).find((email) => email && email !== lead);
  return to || '';
}

function prospectLabel(reply) {
  const name = String(reply?.lead_full_name || reply?.lead_name || '').trim();
  const company = String(reply?.lead_company || '').trim();
  if (name && company && name.toLowerCase() !== company.toLowerCase()) return `${name} at ${company}`;
  return name || company || 'the prospect';
}

/** Client addresses just CC'd, minus the prospect and the sending inbox. */
function headsUpRecipients(ccEmails, reply, sendingInbox) {
  const blocked = new Set(
    [normalizeEmail(reply?.lead_email), normalizeEmail(sendingInbox)].filter(Boolean)
  );
  const seen = new Set();
  const out = [];
  const raw = Array.isArray(ccEmails) ? ccEmails.join(',') : String(ccEmails || '');
  for (const part of raw.split(/[,;\s]+/)) {
    const email = normalizeEmail(part);
    if (!email || blocked.has(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function headsUpBody(reply, sendingInbox) {
  return `Hey, we just CC'd you on a reply to ${prospectLabel(reply)}. It came from ${sendingInbox}. It's probably in your spam, so check there and mark it not-spam.`;
}

async function claimHeadsUp(query, replyId) {
  const { rows } = await query(
    `UPDATE pending_replies
        SET cc_heads_up_sent_at = now(), updated_at = now()
      WHERE id = $1 AND cc_heads_up_sent_at IS NULL
      RETURNING id`,
    [replyId]
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function releaseHeadsUp(query, replyId) {
  await query(
    `UPDATE pending_replies
        SET cc_heads_up_sent_at = NULL, updated_at = now()
      WHERE id = $1`,
    [replyId]
  );
}

/**
 * Send the heads-up once. `ccEmails` is the list just put on the prospect
 * thread. Returns { sent, reason, to }. Never throws. Never addresses the prospect.
 */
async function sendCcHeadsUp({
  reply,
  ccEmails,
  history,
  query = db.query.bind(db),
  mail = gmail,
} = {}) {
  if (!reply?.id) return { sent: false, reason: 'no_reply' };
  const sendingInbox = sendingInboxFromThread(history, reply.smartlead_email_stats_id);
  if (!sendingInbox) return { sent: false, reason: 'no_sending_inbox' };
  const to = headsUpRecipients(ccEmails, reply, sendingInbox);
  if (!to.length) return { sent: false, reason: 'no_recipients' };
  const lead = normalizeEmail(reply.lead_email);
  if (lead && to.includes(lead)) return { sent: false, reason: 'prospect_blocked' };

  let claimed = false;
  try {
    claimed = await claimHeadsUp(query, reply.id);
  } catch (err) {
    console.warn('[CcHeadsUp] claim failed', { replyId: reply.id, err: err.message });
    return { sent: false, reason: 'claim_failed' };
  }
  if (!claimed) return { sent: false, reason: 'already_sent' };

  if (!mail || typeof mail.isConfigured !== 'function' || !mail.isConfigured() || typeof mail.sendMail !== 'function') {
    try { await releaseHeadsUp(query, reply.id); } catch { /* retry can claim again */ }
    return { sent: false, reason: 'gmail_not_configured' };
  }

  const text = headsUpBody(reply, sendingInbox);
  try {
    await mail.sendMail({
      to,
      subject: SUBJECT,
      textBody: text,
      htmlBody: `<p>${escapeHtml(text)}</p>`,
    });
    console.log('[CcHeadsUp] sent', { replyId: reply.id, recipients: to.length });
    return { sent: true, to };
  } catch (err) {
    console.warn('[CcHeadsUp] send failed', { replyId: reply.id, err: err.message });
    try { await releaseHeadsUp(query, reply.id); } catch { /* leave the claim if the release fails */ }
    return { sent: false, reason: 'send_failed' };
  }
}

module.exports = {
  SUBJECT,
  sendingInboxFromThread,
  headsUpRecipients,
  headsUpBody,
  prospectLabel,
  sendCcHeadsUp,
};
