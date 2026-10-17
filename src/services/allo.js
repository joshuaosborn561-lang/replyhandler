/**
 * Allo (withallo.com) — AI business phone.
 *
 * Allo transcribes and summarises calls itself, so we never download or
 * transcribe its audio: /calls returns `transcript` and `summary` inline.
 *
 * @see https://help.withallo.com/en/api-reference/introduction
 * Auth is the raw API key in the Authorization header — no "Bearer " prefix.
 * The key needs the CONVERSATIONS_READ scope.
 */

const BASE_URL = process.env.ALLO_BASE_URL || 'https://api.withallo.com/v1/api';
const V2_BASE_URL = process.env.ALLO_V2_BASE_URL || 'https://api.withallo.com/v2/api';

function apiKey() {
  return String(process.env.ALLO_API_KEY || '').trim();
}

/** Numbers pinned by env, if any. Overrides discovery. */
function configuredNumbers() {
  const raw = process.env.ALLO_PHONE_NUMBERS || process.env.ALLO_PHONE_NUMBER || '';
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(/[,;\n]+/)) {
    const n = normalizeE164(part);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

let numberCache = { at: 0, numbers: [] };
const NUMBER_TTL_MS = 60 * 60 * 1000;

/**
 * Every Allo line on the account. Calls are searched across all of them,
 * because a prospect may have been dialled from either.
 *
 * Discovered from GET /numbers rather than configured by hand — the API key
 * already scopes to the account, so a new line is picked up automatically.
 * Set ALLO_PHONE_NUMBERS to pin a specific subset instead.
 */
async function alloNumbers() {
  const pinned = configuredNumbers();
  if (pinned.length) return pinned;
  if (!apiKey()) return [];

  if (numberCache.numbers.length && Date.now() - numberCache.at < NUMBER_TTL_MS) {
    return numberCache.numbers;
  }

  try {
    const data = await alloFetch('/numbers');
    const list = Array.isArray(data?.data) ? data.data : [];
    const seen = new Set();
    const out = [];
    for (const row of list) {
      const n = normalizeE164(row?.number);
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    numberCache = { at: Date.now(), numbers: out };
    console.log('[Allo] Discovered numbers', {
      count: out.length,
      numbers: out,
      names: list.map((r) => r?.name).filter(Boolean),
    });
    return out;
  } catch (err) {
    console.warn('[Allo] Could not list numbers', { err: err.message });
    // Keep any previously discovered set rather than going dark on a blip.
    return numberCache.numbers;
  }
}

/** Cheap check — number discovery happens lazily on first use. */
function isConfigured() {
  return Boolean(apiKey());
}

/** Allo requires E.164. Assume North America when a bare 10-digit number arrives. */
function normalizeE164(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

async function alloFetch(path, params = {}) {
  const key = apiKey();
  if (!key) throw new Error('ALLO_API_KEY not set');

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v) !== '') qs.set(k, String(v));
  }

  const res = await fetch(`${BASE_URL}${path}?${qs}`, {
    headers: { Authorization: key, Accept: 'application/json' },
  });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(`Allo ${res.status}: ${body.slice(0, 200)} — does the API key have CONVERSATIONS_READ?`);
    }
    throw new Error(`Allo ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  try { return JSON.parse(body); } catch { return {}; }
}

/**
 * Calls between our Allo number and one contact number.
 * @returns {Promise<Array>} Call objects: { id, type, start_date, summary, transcript[], recording_url }
 */
/** Last 10 digits — enough to match +1 / bare / formatted variants. */
function phoneKey(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

/** True when this call involves the prospect number (to or from). */
function callInvolvesContact(call, contactE164) {
  const want = phoneKey(contactE164);
  if (!want) return false;
  const candidates = [
    call?.to_number, call?.to, call?.from_number, call?.from,
    call?.contact_number, call?.contact, call?.external_number,
  ];
  return candidates.some((n) => phoneKey(n) === want);
}

async function searchCalls(contactNumber, { page, size = 20 } = {}) {
  const numbers = await alloNumbers();
  if (!numbers.length) throw new Error('No Allo numbers available (discovery failed and ALLO_PHONE_NUMBERS unset)');
  const contact = normalizeE164(contactNumber);
  if (!contact) return [];

  const byId = new Map();
  const failures = [];

  for (const from of numbers) {
    try {
      const data = await alloFetch('/calls', {
        allo_number: from,
        contact_number: contact,
        page,
        size,
      });
      const results = data?.data?.results;
      for (const call of Array.isArray(results) ? results : []) {
        // Allo has been observed returning the account's recent call list while
        // ignoring contact_number — filter client-side so we never judge a
        // different prospect's transcript as "booked" for this lead.
        if (!callInvolvesContact(call, contact)) continue;
        const key = call?.id || `${from}|${call?.start_date}|${call?.to_number}`;
        if (!byId.has(key)) byId.set(key, { ...call, allo_number: from });
      }
    } catch (err) {
      failures.push(`${from}: ${err.message}`);
    }
  }

  // Only surface an error when every line failed — one bad line should not
  // hide calls found on the other.
  if (!byId.size && failures.length === numbers.length) {
    throw new Error(`Allo /calls failed for all numbers — ${failures.join('; ')}`);
  }
  if (failures.length) {
    console.warn('[Allo] Some numbers failed', { failures });
  }

  return [...byId.values()].sort(
    (a, b) => new Date(b?.start_date || 0) - new Date(a?.start_date || 0)
  );
}

async function alloFetchV2(path, params = {}) {
  const key = apiKey();
  if (!key) throw new Error('ALLO_API_KEY not set');

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v) !== '') qs.set(k, String(v));
  }
  const url = qs.toString() ? `${V2_BASE_URL}${path}?${qs}` : `${V2_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: key, Accept: 'application/json' },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Allo ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  try { return JSON.parse(body); } catch { return {}; }
}

