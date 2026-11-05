/**
 * SmartLead outbound reply body — global rules for every client inbox:
 *
 * 1. Strip draft sign-offs before send so SmartLead add_signature does not stack names.
 * 2. Client pod sending inboxes (not our agency domains) skip add_signature so
 *    SmartLead does not append the agency SalesGlider footer block, and append
 *    exactly one bare first-name sign-off on the cleaned body.
 * 3. Agency / SalesGlider sending inboxes keep add_signature after the draft is cleaned.
 */
const { stripSignOff } = require('../services/classifier');
const { firstNameFromEmail } = require('./first-name');
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

const COMPANY_NAME_TAIL = new Set([
  'tech', 'technologies', 'technology', 'group', 'growth', 'energy', 'partners', 'partner',
  'solutions', 'services', 'service', 'consulting', 'holdings', 'inc', 'llc', 'ltd', 'co',
  'company', 'corp', 'corporation', 'ventures', 'capital', 'media', 'digital', 'software',
]);

/** Person-style client display name (e.g. Jeremy Ciotola), not company-style (Parlay Tech). */
function personStyleClientFirstName(clientName) {
  const parts = String(clientName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return '';
  const first = parts[0];
  const second = parts[1];
  if (COMPANY_NAME_TAIL.has(second.replace(/[^a-z]/gi, '').toLowerCase())) return '';
  if (!/^[A-Za-z]/.test(first) || !/^[A-Za-z]/.test(second)) return '';
  if (first.length < 2 || second.length < 2) return '';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Bare first-name line for client pod sends when SmartLead add_signature is off.
 * Prefer person-style client.name; otherwise the sending mailbox local part (Myles@…).
 */
function clientPodSignOffFirstName(client, sendingInboxEmail) {
  if (isAgencySendingInbox(sendingInboxEmail)) return '';
  const fromClient = personStyleClientFirstName(client?.name);
  if (fromClient) return fromClient;
  return firstNameFromEmail(sendingInboxEmail) || '';
}

function bodyEndsWithBareNameLine(body, name) {
  const target = String(name || '').trim();
  if (!target) return false;
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return false;
  return lines[lines.length - 1].trim().toLowerCase() === target.toLowerCase();
}

function appendClientPodSignOff(body, signOffName) {
  const trimmed = String(body || '').trim();
  const name = String(signOffName || '').trim();
  if (!name) return trimmed;
  if (bodyEndsWithBareNameLine(trimmed, name)) return trimmed;
  return trimmed ? `${trimmed}\n\n${name}` : name;
}

/**
 * Plain-text body for SmartLead reply-email-thread (before optional HTML wrap).
 */
function prepareSmartleadReplyText(text, { client, sendingInboxEmail } = {}) {
  let body = stripSignOff(text);
  const nameKeys = nameKeysFromSendContext(client, sendingInboxEmail);
  body = stripTrailingSenderNameLines(body, nameKeys);
  body = stripTrailingAgencyBrandingLines(body);
  if (!isAgencySendingInbox(sendingInboxEmail)) {
    body = appendClientPodSignOff(body, clientPodSignOffFirstName(client, sendingInboxEmail));
  }
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
  clientPodSignOffFirstName,
  prepareSmartleadReplyText,
  shouldAppendSmartleadMailboxSignature,
  stripTrailingSenderNameLines,
  stripTrailingAgencyBrandingLines,
  nameKeysFromSendContext,
  draftSignOffWasStripped,
};
