'use strict';

/**
 * "We just CC'd you" notice (Josh, Oct 29 2026).
 *
 * When a reply goes out with the client CC'd ("Approve & Send + CC client", or Edit with the
 * "CC client on this reply" box ticked), the client's always-CC contacts also get one short plain
 * email from Josh's own inbox (the primary Gmail, gmail-send.js) telling them to check spam and
 * which address the reply came from, so they can whitelist it.
 *
 *   - OFF unless CC_NOTICE_EMAIL_ENABLED is true. Nothing is sent when it is off.
 *   - Only after the SmartLead reply was sent with the client CC on it (the caller checks that).
 *   - ONE email per send. To = the CC'd contacts (deduped, lowercased). Never the prospect, never
 *     Josh himself. Nobody is mailed separately.
 *   - Dedupe: the same reply + same recipients is only mailed once per process lifetime window.
 *     The send itself is already single-shot (claimOutboundSend), so this guards re-entry.
 *   - Never throws. A failed notice must never turn a sent reply into a failed card.
 */

const gmail = require('./gmail-send');
const { parseEmailList } = require('./client-cc');
const { escapeHtml } = require('./client-notify-email');
const { fyiReplyTo } = require('../utils/fyi-notify');
const { historyMessages, normalizeEmail, emailsFromValue } = require('../utils/reply-all');

const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
const seen = new Map();

function ccNoticeEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.CC_NOTICE_EMAIL_ENABLED || '').trim());
}

function str(v, max = 200) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function isSent(m) {
  const type = String(m?.type || m?.direction || '').toUpperCase();
  return type === 'SENT' || type === 'OUTBOUND';
}

function msgTime(m) {
  return String(m?.time || m?.sent_at || m?.received_at || m?.created_at || '');
}

function fromOf(m) {
  return normalizeEmail(m?.from || m?.from_email || m?.fromEmail || m?.sender || m?.sender_email || '');
}

/**
 * The mailbox the reply went out from. SmartLead's reply-email-thread sends from the mailbox that
 * sent the message whose stats_id we reply to, so:
 *   1. the SENT message whose stats_id is the one we replied to,
 *   2. else the latest SENT message in the thread,
 *   3. else the address the prospect wrote to, when it is one of our known sending accounts.
 * Returns '' when none is known (the notice then omits the address line).
 */
function pickSendingInbox({ history, emailStatsId, accountEmails = [] } = {}) {
  const list = historyMessages(history).filter((m) => m && typeof m === 'object');
  const sent = list.filter(isSent).filter((m) => fromOf(m));
  const want = String(emailStatsId || '').trim();
  if (want) {
    const hit = sent.find((m) => String(m.stats_id || m.email_stats_id || m.emailStatsId || m.statsId || '') === want);
    if (hit) return fromOf(hit);
  }
  if (sent.length) {
    const latest = [...sent].sort((a, b) => msgTime(a).localeCompare(msgTime(b))).pop();
    return fromOf(latest);
  }
  const ours = new Set(emailsFromValue(accountEmails));
  const inbound = list.filter((m) => !isSent(m));
  for (const m of inbound.reverse()) {
    for (const to of emailsFromValue(m.to || m.to_email || m.toEmail || m.to_emails || '')) {
      if (ours.has(to)) return to;
    }
  }
  return '';
}

/** Who gets the notice: the CC'd client contacts, minus the prospect, Josh, and the sending inbox. */
function noticeRecipients({ ccEmails, leadEmail, exclude = [] } = {}) {
  const skip = new Set(
    [leadEmail, ...exclude].flatMap((e) => emailsFromValue(e)).map((e) => e.toLowerCase())
  );
  return parseEmailList(Array.isArray(ccEmails) ? ccEmails.join(',') : ccEmails)
    .filter((e) => !skip.has(e));
}

/** Subject and body. {lead_name}, {company}, {sender_email} are filled in; no other lead data. */
function buildCcNoticeEmail({ leadName, company, senderEmail } = {}) {
  const lead = str(leadName) && str(leadName).toLowerCase() !== 'unknown' ? str(leadName) : 'a prospect';
  const co = str(company);
  const sender = normalizeEmail(senderEmail);
  const who = co ? `${lead} at ${co}` : lead;

  const subject = `Heads up: we just CC'd you on a reply to ${lead}`;
  const lines = [
    'Hi,',
    '',
    `We just CC'd you on our reply to ${who}. If you don't see it in your inbox, please check your spam and promotions folders.`,
  ];
  if (sender) {
    lines.push(
      '',
      `It came from ${sender}. Adding that address to your contacts (or marking it "not spam") makes sure the rest land in your inbox.`,
    );
  }
  lines.push('', 'Thanks,', 'Josh');
  const textBody = lines.join('\n');
  const htmlBody = lines
    .map((l) => (l === '' ? '' : escapeHtml(l)))
    .join('<br>\n')
    .replace(/(<br>\n){2,}/g, '<br><br>\n');
  return { subject, textBody, htmlBody: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${htmlBody}</div>` };
}

function seenKey(replyId, to) {
  return `${replyId}|${[...to].sort().join(',')}`;
}

function pruneSeen(now = Date.now()) {
  for (const [k, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(k);
}

function _resetSeenForTests() { seen.clear(); }

/**
 * Send the notice. Returns { sent, to?, from?, skipped?, error? }. Never throws.
 * @param {{ replyId, leadName, company, leadEmail, ccEmails, history, emailStatsId, accountEmails }} p
 */
async function sendCcNotice(p = {}, { mailer = gmail, env = process.env } = {}) {
  try {
    if (!ccNoticeEnabled(env)) return { sent: false, skipped: 'disabled' };
    const josh = [mailer.expectedFromEmail ? mailer.expectedFromEmail() : ''];
    const senderEmail = pickSendingInbox({
      history: p.history, emailStatsId: p.emailStatsId, accountEmails: p.accountEmails,
    });
    const to = noticeRecipients({ ccEmails: p.ccEmails, leadEmail: p.leadEmail, exclude: [...josh, senderEmail] });
    if (!to.length) return { sent: false, skipped: 'no_recipients' };

    pruneSeen();
    const key = seenKey(p.replyId, to);
    if (p.replyId && seen.has(key)) return { sent: false, skipped: 'duplicate' };

    if (!mailer.isConfigured()) return { sent: false, skipped: 'gmail_not_configured' };
    const email = buildCcNoticeEmail({ leadName: p.leadName, company: p.company, senderEmail });
    if (p.replyId) seen.set(key, Date.now());
    try {
      const res = await mailer.sendMail({
        to,
        replyTo: fyiReplyTo(env),
        subject: email.subject,
        htmlBody: email.htmlBody,
        textBody: email.textBody,
      });
      return { sent: true, to, from: res?.from || null, senderEmail: senderEmail || null };
    } catch (err) {
      if (p.replyId) seen.delete(key);
      throw err;
    }
  } catch (err) {
    console.warn('[CcNotice] notice not sent (reply already went out)', { replyId: p.replyId, err: err.message });
    return { sent: false, error: err.message };
  }
}

module.exports = {
  ccNoticeEnabled, pickSendingInbox, noticeRecipients, buildCcNoticeEmail, sendCcNotice, _resetSeenForTests,
};
