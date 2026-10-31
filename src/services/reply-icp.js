/**
 * Slack-card ICP verdict — reuse topup's site_check / icp gate, do not
 * invent a new grader.
 *
 * Cheap → paid:
 *   1. in-process + reply_icp_verdicts (client_tag + domain), hits only
 *   2. shared Supabase `client_salesglider.icp_llm_results` (a Jev row
 *      site_check / icp-llm already paid for)
 *   3. cached site text in `client_salesglider.icp_site_text`
 *   4. fetch the company homepage (free, like icp-site-fetch)
 *   5. Jev via OpenRouter Decisions, same call as topup icp-llm `jev()`:
 *      POST https://openrouter.ai/api/alpha/decisions
 *      model `typesafe/jev-1.13` (topup spec `jev:typesafe/jev-1.13|<variant>`)
 *      questions = that variant's category choice (JEV_Q[variant])
 *      Authorization: Bearer OPENROUTER_API_KEY
 *
 * A missing key or a failed Jev call is `ICP: check failed` and is not
 * cached, so a later card retries. Estimate helpers remain; they do not
 * skip the call. Never writes dl_status / sg_exclude / skip_*. Never
 * writes topup ICP tables (read-only).
 *
 * Source: joshuaosborn561-lang/topup
 *   supabase/functions/icp-llm/index.ts (JEV_Q / PASS / jev()).
 */

const { clientTagFor } = require('./prospect-enrich');
const replyExamples = require('./reply-examples');
const {
  DEFAULT_CLIENT_VARIANTS,
  CLIENT_TAG_ALIASES,
  variantSpec,
} = require('./reply-icp-variants');
const { profileToVariantSpec } = require('./client-icp-profile');

function supabaseRequest(path, opts) {
  return replyExamples.supabaseRequest(path, opts);
}

const SITE_TEXT_MAX = 12_000;
const FETCH_TIMEOUT_MS = 8_000;
/** OpenRouter Decisions model id. Topup's spec string is `jev:typesafe/jev-1.13|<variant>`. */
const JEV_MODEL_ID = 'typesafe/jev-1.13';
const JEV_MODEL_SPEC_PREFIX = 'jev:typesafe/jev-1.13|';
const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
/** Same backoff as topup icp-llm jev(): first try immediate, then 3s, then 10s. */
const JEV_RETRY_MS = Object.freeze([0, 3000, 10000]);

const memoryCache = new Map();

function icpCeilingUsd(env = process.env) {
  const n = Number(env.REPLY_ICP_CEILING_USD || 0.02);
  return Number.isFinite(n) && n > 0 ? n : 0.02;
}

/** Recorded so a caller can see a quote. It does not skip the Jev call. */
function icpEstimateUsd(env = process.env) {
  const n = Number(env.REPLY_ICP_ESTIMATE_USD || 0.002);
  return Number.isFinite(n) && n > 0 ? n : 0.002;
}

function supabaseReady() {
  return Boolean(
    String(process.env.SUPABASE_URL || '').trim()
    && String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  );
}

function domainFromWebsite(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const url = /^https?:\/\//i.test(s) ? s : (s.includes('.') && !s.includes(' ') ? `https://${s}` : '');
  if (!url) return '';
  const host = url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase().replace(/^www\./, '');
  if (!host || /gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com/i.test(host)) return '';
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return '';
  return host;
}

function resolveClientTag(raw) {
  const slug = clientTagFor(raw);
  return CLIENT_TAG_ALIASES[slug] || slug;
}

