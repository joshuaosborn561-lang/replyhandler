/**
 * Map an Allo call to a ReplyHandler client.
 *
 * Mesa Energy's line is the one known default: (916) 270-1857. SalesGlider,
 * Deep Roots, and anyone else come from env so a new client is a config
 * change, not a code change.
 *
 * ALLO_NUMBER_CLIENT_MAP — JSON object of phone → clients.name
 *   {"19162701857":"Mesa Energy","12145550100":"SalesGlider"}
 * ALLO_USER_CLIENT_MAP — JSON object of Allo user email → clients.name
 *   {"gabe@example.com":"Mesa Energy"}
 */

const { phoneKey, normalizeE164 } = require('../services/allo');

/** Last-10-digit key → default client display name. */
const DEFAULT_NUMBER_CLIENTS = Object.freeze({
  '9162701857': 'Mesa Energy',
});

function parseJsonMap(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const name = String(v || '').trim();
      if (k && name) out[String(k).trim()] = name;
    }
    return out;
  } catch {
    console.warn('[AlloMap] Ignoring invalid JSON map');
    return {};
  }
}

function numberClientMap(env = process.env) {
  const out = { ...DEFAULT_NUMBER_CLIENTS };
  const extra = parseJsonMap(env.ALLO_NUMBER_CLIENT_MAP);
  for (const [k, name] of Object.entries(extra)) {
    const key = phoneKey(k) || String(k).replace(/\D/g, '').slice(-10);
    if (key) out[key] = name;
  }
  return out;
}

function userClientMap(env = process.env) {
  const extra = parseJsonMap(env.ALLO_USER_CLIENT_MAP);
  const out = {};
  for (const [k, name] of Object.entries(extra)) {
    const email = String(k || '').trim().toLowerCase();
    if (email) out[email] = name;
  }
  return out;
}

function alloNumberFromCall(call = {}) {
  const type = String(call.type || call.direction || '').toUpperCase();
  if (type === 'OUTBOUND') {
    return call.from_number || call.from || call.allo_number || null;
  }
  if (type === 'INBOUND') {
    return call.to || call.to_number || call.allo_number || call.original_to_number || null;
  }
  return call.allo_number || call.to || call.to_number || call.from_number || null;
}

function prospectNumberFromCall(call = {}) {
  const type = String(call.type || call.direction || '').toUpperCase();
  if (type === 'OUTBOUND') {
    return call.to || call.to_number || call.contact_number || null;
  }
  if (type === 'INBOUND') {
    return call.from_number || call.from || call.contact_number || null;
  }
  return call.contact_number || call.from_number || call.to || null;
}

function userEmailFromCall(call = {}, event = {}) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  return String(
    call.user_email
    || call.user?.email
    || data.user_email
    || ''
  ).trim().toLowerCase();
}

/**
 * Resolve which client this call belongs to, without hitting the DB.
 * @returns {{ clientName: string, via: string, alloNumber: string, prospectNumber: string } | null}
 */
function resolveClientHint(call = {}, event = {}, env = process.env) {
  const alloNumber = alloNumberFromCall(call) || alloNumberFromCall(event.data || {});
  const prospectNumber = prospectNumberFromCall(call) || prospectNumberFromCall(event.data || {});
  const numbers = numberClientMap(env);
  const alloKey = phoneKey(alloNumber);
  if (alloKey && numbers[alloKey]) {
    return {
      clientName: numbers[alloKey],
      via: 'allo_number',
      alloNumber: normalizeE164(alloNumber) || alloNumber,
      prospectNumber: normalizeE164(prospectNumber) || prospectNumber,
    };
  }

  const users = userClientMap(env);
  const email = userEmailFromCall(call, event);
  if (email && users[email]) {
    return {
      clientName: users[email],
      via: 'user_email',
      alloNumber: normalizeE164(alloNumber) || alloNumber,
      prospectNumber: normalizeE164(prospectNumber) || prospectNumber,
    };
  }

  return {
    clientName: null,
    via: null,
    alloNumber: normalizeE164(alloNumber) || alloNumber || '',
    prospectNumber: normalizeE164(prospectNumber) || prospectNumber || '',
  };
}

module.exports = {
  DEFAULT_NUMBER_CLIENTS,
  MESA_ENERGY_NUMBER: '9162701857',
  parseJsonMap,
  numberClientMap,
  userClientMap,
  alloNumberFromCall,
  prospectNumberFromCall,
  userEmailFromCall,
  resolveClientHint,
};
