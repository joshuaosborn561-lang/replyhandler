/**
 * Hard validation of SmartLead outbound body + add_signature before POST.
 * Client pod inboxes must end with exactly one expected first-name sign-off and
 * must not carry agency branding or stacked closings/names in the body we send.
 */
const {
  isAgencySendingInbox,
  clientPodSignOffFirstName,
  nameKeysFromSendContext,
} = require('./smartlead-outbound-body');
const { resolveAgencySignatureContract } = require('./smartlead-agency-signature-contract');

const AGENCY_BRAND_LINE = /\bsales\s*glider\b/i;

const CLOSING_WORDS = /^(best|best regards|kind regards|warm regards|regards|thanks|thanks again|thank you|cheers|talk soon|speak soon|sincerely|all the best|appreciate it|looking forward)[,!.]?$/i;

class OutboundSignatureGuardError extends Error {
  constructor(code, message, userMessage) {
    super(message);
    this.name = 'OutboundSignatureGuardError';
    this.code = code || 'OUTBOUND_SIGNATURE_GUARD';
    this.userMessage = userMessage || message;
  }
}

function isOutboundSignatureGuardError(err) {
  return Boolean(err && (err instanceof OutboundSignatureGuardError || err.code === 'OUTBOUND_SIGNATURE_GUARD'));
}

function signatureGuardUserMessage(err) {
  if (isOutboundSignatureGuardError(err)) return String(err.userMessage || err.message || '').trim();
  return '';
}

function plainTextFromEmailBody(body) {
  let s = String(body || '');
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ');
  s = s.replace(/&amp;/gi, '&');
  s = s.replace(/&lt;/gi, '<');
  s = s.replace(/&gt;/gi, '>');
  return s.replace(/\n{3,}/g, '\n\n').trim();
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

function lineIsSenderFullName(line, nameKeys) {
  const t = String(line || '').trim();
  if (!t || t.length > 64 || /[.!?]/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  const lower = t.toLowerCase();
  return nameKeys.some((k) => k.length > 3 && lower.includes(k));
}

function collectTrailingSignOffLines(lines, nameKeys) {
  const collected = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = String(lines[i] || '').trim();
    if (!t) continue;
    if (
      CLOSING_WORDS.test(t)
      || AGENCY_BRAND_LINE.test(t)
      || lineIsBareName(t, nameKeys)
      || lineIsSenderFullName(t, nameKeys)
    ) {
      collected.unshift(t);
      continue;
    }
    break;
  }
  return collected;
}

function assertSendingInbox(sendingInboxEmail) {
  const inbox = String(sendingInboxEmail || '').trim();
  if (!inbox.includes('@')) {
    throw new OutboundSignatureGuardError(
      'MISSING_SENDING_INBOX',
      'SmartLead outbound signature guard: sending inbox email is required',
      'Signature check blocked send — could not identify the sending mailbox for this thread. Refresh thread context or retry from the card.',
    );
  }
  return inbox;
}

function validateAgencySignatureContractPlain(contractPlain, nameKeys) {
  const lines = String(contractPlain || '').replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    throw new OutboundSignatureGuardError(
      'AGENCY_SIGNATURE_CONTRACT_EMPTY',
      'Agency signature contract is empty',
      'Signature check blocked send — agency mailbox signature contract is empty. Configure SMARTLEAD_AGENCY_SIGNATURE_CONTRACT_JSON.',
    );
  }
  const lineCounts = new Map();
  for (const line of lines) {
    const k = line.toLowerCase();
    if (lineCounts.has(k)) {
      throw new OutboundSignatureGuardError(
        'AGENCY_SIGNATURE_CONTRACT_DUPLICATE',
        `Agency signature contract repeats line: ${line}`,
        'Signature check blocked send — agency mailbox signature contract has duplicate lines. Fix SMARTLEAD_AGENCY_SIGNATURE_CONTRACT_JSON.',
      );
    }
    lineCounts.set(k, true);
  }
  const bareNames = lines.filter((l) => lineIsBareName(l, nameKeys) || lineIsSenderFullName(l, nameKeys));
  const seen = new Set();
  for (const line of bareNames) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      throw new OutboundSignatureGuardError(
        'AGENCY_SIGNATURE_CONTRACT_DUPLICATE',
        `Agency signature contract has duplicate sender lines: ${line}`,
        'Signature check blocked send — agency mailbox signature contract has duplicate name lines. Fix SMARTLEAD_AGENCY_SIGNATURE_CONTRACT_JSON.',
      );
    }
    seen.add(key);
  }
  if (lines.some((l) => CLOSING_WORDS.test(l))) {
    throw new OutboundSignatureGuardError(
      'AGENCY_SIGNATURE_CONTRACT_CLOSING',
      'Agency signature contract must not include email closings',
      'Signature check blocked send — remove "Best," / "Thanks," from the agency signature contract.',
    );
  }
}