function humanizeToken(token) {
  return String(token || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unknownVerdict(reason, extra = {}) {
  return {
    status: 'unknown',
    confidence: null,
    reason: String(reason || 'unknown').slice(0, 180),
    label: null,
    passLabel: extra.passLabel || null,
    source: extra.source || 'none',
    costUsd: 0,
    domain: extra.domain || null,
    clientTag: extra.clientTag || null,
  };
}

function checkingVerdict() {
  return unknownVerdict('checking', { source: 'pending' });
}

/**
 * Jev stores `prob` as P(PASS). Display confidence is of the verdict:
 * qualified → P(PASS); disqualified → 1 − P(PASS).
 * icp-llm: `p = answers.category.probabilities[PASS]; fit = choice === PASS`
 */
function confidencePct(status, prob) {
  const p = Number(prob);
  if (!Number.isFinite(p)) return null;
  const clamped = Math.max(0, Math.min(1, p));
  if (status === 'qualified') return Math.round(clamped * 100);
  if (status === 'disqualified') return Math.round((1 - clamped) * 100);
  return null;
}

function composeReason(status, label, passLabel, modelReason) {
  const said = humanizeToken(label);
  const want = humanizeToken(passLabel);
  if (status === 'unknown') return String(modelReason || 'unknown').slice(0, 180);
  if (said && want) {
    if (status === 'disqualified') {
      return `website says ${said}; client only works with ${want}`;
    }
    return `website says ${said}; client ICP is ${want}`;
  }
  const raw = String(modelReason || '').replace(/^REASON:\s*/i, '').trim();
  return (raw || said || 'no reason').slice(0, 180);
}

function fromLlmRow(row, spec, { domain, clientTag, source } = {}) {
  const fit = String(row?.fit || '').toLowerCase();
  const choice = row?.answers?.category?.choice || row?.reason || row?.label || null;
  const label = typeof choice === 'string' && /^[a-z][a-z0-9_]{2,80}$/.test(choice.trim())
    ? choice.trim()
    : (spec?.pass && fit === 'yes' ? spec.pass : null);
  const status = fit === 'yes' ? 'qualified' : fit === 'no' ? 'disqualified' : 'unknown';
  const passLabel = spec?.pass || null;
  const pct = confidencePct(status, row?.prob);
  if (status === 'unknown') {
    return unknownVerdict(row?.reason || row?.error || 'unreadable', { domain, clientTag, source });
  }
  return {
    status,
    confidence: pct,
    reason: composeReason(status, label, passLabel, row?.reason),
    label,
    passLabel,
    source: source || 'topup_llm_results',
    costUsd: 0,
    domain,
    clientTag,
  };
}

function memoryKey(clientTag, domain) {
  return `${clientTag}::${domain}`;
}

async function supabaseSchema(schema, path, extraHeaders = {}) {
  return supabaseRequest(path, {
    headers: {
      'Accept-Profile': schema,
      ...extraHeaders,
    },
  });
}

async function loadStoredClientVariant(db, { clientId, clientTag } = {}) {
  if (!db || !clientId) return null;
  try {
    const { rows } = await db.query(
      `SELECT icp_profile, icp_status FROM clients WHERE id = $1`,
      [clientId]
    );
    const row = rows[0];
    if (!row || row.icp_status !== 'ready' || !row.icp_profile) return null;
    const spec = profileToVariantSpec(row.icp_profile);
    if (!spec) return null;
    return {
      jev_variant: 'client_profile',
      disco_icp: clientTag || null,
      spec,
      note: 'clients.icp_profile',
    };
  } catch (err) {
    if (!/icp_profile|icp_status/.test(err.message || '')) {
      console.warn('[Icp] client icp_profile read skipped', { err: err.message });
    }
    return null;
  }
}

/**
 * Which ICP grades a client's replies. Josh, Oct 29 2026: a client's ICP and target
 * decision-makers always come from that client's onboarding call (Fireflies transcript
 * or onboarding notes), never from a generic default.
 *   1. clients.icp_profile, built from the client's onboarding call (icp_status 'ready')
 *   2. a per-client variant recorded in code (BCP, Emcor, Deep Roots, SalesGlider's own)
 *   3. a per-client topup.icp_variants row, except the generic trade-contractor
 *      `choice` variant, which used to be applied to clients it was never written for
 * Anything else: no ICP on file. The card says so and shows no disqualified score.
 */
const GENERIC_DEFAULT_VARIANTS = new Set(['choice']);

async function loadVariant(clientTag, { db, clientId } = {}) {
  const stored = await loadStoredClientVariant(db, { clientId, clientTag });
  if (stored) return stored;
  const local = DEFAULT_CLIENT_VARIANTS[clientTag];
  if (local && variantSpec(local.jev_variant)) {
    return { ...local, spec: variantSpec(local.jev_variant) };
  }
  if (supabaseReady()) {
    try {
      const rows = await supabaseSchema(
        'topup',
        `/rest/v1/icp_variants?client_tag=eq.${encodeURIComponent(clientTag)}&select=jev_variant,disco_icp,note&limit=1`,
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row?.jev_variant && !GENERIC_DEFAULT_VARIANTS.has(String(row.jev_variant))) {
        const spec = variantSpec(row.jev_variant);
        if (spec) {
          return {
            jev_variant: row.jev_variant,
            disco_icp: row.disco_icp || null,
            spec,
          };
        }
      }
    } catch (err) {
      console.warn('[Icp] icp_variants read skipped', { err: err.message });
    }
  }
  return null;
}

async function readTopupLlm(domain, jevVariant, { strict = false } = {}) {
  if (!supabaseReady() || !domain) return null;
  try {
    const rows = await supabaseSchema(
      'client_salesglider',
      `/rest/v1/icp_llm_results?domain=eq.${encodeURIComponent(domain)}&fit=in.(yes,no)&error=is.null&select=domain,model,fit,prob,reason,answers,cost,created_at&order=created_at.desc&limit=12`,
    );
    const list = Array.isArray(rows) ? rows : [];
    const jevHit = list.find((r) => String(r.model || '').includes(`|${jevVariant}`));
    if (jevHit) return jevHit;
    if (strict) return null;
    const anyJev = list.find((r) => String(r.model || '').startsWith('jev:'));
    if (anyJev) return anyJev;
    return list.find((r) => String(r.model || '') === 'discolike:website') || list[0] || null;
  } catch (err) {
    console.warn('[Icp] icp_llm_results read skipped', { err: err.message });
    return null;
  }
}

async function readTopupSiteText(domain) {
  if (!supabaseReady() || !domain) return '';
  try {
    const rows = await supabaseSchema(
      'client_salesglider',
      `/rest/v1/icp_site_text?domain=eq.${encodeURIComponent(domain)}&select=body,http_status,chars&limit=1`,
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const status = Number(row?.http_status);
    const chars = Number(row?.chars);
    if (status >= 200 && status < 400 && chars > 300 && row?.body) {
      return String(row.body).slice(0, SITE_TEXT_MAX);
    }
  } catch (err) {
    console.warn('[Icp] icp_site_text read skipped', { err: err.message });
  }
  return '';
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWebsiteText(website, { fetchImpl = fetch } = {}) {
  const url = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': 'SalesGliderReplyHandler/1.0 (+icp-site-fetch port)' },
    });
    if (!res.ok) return { text: '', unreachable: true };
    const html = await res.text();
    return { text: stripHtml(html).slice(0, SITE_TEXT_MAX), unreachable: false };
  } catch (err) {
    console.warn('[Icp] website fetch failed', { err: err.message });
    return { text: '', unreachable: true };
  } finally {
    clearTimeout(t);
  }
}

/** Topup spec id. The Decisions body uses JEV_MODEL_ID; the variant selects the question. */
function jevModelSpec(variant) {
  return `${JEV_MODEL_SPEC_PREFIX}${variant}`;
}

/** JEV_Q[variant] for a category choice, built from the stored spec. */
function jevQuestions(spec) {
  return {
    category: {
      type: 'choice',
      instructions: spec.instructions,
      criteria: spec.criteria,
    },
  };
}

function jevRetryWaits(env = process.env) {
  const raw = String(env.REPLY_ICP_JEV_RETRY_MS || '').trim();
  if (!raw) return JEV_RETRY_MS;
  const waits = raw.split(',').map((n) => Number(n));
  return waits.every((n) => Number.isFinite(n) && n >= 0) ? waits : JEV_RETRY_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * topup icp-llm `jev()`. fit=yes only when answers.category.choice === PASS.
 * Throws when the key is missing or the call fails after the retries.
 */
async function gradeWithJev(spec, domain, siteText, {
  fetchImpl = fetch,
  env = process.env,
  variant = null,
  sleepFn = sleep,
} = {}) {
  const key = String(env.OPENROUTER_API_KEY || '').trim();
  if (!key) {
    const err = new Error('OPENROUTER_API_KEY not configured');
    err.code = 'jev_key_missing';
    throw err;
  }
  const body = {
    model: JEV_MODEL_ID,
    state: { domain, website_text: siteText },
    questions: jevQuestions(spec),
  };
  let lastErr = null;
  const waits = jevRetryWaits(env);
  for (let i = 0; i < waits.length; i += 1) {
    if (waits[i]) await sleepFn(waits[i]);
    let res;
    try {
      res = await fetchImpl(JEV_DECISIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`jev ${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`jev ${res.status}`);
    const answers = json.answers || {};
    const pass = spec.pass;
    const p = Number(answers.category?.probabilities?.[pass] ?? 0);
    const fit = answers.category?.choice === pass ? 'yes' : 'no';
    return {
      fit,
      prob: Number.isFinite(p) ? p : 0,
      reason: answers.category?.choice ?? null,
      answers,
      cost: json.usage?.cost ?? null,
      model: jevModelSpec(variant),
    };
  }
  throw lastErr || new Error('jev retries exhausted');
}

/** A cached verdict graded against a different pass label is stale (ICP changed). */
function staleForPass(verdict, expectedPass) {
  return Boolean(expectedPass && verdict?.passLabel && verdict.passLabel !== expectedPass);
}

async function readLocalCache(db, clientTag, domain, expectedPass = null) {
  const hit = memoryCache.get(memoryKey(clientTag, domain));
  if (hit && !staleForPass(hit, expectedPass)) return { ...hit, source: hit.source || 'memory' };
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `SELECT verdict, confidence, reason, label, pass_label, source, cost_usd
         FROM reply_icp_verdicts
        WHERE client_tag = $1 AND domain = $2`,
      [clientTag, domain]
    );
    const row = rows[0];
    if (!row) return null;
    if (staleForPass({ passLabel: row.pass_label }, expectedPass)) return null;
    return {
      status: row.verdict,
      confidence: row.confidence == null ? null : Number(row.confidence),
      reason: row.reason,
      label: row.label,
      passLabel: row.pass_label,
      source: row.source || 'local',
      costUsd: Number(row.cost_usd) || 0,
      domain,
      clientTag,
    };
  } catch (err) {
    if (!/reply_icp_verdicts/.test(err.message || '')) {
      console.warn('[Icp] local cache read skipped', { err: err.message });
    }
    return null;
  }
}

async function writeLocalCache(db, verdict) {
  if (!verdict?.clientTag || !verdict?.domain) return;
  memoryCache.set(memoryKey(verdict.clientTag, verdict.domain), verdict);
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO reply_icp_verdicts
         (client_tag, domain, verdict, confidence, reason, label, pass_label, source, cost_usd, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (client_tag, domain) DO UPDATE SET
         verdict = EXCLUDED.verdict,
         confidence = EXCLUDED.confidence,
         reason = EXCLUDED.reason,
         label = EXCLUDED.label,
         pass_label = EXCLUDED.pass_label,
         source = EXCLUDED.source,
         cost_usd = EXCLUDED.cost_usd,
         updated_at = now()`,
      [
        verdict.clientTag,
        verdict.domain,
        verdict.status,
        verdict.confidence,
        verdict.reason,
        verdict.label,
        verdict.passLabel,
        verdict.source,
        verdict.costUsd || 0,
      ]
    );
  } catch (err) {
    if (!/reply_icp_verdicts/.test(err.message || '')) {
      console.warn('[Icp] local cache write skipped', { err: err.message });
    }
  }
}

async function persistPendingIcp(db, replyId, verdict) {
  if (!db || !replyId || !verdict) return;
  try {
    await db.query(
      `UPDATE pending_replies
          SET icp_verdict = $1::jsonb
                || jsonb_strip_nulls(jsonb_build_object('decision_maker', icp_verdict->'decision_maker')),
              updated_at = now()
        WHERE id = $2`,
      [JSON.stringify({
        status: verdict.status,
        confidence: verdict.confidence,
        reason: verdict.reason,
        label: verdict.label,
        passLabel: verdict.passLabel,
        source: verdict.source,
      }), replyId]
    );
  } catch (err) {
    if (!/icp_verdict/.test(err.message || '')) {
      console.warn('[Icp] pending_replies persist skipped', { err: err.message });
    }
  }
}

async function resolveClientTagFromDb(db, { clientId, clientName }) {
  if (clientName) return resolveClientTag(clientName);
  if (db && clientId) {
    try {
      const { rows } = await db.query('SELECT name FROM clients WHERE id = $1', [clientId]);
      if (rows[0]?.name) return resolveClientTag(rows[0].name);
    } catch { /* ignore */ }
  }
  return resolveClientTag(clientName);
}

/**
 * Resolve an ICP verdict for a Slack card. Never throws.
 * `grade: false` is cache-only (no fetch, no Jev) for the first post.
 */
async function resolveReplyIcp({
  website,
  clientName,
  clientId,
  replyId,
  db,
  grade = true,
  fetchImpl,
  gradeFn,
} = {}) {
  const domain = domainFromWebsite(website);
  if (!domain) return unknownVerdict('no website');

  const clientTag = await resolveClientTagFromDb(db, { clientId, clientName });
  const variant = await loadVariant(clientTag, { db, clientId });
  if (!variant?.jev_variant || !variant.spec) {
    return unknownVerdict('no ICP', { domain, clientTag, source: 'icp_variants' });
  }

  const cached = await readLocalCache(db, clientTag, domain, variant.spec.pass);
  // Only a real fit / not-a-fit is final. Failures are not cached, so a
  // later card retries the website and Jev.
  if (cached && cached.status !== 'unknown') return cached;

  const topup = await readTopupLlm(domain, variant.jev_variant, { strict: Boolean(variant.spec.strictCache) });
  if (topup) {
    const verdict = fromLlmRow(topup, variant.spec, {
      domain, clientTag, source: 'topup_llm_results',
    });
    if (verdict.status !== 'unknown') {
      await writeLocalCache(db, verdict);
      await persistPendingIcp(db, replyId, verdict);
      return verdict;
    }
  }

  if (!grade) {
    return (cached && cached.status !== 'unknown') ? cached : checkingVerdict();
  }

  let siteText = await readTopupSiteText(domain);
  let fetched = null;
  if (!siteText) {
    fetched = await fetchWebsiteText(website, { fetchImpl });
    siteText = fetched.text || '';
  }
  if (!siteText || siteText.length < 80) {
    const reason = fetched?.unreachable && !siteText ? 'unreachable' : 'unreadable';
    const unread = unknownVerdict(reason, { domain, clientTag, source: 'fetch' });
    await persistPendingIcp(db, replyId, unread);
    return unread;
  }

  try {
    const grader = gradeFn || ((s, d, t) => gradeWithJev(s, d, t, {
      fetchImpl,
      variant: variant.jev_variant,
    }));
    const graded = await grader(variant.spec, domain, siteText);
    const verdict = fromLlmRow(graded, variant.spec, {
      domain, clientTag, source: 'openrouter_jev',
    });
    if (verdict.status === 'unknown') {
      const failed = unknownVerdict('check failed', { domain, clientTag, source: 'openrouter_jev' });
      await persistPendingIcp(db, replyId, failed);
      return failed;
    }
    verdict.costUsd = Number(graded.cost) || 0;
    await writeLocalCache(db, verdict);
    await persistPendingIcp(db, replyId, verdict);
    return verdict;
  } catch (err) {
    console.warn('[Icp] Jev check failed', { err: err.message });
    const failed = unknownVerdict('check failed', { domain, clientTag, source: 'openrouter_jev' });
    await persistPendingIcp(db, replyId, failed);
    return failed;
  }
}

function icpVerdictEquals(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const dm = (v) => (v.decision_maker || v.decisionMaker) ? JSON.stringify(v.decision_maker || v.decisionMaker) : '';
  return a.status === b.status
    && dm(a) === dm(b)
    && a.confidence === b.confidence
    && String(a.reason || '') === String(b.reason || '');
}

function parseStoredIcp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.status) return null;
  return {
    status: raw.status,
    confidence: raw.confidence == null ? null : Number(raw.confidence),
    reason: raw.reason || null,
    label: raw.label || null,
    passLabel: raw.passLabel || raw.pass_label || null,
    source: raw.source || null,
    ...(raw.decision_maker ? { decision_maker: raw.decision_maker } : {}),
  };
}

function clearIcpMemoryCache() {
  memoryCache.clear();
}

module.exports = {
  resolveReplyIcp,
  resolveClientTag,
  domainFromWebsite,
  composeReason,
  confidencePct,
  fromLlmRow,
  unknownVerdict,
  checkingVerdict,
  icpCeilingUsd,
  icpEstimateUsd,
  icpVerdictEquals,
  parseStoredIcp,
  persistPendingIcp,
  clearIcpMemoryCache,
  jevQuestions,
  jevModelSpec,
  gradeWithJev,
  JEV_MODEL_ID,
  JEV_DECISIONS_URL,
  loadVariant,
  FORBIDDEN_WRITE_COLUMNS: Object.freeze(['dl_status', 'sg_exclude', 'skip_*']),
};
