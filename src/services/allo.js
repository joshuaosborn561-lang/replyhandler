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

function apiKey() {
  return String(process.env.ALLO_API_KEY || '').trim();
}

/**
 * Every Allo number we own. Calls are searched across all of them, because a
 * prospect may have been dialled from either line.
 * ALLO_PHONE_NUMBERS takes a comma / semicolon / newline separated list;
 * ALLO_PHONE_NUMBER stays supported for a single line.
 */
function alloNumbers() {
  const raw = process.env.ALLO_PHONE_NUMBERS || process.env.ALLO_PHONE_NUMBER || '';
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(/[,;\n]+/)) {
    const n = normalizeE164(part);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function isConfigured() {
  return Boolean(apiKey() && alloNumbers().length);
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
async function searchCalls(contactNumber, { page, size = 20 } = {}) {
  const numbers = alloNumbers();
  if (!numbers.length) throw new Error('ALLO_PHONE_NUMBERS not set');
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
        // Same call can surface under either line; key on id, fall back to a
        // composite so an id-less row is not silently dropped.
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
  transcriptText,
  normalizeE164,
  alloNumbers,
};