/**
 * Full call record for a webhook that only sent an id (tag.added).
 * Tries v2 conversation items, then v1 /calls/:id.
 */
async function getCallById(callId) {
  const id = String(callId || '').trim();
  if (!id) return null;
  const candidates = [id];
  if (id.startsWith('cll_')) candidates.push(`cll-${id.slice(4)}`);
  if (id.startsWith('cll-')) candidates.push(`cll_${id.slice(4)}`);

  for (const candidate of candidates) {
    try {
      const data = await alloFetchV2(`/conversations/items/${encodeURIComponent(candidate)}`, {
        extend: 'transcript',
      });
      const item = data?.data || data;
      if (item && (item.id || item.summary || item.transcript || item.tags)) {
        return {
          ...item,
          from_number: item.from_number || (item.direction === 'INBOUND' ? item.contact_number : item.allo_number),
          to: item.to || item.to_number || (item.direction === 'OUTBOUND' ? item.contact_number : item.allo_number),
          type: item.type === 'CALL' ? item.direction : item.type,
          user_email: item.user_email || item.user?.email || null,
        };
      }
    } catch (err) {
      console.warn('[Allo] v2 get-item failed', { id: candidate, err: err.message });
    }
  }

  for (const candidate of candidates) {
    try {
      const data = await alloFetch(`/calls/${encodeURIComponent(candidate)}`);
      const call = data?.data || data;
      if (call && (call.id || call.summary)) return call;
    } catch (err) {
      console.warn('[Allo] v1 get-call failed', { id: candidate, err: err.message });
    }
  }
  return null;
}

/** Flatten a call's transcript turns into plain text. */
function transcriptText(call) {
  const turns = Array.isArray(call?.transcript) ? call.transcript : [];
  const lines = turns
    .map((t) => {
      const who = String(t?.source || '').toUpperCase() === 'EXTERNAL' ? 'Prospect' : 'Us';
      const text = String(t?.text || '').trim();
      return text ? `${who}: ${text}` : '';
    })
    .filter(Boolean);
  const summary = String(call?.summary || '').trim();
  return [summary && `Summary: ${summary}`, ...lines].filter(Boolean).join('\n');
}

module.exports = {
  isConfigured,
  searchCalls,
  getCallById,
  transcriptText,
  normalizeE164,
  phoneKey,
  callInvolvesContact,
  alloNumbers,
  configuredNumbers,
};
