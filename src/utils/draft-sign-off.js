'use strict';

/**
 * Draft sign-off name. Josh (Oct 2026): "it should be whoever the inbox is
 * named after, or if it was Gabe, then Gabe."
 *
 * Order: Gabe Calls campaign -> Gabe; sending mailbox's person (from_name,
 * else the email local part); client voice-prompt name; else none.
 */

const GABE_CALLS_CAMPAIGN_IDS = new Set(['4085158', '4085159', '4085160']);
const GENERIC_LOCAL_PARTS = new Set([
  'info', 'hello', 'hi', 'team', 'sales', 'contact', 'support', 'admin', 'office',
  'noreply', 'no', 'reply', 'mail', 'marketing', 'growth', 'outreach', 'bookings',
]);

function cap(word) {
  const w = String(word || '').trim();
  if (!w) return null;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function isGabeCallsCampaign({ campaignName, campaignId } = {}) {
  if (campaignId != null && GABE_CALLS_CAMPAIGN_IDS.has(String(campaignId))) return true;
  return /^\s*gabe calls\b/i.test(String(campaignName || ''));
}

function emailOf(raw) {
  const m = String(raw || '').match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return m ? m[0].toLowerCase() : '';
}

function displayName(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return m ? m[1].trim() : '';
}

/** First name of a mailbox person from a display name or email address. */
function firstNameFromMailbox({ fromName, fromEmail } = {}) {
  const name = String(fromName || '').trim();
  if (name && !name.includes('@')) {
    const first = name.split(/\s+/)[0].replace(/[^\p{L}'’-]/gu, '');
    if (first && !GENERIC_LOCAL_PARTS.has(first.toLowerCase())) return cap(first);
  }
  const email = emailOf(fromEmail);
  if (!email) return null;
  const token = email.split('@')[0].split(/[._+-]+/)[0].replace(/\d+/g, '');
  if (!token || token.length < 2 || GENERIC_LOCAL_PARTS.has(token)) return null;
  return cap(token);
}

function historyList(threadContext) {
  let ctx = threadContext;
  if (typeof ctx === 'string') {
    try { ctx = JSON.parse(ctx); } catch { return []; }
  }
  if (Array.isArray(ctx)) return ctx;
  if (ctx && Array.isArray(ctx.history)) return ctx.history;
  if (ctx && Array.isArray(ctx.messages)) return ctx.messages;
  return [];
}

/** Sending mailbox from the latest SENT message in the SmartLead history (not the lead). */
function sendingMailbox(threadContext, leadEmail) {
  const lead = emailOf(leadEmail);
  const sent = historyList(threadContext).filter((m) => {
    const t = String((m && (m.type || m.role)) || '').toUpperCase();
    return t === 'SENT' || t === 'OUTBOUND' || t === 'US' || t === 'ASSISTANT';
  });
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const m = sent[i];
    const raw = m.from || m.from_email || m.fromEmail || m.sender || m.sender_email || '';
    const email = emailOf(raw);
    if (!email || email === lead) continue;
    return { fromEmail: email, fromName: m.from_name || m.fromName || displayName(raw) || '' };
  }
  return null;
}

function nameFromVoicePrompt(voicePrompt) {
  const s = String(voicePrompt || '');
  const m = s.match(/\b[Ss]ign(?:[- ]?[Oo]ff)?(?:\s+(?:as|with))?\s*[:\-]?\s*["']?([A-Z][a-z'’-]+)/)
    || s.match(/\byou are ([A-Z][a-z'’-]+)\b/);
  return m ? cap(m[1]) : null;
}

function resolveSignOffName({
  campaignName, campaignId, threadContext, leadEmail, mailbox, voicePrompt,
} = {}) {
  if (isGabeCallsCampaign({ campaignName, campaignId })) return 'Gabe';
  const box = mailbox || sendingMailbox(threadContext, leadEmail);
  const fromBox = box ? firstNameFromMailbox(box) : null;
  if (fromBox) return fromBox;
  return nameFromVoicePrompt(voicePrompt);
}

/** Put a bare first-name sign-off on the draft (replaces any existing one). */
function applySignOff(draft, name) {
  const text = String(draft || '').trim();
  if (!text || !name) return text;
  const lines = text.split('\n');
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (!last || /^[-–—]?\s*[A-Z][\p{L}'’.-]*$/u.test(last)) { lines.pop(); continue; }
    break;
  }
  return `${lines.join('\n').trim()}\n\n${name}`;
}

module.exports = {
  GABE_CALLS_CAMPAIGN_IDS,
  isGabeCallsCampaign,
  firstNameFromMailbox,
  sendingMailbox,
  nameFromVoicePrompt,
  resolveSignOffName,
  applySignOff,
};
