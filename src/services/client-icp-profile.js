const { geminiModel } = require('./gemini-model');
/**
 * Auto-build a client ICP profile from Josh's Fireflies call transcripts.
 *
 * ReplyHandler grades Slack-card ICP via loadVariant() → topup.icp_variants
 * or DEFAULT_CLIENT_VARIANTS. New clients have neither. This writes a
 * fact-grounded profile onto clients.icp_profile, which loadVariant reads.
 *
 * Extraction uses only facts in the transcripts (PR #97 FACT_GROUNDING_RULES).
 * No matching calls, missing FIREFLIES_API_KEY, or no grounded facts →
 * icp_status = needs_review.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fireflies = require('./fireflies');
const { DEFAULT_CLIENT_VARIANTS, CLIENT_TAG_ALIASES } = require('./reply-icp-variants');
const { clientTagFor } = require('./prospect-enrich');
const {
  FACT_GROUNDING_RULES,
  findUnsupportedClaims,
  containsWholeTerm,
} = require('../utils/draft-fact-check');

const ICP_FIELDS = Object.freeze([
  'industries', 'titles', 'company_size', 'geos', 'offer', 'exclusions',
]);

const SKIP_DOMAINS = /^(calendly\.com|book\.gosalesglider\.com|gosalesglider\.com|salesglider\.com|salesglidergrowth\.com|gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com)$/i;

function emptyProfile() {
  return {
    industries: [],
    titles: [],
    company_size: [],
    geos: [],
    offer: [],
    exclusions: [],
  };
}

function resolveClientTag(raw) {
  const slug = clientTagFor(raw);
  return CLIENT_TAG_ALIASES[slug] || slug;
}

function domainFromWebsite(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const url = /^https?:\/\//i.test(s) ? s : (s.includes('.') && !s.includes(' ') ? `https://${s}` : '');
  if (!url) return '';
  const host = url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase().replace(/^www\./, '');
  if (!host || SKIP_DOMAINS.test(host)) return '';
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return '';
  return host;
}

function emailDomain(raw) {
  const m = String(raw || '').match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

function clientSearchHints(client) {
  const name = String(client?.name || '').trim();
  const domains = new Set();
  for (const field of ['booking_link', 'booking_destination_url']) {
    const d = domainFromWebsite(client?.[field]);
    if (d && !SKIP_DOMAINS.test(d)) domains.add(d);
  }
  for (const field of ['contact_email', 'cc_email', 'cc_emails']) {
    for (const part of String(client?.[field] || '').split(/[\n,;]+/)) {
      const d = emailDomain(part);
      if (d && !SKIP_DOMAINS.test(d)) domains.add(d);
    }
  }
  return { name, domains: [...domains] };
}

function hasDefaultVariant(client) {
  const tag = resolveClientTag(client?.name);
  return Boolean(DEFAULT_CLIENT_VARIANTS[tag]);
}

function hasStoredProfile(client) {
  return String(client?.icp_status || '') === 'ready'
    && client?.icp_profile
    && typeof client.icp_profile === 'object';
}

function clientHasIcp(client) {
  return hasDefaultVariant(client) || hasStoredProfile(client);
}

function profileHasFacts(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return ICP_FIELDS.some((f) => Array.isArray(profile[f]) && profile[f].length);
}

function normalizeProfile(raw) {
  const out = emptyProfile();
  if (!raw || typeof raw !== 'object') return out;
  for (const field of ICP_FIELDS) {
    const v = raw[field];
    if (Array.isArray(v)) {
      out[field] = v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12);
    } else if (typeof v === 'string' && v.trim()) {
      out[field] = v.split(/[,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
    }
  }
  return out;
}

function itemSupportedByTranscript(item, sourceText) {
  const text = String(item || '').trim();
  if (!text) return false;
  if (findUnsupportedClaims(text, sourceText).length) return false;
  if (containsWholeTerm(sourceText, text)) return true;
  const tokens = text
    .split(/\s+/)
    .map((t) => t.replace(/[.,;:!?]+$/g, ''))
    .filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  return tokens.every((tok) => containsWholeTerm(sourceText, tok));
}

/**
 * Drop any extracted phrase that is not in the transcript text, or that
 * introduces a location/number/proper noun the transcript never said
 * (same verifier as draft fact-check).
 */
