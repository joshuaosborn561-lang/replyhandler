/**
 * Verifiable plain-text SmartLead mailbox signatures for agency (isOwnAddress) sends
 * when add_signature: true. Without a contract entry for the sending inbox, agency
 * sends fail closed — we do not assume SmartLead's appended HTML is clean.
 *
 * Distinct from retired SMARTLEAD_SENDER_GUARD_* (cross-client scan). This is only
 * the outbound pre-POST combine-body check for agency mailboxes we operate.
 */
const { nameKeysFromSendContext } = require('./smartlead-outbound-body');

let parsedCache = { raw: null, map: null };

function normalizeInbox(email) {
  return String(email || '').trim().toLowerCase();
}

function parseContractEnv(env = process.env) {
  const raw = String(env.SMARTLEAD_AGENCY_SIGNATURE_CONTRACT_JSON || '').trim();
  if (parsedCache.raw === raw) return parsedCache.map;
  parsedCache.raw = raw;
  if (!raw) {
    parsedCache.map = new Map();
    return parsedCache.map;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    parsedCache.map = null;
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    parsedCache.map = null;
    return null;
  }
  const map = new Map();
  for (const [k, v] of Object.entries(obj)) {
    const inbox = normalizeInbox(k);
    const plain = String(v ?? '').replace(/\r\n/g, '\n').trim();
    if (inbox.includes('@') && plain) map.set(inbox, plain);
  }
  parsedCache.map = map;
  return map;
}

/** @returns {{ plainText: string, inbox: string } | null} */
function resolveAgencySignatureContract(sendingInboxEmail, env = process.env) {
  const inbox = normalizeInbox(sendingInboxEmail);
  if (!inbox.includes('@')) return null;
  const map = parseContractEnv(env);
  if (!map) return null;
  const plainText = map.get(inbox);
  if (!plainText) return null;
  return { plainText, inbox };
}

function resetAgencySignatureContractCacheForTests() {
  parsedCache = { raw: null, map: null };
}

module.exports = {
  resolveAgencySignatureContract,
  parseContractEnv,
  resetAgencySignatureContractCacheForTests,
};
