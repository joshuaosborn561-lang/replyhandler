'use strict';

/**
 * Veriphone phone check (veriphone.io, /v3/verify). Josh, Oct 29 2026: confirm
 * phones with Veriphone instead of trusting the waterfall, which never returns
 * phone_valid. One standard validation = 1 credit (about $0.0004 on a pack, free
 * under 1,000 a month). Never throws: any failure is { ok: false, reason } and the
 * caller falls back to "not a confirmed mobile". Never logs the key or the number.
 */

const VERIPHONE_URL = 'https://api.veriphone.io/v3/verify';
const TIMEOUT_MS = 6000;

function apiKey(env = process.env) {
  return String(env.VERIPHONE_API_KEY || '').trim();
}

function isConfigured(env = process.env) {
  return Boolean(apiKey(env));
}

/** US/CA 10-digit and 1+10-digit numbers become +E.164. Anything else is passed through. */
function toE164(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('+')) return `+${s.replace(/\D/g, '')}`;
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : '';
}

/**
 * Card label for a Veriphone phone_type.
 * 'mobile' is the only type that counts as a confirmed mobile.
 */
function labelForType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (t === 'mobile') return 'mobile';
  if (t === 'fixed_line') return 'landline';
  if (t === 'fixed_line_or_mobile') return 'landline or mobile';
  if (t === 'voip') return 'VoIP';
  if (t === 'toll_free') return 'toll-free';
  return t ? t.replace(/_/g, ' ') : 'unverified';
}

/**
 * @returns {Promise<{ok:boolean, valid:boolean|null, type:string|null, label:string,
 *   carrier:string|null, e164:string|null, reason:string|null}>}
 */
async function verifyPhone(phone, { fetchImpl = fetch, env = process.env } = {}) {
  const fail = (reason) => ({
    ok: false, valid: null, type: null, label: 'unverified', carrier: null, e164: null, reason,
  });
  const key = apiKey(env);
  if (!key) return fail('veriphone_key_unset');
  const number = toE164(phone);
  if (!number) return fail('no_phone');
  try {
    const url = `${VERIPHONE_URL}?phone=${encodeURIComponent(number)}&default_country=US`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return fail(`veriphone_http_${res.status}`);
    const body = await res.json().catch(() => null);
    if (!body || body.status !== 'success') return fail('veriphone_bad_body');
    const valid = body.phone_valid === true;
    if (!valid) {
      return {
        ok: true, valid: false, type: null, label: 'invalid', carrier: null,
        e164: body.e164 || number, reason: null,
      };
    }
    const type = String(body.phone_type || '').trim().toLowerCase() || null;
    return {
      ok: true,
      valid: true,
      type,
      label: labelForType(type),
      carrier: body.carrier || null,
      e164: body.e164 || number,
      reason: null,
    };
  } catch (err) {
    return fail(err && err.name === 'TimeoutError' ? 'veriphone_timeout' : 'veriphone_error');
  }
}

module.exports = { verifyPhone, isConfigured, toE164, labelForType, VERIPHONE_URL };