function groundIcpProfile(profile, sourceText) {
  const grounded = emptyProfile();
  for (const field of ICP_FIELDS) {
    const items = Array.isArray(profile?.[field]) ? profile[field] : [];
    for (const item of items) {
      const text = String(item || '').trim();
      if (!itemSupportedByTranscript(text, sourceText)) continue;
      grounded[field].push(text);
    }
  }
  return grounded;
}

function profileToVariantSpec(profile) {
  const p = normalizeProfile(profile);
  if (!profileHasFacts(p)) return null;
  const fit = [];
  if (p.industries.length) fit.push(`industries: ${p.industries.join(', ')}`);
  if (p.titles.length) fit.push(`buyer titles: ${p.titles.join(', ')}`);
  if (p.company_size.length) fit.push(`company size: ${p.company_size.join(', ')}`);
  if (p.geos.length) fit.push(`geos: ${p.geos.join(', ')}`);
  const offer = p.offer.length ? p.offer.join('; ') : 'the offer described in the stored ICP';
  const exclusions = p.exclusions.length
    ? p.exclusions.join(', ')
    : 'does not match the ICP facts above';
  return {
    pass: 'icp_fit',
    instructions: (
      `We sell ${offer}. Which best describes this company, based on its website? ` +
      `Use only the ICP facts given. Do not invent industries, titles, size, or geos.`
    ),
    criteria: {
      icp_fit: `Fits the client ICP (${fit.join('; ') || 'matches the stored offer'}).`,
      not_icp: `Does not fit. Exclusions: ${exclusions}.`,
    },
  };
}

function buildExtractPrompt(sourceText) {
  return (
    `Extract this client's Ideal Customer Profile from the call transcripts below.\n` +
    `${FACT_GROUNDING_RULES}\n` +
    `- Return only facts spoken in the transcripts. Empty array when a field is not said.\n` +
    `- Fields: industries, titles (buyer job titles), company_size, geos, offer, exclusions.\n` +
    `- Do not copy company names, people names, or email addresses into any field.\n\n` +
    `Transcripts:\n${String(sourceText || '').slice(0, 24_000)}\n\n` +
    `Return JSON: {"industries":[],"titles":[],"company_size":[],"geos":[],"offer":[],"exclusions":[]}`
  );
}

async function extractIcpFromText(sourceText, { extractFn, env = process.env } = {}) {
  if (extractFn) return normalizeProfile(await extractFn(sourceText));
  if (!env.GEMINI_API_KEY) return emptyProfile();
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: env.REPLY_ICP_MODEL || geminiModel(),
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 512,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const result = await model.generateContent(buildExtractPrompt(sourceText));
  const text = result?.response?.text?.() || '{}';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return normalizeProfile(parsed);
}

async function persistIcp(db, clientId, row) {
  if (!db || !clientId) return row;
  await db.query(
    `UPDATE clients SET
       icp_profile = $1::jsonb,
       icp_status = $2,
       icp_reason = $3,
       icp_source = $4,
       icp_transcript_count = $5,
       icp_built_at = now(),
       updated_at = now()
     WHERE id = $6`,
    [
      row.profile ? JSON.stringify(row.profile) : null,
      row.status,
      row.reason || null,
      row.source || null,
      Number(row.transcript_count) || 0,
      clientId,
    ]
  );
  return row;
}

async function searchClientTranscripts(hints, { firefliesApi = fireflies, fetchImpl, env } = {}) {
  const seen = new Map();
  const queries = [hints.name, ...hints.domains].filter(Boolean);
  for (const q of queries) {
    let rows = [];
    try {
      rows = await firefliesApi.searchTranscripts(q, { limit: 20, fetchImpl, env });
    } catch (err) {
      if (err.code === 'FIREFLIES_NOT_CONFIGURED') throw err;
      console.warn('[ClientIcp] Fireflies search skipped', { err: err.message });
      continue;
    }
    for (const row of rows) {
      if (!row?.id || seen.has(row.id)) continue;
      if (!firefliesApi.transcriptMatches(row, hints)) continue;
      seen.set(row.id, row);
    }
  }
  return [...seen.values()];
}

