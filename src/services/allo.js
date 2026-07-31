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

function alloNumber() {
  return normalizeE164(process.env.ALLO_PHONE_NUMBER);
}

function isConfigured() {
  return Boolean(apiKey() && alloNumber());
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
  const from = alloNumber();
  if (!from) throw new Error('ALLO_PHONE_NUMBER not set');
  const contact = normalizeE164(contactNumber);
  if (!contact) return [];

  const data = await alloFetch('/calls', {
    allo_number: from,
    contact_number: contact,
    page,
    size,
  });
  const results = data?.data?.results;
  return Array.isArray(results) ? results : [];
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
  alloNumber,
};
