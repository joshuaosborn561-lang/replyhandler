/**
 * Learned voice profiles — read side.
 *
 * The Friday job (`weekly-voice-learning.js`) writes one `voice_profiles` row
 * per scope per week. Drafting reads the latest global + client rows and
 * renders them as a prompt block. Everything here is best-effort: a missing
 * table, a DB hiccup, or an empty profile must never block a draft.
 */
const db = require('../db');

const CACHE_TTL_MS = (() => {
  const n = parseInt(process.env.LEARNED_VOICE_CACHE_MINUTES || '', 10);
  return (Number.isFinite(n) && n >= 0 ? n : 10) * 60 * 1000;
})();

const LIMITS = Object.freeze({
  voice_rules: 10,
  client_notes: 10,
  signature_phrases: 8,
  avoid: 6,
  itemChars: 180,
});

const PROFILE_KEYS = Object.freeze(['voice_rules', 'client_notes', 'signature_phrases', 'avoid']);

const cache = new Map();
let warnedUnavailable = false;

function learnedVoiceEnabled() {
  return !/^(1|true|yes|on)$/i.test(String(process.env.DISABLE_LEARNED_VOICE || '').trim());
}

function clearCache() {
  cache.clear();
}

/**
 * Coerce whatever the model returned into the four known arrays: strings
 * only, trimmed, deduped, URL-free, capped. Operational rules (booking link,
 * sign-off, principal voice) live in the drafting prompts, so a learned line
 * that tries to carry a URL is dropped rather than trusted.
 */
function sanitizeProfile(raw, { scope = 'client' } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of PROFILE_KEYS) {
    if (scope === 'global' && key === 'client_notes') { out[key] = []; continue; }
    const list = Array.isArray(src[key]) ? src[key] : [];
    const seen = new Set();
    const cleaned = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      let s = item.replace(/\s+/g, ' ').trim().replace(/^[-•*]\s*/, '');
      if (!s) continue;
      if (/https?:\/\/|www\./i.test(s)) continue;
      if (s.length > LIMITS.itemChars) s = `${s.slice(0, LIMITS.itemChars - 1).trim()}…`;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      cleaned.push(s);
      if (cleaned.length >= LIMITS[key]) break;
    }
    out[key] = cleaned;
  }
  return out;
}

function profileIsEmpty(profile) {
  if (!profile) return true;
  return PROFILE_KEYS.every((k) => !Array.isArray(profile[k]) || profile[k].length === 0);
}

function mergeUnique(primary, secondary, cap) {
  const seen = new Set();
  const out = [];
  for (const item of [...(primary || []), ...(secondary || [])]) {
    const k = String(item).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Prompt block. Client-specific lines come first because they are the more
 * specific signal; the global profile fills in the rest.
 */
function renderLearnedVoiceBlock({ global, client, clientName } = {}) {
  const g = sanitizeProfile(global, { scope: 'global' });
  const c = sanitizeProfile(client, { scope: 'client' });
  if (profileIsEmpty(g) && profileIsEmpty(c)) return '';

  const rules = mergeUnique(c.voice_rules, g.voice_rules, 12);
  const phrases = mergeUnique(c.signature_phrases, g.signature_phrases, 10);
  const avoid = mergeUnique(c.avoid, g.avoid, 8);
  const notes = c.client_notes;

  const lines = [
    'LEARNED VOICE (refreshed weekly from replies Josh actually sent — Slack-approved, Slack-edited, and manual SmartLead/HeyReach replies). Style guidance only: the operational rules in this prompt still win.',
  ];
  if (rules.length) {
    lines.push(...rules.map((r) => `- ${r}`));
  }
  if (phrases.length) {
    lines.push(`PHRASES JOSH ACTUALLY USES: ${phrases.map((p) => `"${p.replace(/^"|"$/g, '')}"`).join(', ')}`);
  }
  if (avoid.length) {
    lines.push('AVOID (Josh removes these from drafts):');
    lines.push(...avoid.map((a) => `- ${a}`));
  }
  if (notes.length) {
    const label = clientName ? ` — ${clientName}` : '';
    lines.push(`CLIENT NOTES${label} (learned from this client's own sent replies; rely on these, do not invent beyond them):`);
    lines.push(...notes.map((n) => `- ${n}`));
  }
  return lines.join('\n');
}

async function latestProfileRow({ scope, clientId = null }) {
  const { rows } = await db.query(
    `SELECT scope, client_id, week_ending, profile, examples_used, edited_used, manual_used, model, created_at
       FROM voice_profiles
      WHERE scope = $1
        AND (($1 = 'global') OR client_id = $2)
      ORDER BY week_ending DESC, created_at DESC
      LIMIT 1`,
    [scope, clientId]
  );
  return rows[0] || null;
}

async function resolveClientId({ clientId, clientName }) {
  if (clientId && /^[0-9a-f-]{36}$/i.test(String(clientId))) return String(clientId);
  if (!clientName) return null;
  const { rows } = await db.query(
    `SELECT id FROM clients WHERE lower(name) = lower($1) ORDER BY active DESC NULLS LAST LIMIT 1`,
    [String(clientName).trim()]
  );
  return rows[0]?.id || null;
}

/**
 * @returns {Promise<{ block: string, global: object|null, client: object|null }>}
 */
async function loadLearnedVoice({ clientId = null, clientName = null } = {}) {
  const empty = { block: '', global: null, client: null };
  if (!learnedVoiceEnabled()) return empty;

  const key = `${clientId || ''}|${String(clientName || '').toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  try {
    const resolvedClientId = await resolveClientId({ clientId, clientName });
    const [globalRow, clientRow] = await Promise.all([
      latestProfileRow({ scope: 'global' }),
      resolvedClientId ? latestProfileRow({ scope: 'client', clientId: resolvedClientId }) : null,
    ]);
    const value = {
      block: renderLearnedVoiceBlock({
        global: globalRow?.profile,
        client: clientRow?.profile,
        clientName,
      }),
      global: globalRow || null,
      client: clientRow || null,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    // Table not migrated yet, or DB blip. Draft without it.
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn('[LearnedVoice] Profiles unavailable — drafting without learned voice', { err: err.message });
    }
    cache.set(key, { at: Date.now(), value: empty });
    return empty;
  }
}

async function loadLearnedVoiceBlock(opts) {
  const { block } = await loadLearnedVoice(opts);
  return block;
}

module.exports = {
  LIMITS,
  PROFILE_KEYS,
  learnedVoiceEnabled,
  sanitizeProfile,
  profileIsEmpty,
  renderLearnedVoiceBlock,
  loadLearnedVoice,
  loadLearnedVoiceBlock,
  clearCache,
};