/** Simulated plain text after SmartLead appends the contracted mailbox signature. */
function simulateAgencyOutboundPlain(messagePlain, contractPlain) {
  const msg = String(messagePlain || '').trim();
  const sig = String(contractPlain || '').trim();
  if (!sig) return msg;
  return msg ? `${msg}\n\n${sig}` : sig;
}

function validateAgencyCombinedOutbound(messagePlain, contractPlain, nameKeys) {
  validateAgencySignatureContractPlain(contractPlain, nameKeys);
  const msgTrailing = collectTrailingSignOffLines(
    String(messagePlain || '').replace(/\r\n/g, '\n').split('\n'),
    nameKeys,
  );
  if (msgTrailing.length) {
    throw new OutboundSignatureGuardError(
      'AGENCY_BODY_SIGNOFF',
      `Agency outbound body still contains a draft sign-off: ${msgTrailing.join(' / ')}`,
      'Signature check blocked send — remove the draft sign-off so only the contracted mailbox signature appears once.',
    );
  }
  const combined = simulateAgencyOutboundPlain(messagePlain, contractPlain);
  const combinedLines = combined.split('\n');
  const trailing = collectTrailingSignOffLines(combinedLines, nameKeys);
  const sigLines = String(contractPlain || '').replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const sigSet = new Set(sigLines.map((l) => l.toLowerCase()));
  for (const line of trailing) {
    if (!sigSet.has(line.toLowerCase()) && !CLOSING_WORDS.test(line)) {
      throw new OutboundSignatureGuardError(
        'AGENCY_COMBINED_EXTRA_SIGNOFF',
        `Combined outbound has sign-off lines outside the contract: ${line}`,
        'Signature check blocked send — draft still contains extra sign-off lines beyond the contracted mailbox signature.',
      );
    }
  }
  if (!combined.endsWith(String(contractPlain || '').trim())) {
    throw new OutboundSignatureGuardError(
      'AGENCY_COMBINED_MISMATCH',
      'Combined outbound does not end with the contracted signature block',
      'Signature check blocked send — outbound body and signature contract do not combine cleanly.',
    );
  }
  return combined;
}

/**
 * @param {object} opts
 * @param {string} opts.plainBody - prepared plain text (pre-HTML)
 * @param {string} opts.emailBody - payload email_body (may be HTML)
 * @param {boolean} opts.addSignature - final add_signature flag
 * @param {object|null} opts.outboundClient
 * @param {string|null} opts.sendingInboxEmail
 * @param {string|null} [opts.agencySignatureContractPlain] - verified mailbox signature (agency only)
 */