async function loadTranscriptTexts(hits, { firefliesApi = fireflies, fetchImpl, env, max = 8 } = {}) {
  const texts = [];
  let loaded = 0;
  for (const hit of hits.slice(0, max)) {
    try {
      const full = await firefliesApi.getTranscript(hit.id, { fetchImpl, env });
      const body = firefliesApi.sentencesToText(full || hit);
      if (body && body.trim().length > 40) {
        texts.push(body);
        loaded += 1;
      }
    } catch (err) {
      console.warn('[ClientIcp] transcript fetch skipped', { err: err.message });
    }
  }
  return { texts, loaded };
}

/**
 * Ensure one client has an ICP the grader can read.
 * Never throws to the caller. Counts only in the return value.
 */
async function ensureClientIcp(client, {
  db,
  firefliesApi = fireflies,
  extractFn,
  fetchImpl,
  env = process.env,
  force = false,
} = {}) {
  if (!client?.id) {
    return { status: 'needs_review', reason: 'no_client', transcript_count: 0 };
  }

  if (!force && hasDefaultVariant(client)) {
    const row = {
      status: 'skipped_existing',
      reason: 'existing_variant',
      source: 'default_variant',
      profile: null,
      transcript_count: 0,
    };
    await persistIcp(db, client.id, row);
    return row;
  }

  if (!force && hasStoredProfile(client)) {
    return {
      status: 'ready',
      reason: 'existing_profile',
      source: client.icp_source || 'stored',
      profile: normalizeProfile(client.icp_profile),
      transcript_count: Number(client.icp_transcript_count) || 0,
    };
  }

  if (!firefliesApi.isConfigured(env)) {
    const row = {
      status: 'needs_review',
      reason: 'missing_credentials',
      source: null,
      profile: null,
      transcript_count: 0,
      env_needed: firefliesApi.requiredEnvVar(),
    };
    await persistIcp(db, client.id, row);
    console.warn('[ClientIcp] needs review — missing credentials', {
      env: row.env_needed,
    });
    return row;
  }

  const hints = clientSearchHints(client);
  let hits = [];
  try {
    hits = await searchClientTranscripts(hints, { firefliesApi, fetchImpl, env });
  } catch (err) {
    if (err.code === 'FIREFLIES_NOT_CONFIGURED') {
      const row = {
        status: 'needs_review',
        reason: 'missing_credentials',
        source: null,
        profile: null,
        transcript_count: 0,
        env_needed: firefliesApi.requiredEnvVar(),
      };
      await persistIcp(db, client.id, row);
      return row;
    }
    console.warn('[ClientIcp] search failed', { err: err.message });
    const row = {
      status: 'needs_review',
      reason: 'search_failed',
      source: 'fireflies',
      profile: null,
      transcript_count: 0,
    };
    await persistIcp(db, client.id, row);
    return row;
  }

  if (!hits.length) {
    const row = {
      status: 'needs_review',
      reason: 'no_calls',
      source: 'fireflies',
      profile: null,
      transcript_count: 0,
    };
    await persistIcp(db, client.id, row);
    return row;
  }

  const { texts, loaded } = await loadTranscriptTexts(hits, { firefliesApi, fetchImpl, env });
  const sourceText = texts.join('\n\n');
  if (!sourceText.trim()) {
    const row = {
      status: 'needs_review',
      reason: 'no_calls',
      source: 'fireflies',
      profile: null,
      transcript_count: hits.length,
    };
    await persistIcp(db, client.id, row);
    return row;
  }

  let extracted = emptyProfile();
  try {
    extracted = await extractIcpFromText(sourceText, { extractFn, env });
  } catch (err) {
    console.warn('[ClientIcp] extract failed', { err: err.message });
  }
  const profile = groundIcpProfile(extracted, sourceText);

  if (!profileHasFacts(profile)) {
    const row = {
      status: 'needs_review',
      reason: 'no_facts',
      source: 'fireflies',
      profile,
      transcript_count: loaded,
    };
    await persistIcp(db, client.id, row);
    return row;
  }

  const row = {
    status: 'ready',
    reason: null,
    source: 'fireflies',
    profile,
    transcript_count: loaded,
  };
  await persistIcp(db, client.id, row);
  return row;
}

