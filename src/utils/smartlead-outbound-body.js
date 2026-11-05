/**
 * SmartLead outbound reply body — global rules for every client inbox:
 *
 * 1. Strip draft sign-offs before send so SmartLead add_signature does not stack names.
 * 2. Client pod sending inboxes (not our agency domains) skip add_signature so
 *    SmartLead does not append the agency SalesGlider footer block.
 * 3. Agency / SalesGlider sending inboxes keep add_signature after the draft is cleaned.
 */
const { stripSignOff } = require('../services/classifier');
const { isOwnAddress } = require('./own-addresses');

const AGENCY_BRAND_LINE = /\bsales\s*glider\b/i;

function firstNameKeys(name) {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const keys = new Set();
  keys.add(raw.toLowerCase());
  const first = raw.split(/\s+/)[0];
  if (first && first.length > 1) keys.add(first.toLowerCase());
  return [...keys];
}

/** Tokens from client display name and the sending mailbox local part. */
function nameKeysFromSendContext(client, sendingInboxEmail) {
  const keys = new Set();
  for (const word of String(client?.name || '').replace(/[^a-zA-Z\s'-]/g, ' ').split(/\s+/)) {
    for (const k of firstNameKeys(word)) keys.add(k);
  }
  const local = String(sendingInboxEmail || '').trim().toLowerCase().split('@')[0] || '';
  for (const part of local.split(/[._-]+/)) {
    if (part.length > 2) keys.add(part);
  }
  return [...keys];
}

function lineIsBareName(line, nameKeys) {
  const t = String(line || '').trim();
  if (!t || t.length > 48) return false;
  if (/[.!?]/.test(t)) return false;
  const lower = t.toLowerCase();
  if (nameKeys.some((k) => lower === k)) return true;
  if (/^[A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,2}$/u.test(t)) {
    const first = t.split(/\s+/)[0].toLowerCase();
    return nameKeys.some((k) => k === first || k.startsWith(first) || first.startsWith(k));
  }
  return false;
}

function stripTrailingSenderNameLines(text, nameKeys) {
  if (!nameKeys.length) return String(text || '').trim();
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  for (let guard = 0; guard < 6; guard += 1) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) break;
    const last = lines[lines.length - 1].trim();
    if (lineIsBareName(last, nameKeys)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripTrailingAgencyBrandingLines(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  for (let guard = 0; guard < 4; guard += 1) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) break;
    const last = lines[lines.length - 1].trim();
    if (AGENCY_BRAND_LINE.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isAgencySendingInbox(sendingInboxEmail) {
  const inbox = String(sendingInboxEmail || '').trim();
  if (!inbox.includes('@')) return false;
  return isOwnAddress(inbox);
}

/**
 * Plain-text body for SmartLead reply-email-thread (before optional HTML wrap).
 */
function prepareSmartleadReplyText(text, { client, sendingInboxEmail } = {}) {
  let body = stripSignOff(text);
  const nameKeys = nameKeysFromSendContext(client, sendingInboxEmail);
  body = stripTrailingSenderNameLines(body, nameKeys);
  body = stripTrailingAgencyBrandingLines(body);
  return body;
}

/**
 * Whether SmartLead should append the connected mailbox signature on send.
 * Client pod inboxes: false (avoids agency SalesGlider footer). Agency inboxes: true
 * after draft sign-off stripping so the signature appears once.
 */
function shouldAppendSmartleadMailboxSignature({ sendingInboxEmail } = {}) {
  return isAgencySendingInbox(sendingInboxEmail);
}

function draftSignOffWasStripped(rawText, preparedText) {
  const raw = String(rawText || '').trim();
  const prep = String(preparedText || '').trim();
  return prep.length < raw.length;
}

module.exports = {
  isAgencySendingInbox,
  prepareSmartleadReplyText,
  shouldAppendSmartleadMailboxSignature,
  stripTrailingSenderNameLines,
  stripTrailingAgencyBrandingLines,
  nameKeysFromSendContext,
  draftSignOffWasStripped,
};