function validateSmartleadOutboundSignature(opts = {}) {
  const inbox = assertSendingInbox(opts.sendingInboxEmail);
  const agency = isAgencySendingInbox(inbox);
  const addSignature = opts.addSignature === true;
  const plain = plainTextFromEmailBody(opts.plainBody || opts.emailBody || '');
  const rendered = plainTextFromEmailBody(opts.emailBody || opts.plainBody || '');
  if (plain !== rendered) {
    throw new OutboundSignatureGuardError(
      'PLAIN_HTML_MISMATCH',
      'SmartLead outbound signature guard: plain and HTML bodies diverge after formatting',
      'Signature check blocked send — outbound body formatting changed the sign-off. Edit the draft and try again.',
    );
  }
  const nameKeys = nameKeysFromSendContext(opts.outboundClient, inbox);
  const lines = rendered.replace(/\r\n/g, '\n').split('\n');
  const trailing = collectTrailingSignOffLines(lines, nameKeys);

  if (agency) {
    if (!addSignature) {
      throw new OutboundSignatureGuardError(
        'AGENCY_ADD_SIGNATURE_OFF',
        'Agency SmartLead inbox must use add_signature: true',
        'Signature check blocked send — agency mailbox expected SmartLead to append its signature. Nothing was sent.',
      );
    }
    if (lines.some((l) => AGENCY_BRAND_LINE.test(String(l || '').trim()))) {
      throw new OutboundSignatureGuardError(
        'AGENCY_BODY_BRAND',
        'Agency outbound body contains SalesGlider branding lines',
        'Signature check blocked send — remove SalesGlider branding from the draft body.',
      );
    }
    let contractPlain = String(opts.agencySignatureContractPlain || '').trim();
    if (!contractPlain) {
      const resolved = resolveAgencySignatureContract(inbox);
      contractPlain = resolved?.plainText || '';
    }
    if (!contractPlain) {
      throw new OutboundSignatureGuardError(
        'AGENCY_SIGNATURE_UNVERIFIED',
        `No verifiable agency signature contract for inbox ${inbox}`,
        'Signature check blocked send — agency mailbox signature is not configured for verification (SMARTLEAD_AGENCY_SIGNATURE_CONTRACT_JSON). Nothing was sent.',
      );
    }
    const combined = validateAgencyCombinedOutbound(plain, contractPlain, nameKeys);
    return {
      ok: true,
      mode: 'agency',
      addSignature: true,
      agencySignatureContractPlain: contractPlain,
      simulatedOutboundPlain: combined,
    };
  }

  if (addSignature) {
    throw new OutboundSignatureGuardError(
      'CLIENT_ADD_SIGNATURE_ON',
      'Client pod inbox must not use add_signature',
      'Signature check blocked send — client inbox must not request SmartLead add_signature (SalesGlider footer). Nothing was sent.',
    );
  }

  const expected = clientPodSignOffFirstName(opts.outboundClient, inbox);
  if (!expected) {
    throw new OutboundSignatureGuardError(
      'CANNOT_DERIVE_SIGNOFF',
      'Client pod send could not derive a single first-name sign-off',
      'Signature check blocked send — could not determine the sender first name for this client inbox. Fix client name or sending mailbox, then retry.',
    );
  }

  if (lines.some((l) => AGENCY_BRAND_LINE.test(String(l || '').trim()))) {
    throw new OutboundSignatureGuardError(
      'CLIENT_AGENCY_FOOTER',
      'Client pod outbound body contains SalesGlider branding',
      'Signature check blocked send — remove SalesGlider lines from the draft. Client sends must not include agency footer text.',
    );
  }

  const nameLines = trailing.filter((l) => lineIsBareName(l, nameKeys) || lineIsSenderFullName(l, nameKeys));
  const closings = trailing.filter((l) => CLOSING_WORDS.test(l));
  if (closings.length) {
    throw new OutboundSignatureGuardError(
      'CLIENT_CLOSING_LINE',
      `Client pod outbound still has a closing line: ${closings.join(', ')}`,
      'Signature check blocked send — use a single first-name sign-off only (no "Best," / "Thanks,"). Edit the draft and Approve again.',
    );
  }
  if (nameLines.length > 1) {
    throw new OutboundSignatureGuardError(
      'CLIENT_DUPLICATE_NAMES',
      `Client pod outbound has stacked sender name lines: ${nameLines.join(' / ')}`,
      'Signature check blocked send — remove duplicate name lines at the end of the draft (one "Jeremy" only).',
    );
  }
  if (!nameLines.length) {
    throw new OutboundSignatureGuardError(
      'CLIENT_MISSING_SIGNOFF',
      'Client pod outbound missing expected first-name sign-off',
      `Signature check blocked send — outbound must end with exactly "${expected}". Edit the draft or fix send prep, then Approve again.`,
    );
  }
  const lastName = nameLines[0];
  if (lastName.toLowerCase() !== expected.toLowerCase()) {
    throw new OutboundSignatureGuardError(
      'CLIENT_WRONG_SIGNOFF',
      `Client pod sign-off "${lastName}" does not match expected "${expected}"`,
      `Signature check blocked send — end with exactly "${expected}" (not "${lastName}").`,
    );
  }
  const lastLine = lines.filter((l) => String(l || '').trim()).pop();
  if (!lastLine || lastLine.trim().toLowerCase() !== expected.toLowerCase()) {
    throw new OutboundSignatureGuardError(
      'CLIENT_SIGNOFF_NOT_LAST',
      'Expected first-name sign-off is not the final line',
      `Signature check blocked send — the last line must be exactly "${expected}".`,
    );
  }

  return { ok: true, mode: 'client_pod', expectedSignOff: expected, addSignature: false };
}

module.exports = {
  OutboundSignatureGuardError,
  isOutboundSignatureGuardError,
  signatureGuardUserMessage,
  validateSmartleadOutboundSignature,
  plainTextFromEmailBody,
  collectTrailingSignOffLines,
  simulateAgencyOutboundPlain,
  validateAgencyCombinedOutbound,
  CLOSING_WORDS,
};