function summarizeIcpResult(row) {
  return {
    status: row.status,
    reason: row.reason || null,
    env_needed: row.env_needed || null,
    transcript_count: Number(row.transcript_count) || 0,
  };
}

function icpStatusOf(client) {
  return String(client?.icp_status || '').trim();
}

/**
 * True when this client still needs an ICP write: empty/missing status,
 * never built, or (when includeNeedsReview) a stale needs_review row.
 * Default-variant clients with an empty status still need a write so
 * icp_status becomes skipped_existing instead of staying blank.
 */
function needsIcpWork(client, {
  includeNeedsReview = false,
  retryNeedsReviewAfterMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
} = {}) {
  if (!client || client.active === false) return false;
  if (hasStoredProfile(client)) return false;
  const status = icpStatusOf(client);
  if (status === 'skipped_existing') return false;
  if (status === 'ready') return false;
  if (hasDefaultVariant(client)) return status === '';
  if (status === 'needs_review') {
    if (!includeNeedsReview) return false;
    const built = client.icp_built_at ? new Date(client.icp_built_at).getTime() : 0;
    if (!Number.isFinite(built) || built <= 0) return true;
    return (now - built) >= retryNeedsReviewAfterMs;
  }
  return true;
}

/**
 * Backfill existing clients that have no ICP the grader can read.
 * Default-variant skips persist icp_status='skipped_existing' so the
 * column is never left empty. Returns counts only.
 */
async function backfillMissingClientIcp({
  db,
  firefliesApi = fireflies,
  extractFn,
  fetchImpl,
  env = process.env,
  dryRun = false,
  includeNeedsReview = false,
  now = Date.now(),
} = {}) {
  if (!db) throw new Error('db is required');
  const { rows } = await db.query(
    `SELECT * FROM clients
      WHERE active IS DISTINCT FROM false
      ORDER BY created_at ASC`
  );

  const counts = {
    total: rows.length,
    skipped_existing: 0,
    ready: 0,
    needs_review: 0,
    missing_credentials: 0,
    no_calls: 0,
    no_facts: 0,
    dry_run: dryRun,
  };

  for (const client of rows) {
    if (!needsIcpWork(client, { includeNeedsReview, now })) {
      if (!dryRun && hasDefaultVariant(client) && !icpStatusOf(client)) {
        await persistIcp(db, client.id, {
          status: 'skipped_existing',
          reason: 'existing_variant',
          source: 'default_variant',
          profile: null,
          transcript_count: 0,
        });
      }
      counts.skipped_existing += 1;
      continue;
    }
    if (dryRun) {
      if (hasDefaultVariant(client) || hasStoredProfile(client)) {
        counts.skipped_existing += 1;
      } else if (!firefliesApi.isConfigured(env)) {
        counts.needs_review += 1;
        counts.missing_credentials += 1;
      } else {
        counts.needs_review += 1;
      }
      continue;
    }
    const result = await ensureClientIcp(client, {
      db, firefliesApi, extractFn, fetchImpl, env,
    });
    tally(counts, result);
  }
  return counts;
}

function tally(counts, result) {
  if (result.status === 'skipped_existing') counts.skipped_existing += 1;
  else if (result.status === 'ready') counts.ready += 1;
  else if (result.status === 'needs_review') {
    counts.needs_review += 1;
    if (result.reason === 'missing_credentials') counts.missing_credentials += 1;
    if (result.reason === 'no_calls') counts.no_calls += 1;
    if (result.reason === 'no_facts') counts.no_facts += 1;
  }
}

module.exports = {
  ICP_FIELDS,
  emptyProfile,
  clientSearchHints,
  hasDefaultVariant,
  hasStoredProfile,
  clientHasIcp,
  profileHasFacts,
  normalizeProfile,
  groundIcpProfile,
  profileToVariantSpec,
  buildExtractPrompt,
  extractIcpFromText,
  ensureClientIcp,
  backfillMissingClientIcp,
  summarizeIcpResult,
  persistIcp,
  needsIcpWork,
};
