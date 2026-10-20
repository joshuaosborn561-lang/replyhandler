const { geminiModel } = require('./gemini-model');
/**
 * Slack-card ICP verdict — reuse topup's site_check / icp gate, do not
 * invent a new grader.
 *
 * Cheap → paid:
 *   1. in-process + reply_icp_verdicts (client_tag + domain)
 *   2. shared Supabase `client_salesglider.icp_llm_results` (same row
 *      site_check / icp(job_id) already paid for)
 *   3. cached site text in `client_salesglider.icp_site_text`
 *   4. fetch the company homepage (free, like icp-site-fetch)
 *   5. Gemini with the icp-llm category prompt + PASS token
 *
 * Estimate first. Default ceiling $0.02. Never writes dl_status /
 * sg_exclude / skip_*. Never writes topup ICP tables (read-only).
 *
 * Source: joshuaosborn561-lang/topup
 *   src/clients/icpGate.ts, src/canon/siteCheck.ts, src/stages/icp/,
 *   supabase function icp-llm (JEV_Q / PASS / fit+prob+reason).
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
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

const memoryCache = new Map();

function icpCeilingUsd(env = process.env) {
  const n = Number(env.REPLY_ICP_CEILING_USD || 0.02);
  return Number.isFinite(n) && n > 0 ? n : 0.02;
}

/** Worst-case Gemini 2.5 Flash on ~12k chars of site text. */
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

async function loadVariant(clientTag, { db, clientId } = {}) {
  const local = DEFAULT_CLIENT_VARIANTS[clientTag];
  if (supabaseReady()) {
    try {
      const rows = await supabaseSchema(
        'topup',
        `/rest/v1/icp_variants?client_tag=eq.${encodeURIComponent(clientTag)}&select=jev_variant,disco_icp,note&limit=1`,
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row?.jev_variant) {
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
  if (local) return { ...local, spec: variantSpec(local.jev_variant) };
  return loadStoredClientVariant(db, { clientId, clientTag });
}

async function readTopupLlm(domain, jevVariant) {
  if (!supabaseReady() || !domain) return null;
  try {
    const rows = await supabaseSchema(
      'client_salesglider',
      `/rest/v1/icp_llm_results?domain=eq.${encodeURIComponent(domain)}&fit=in.(yes,no)&error=is.null&select=domain,model,fit,prob,reason,answers,cost,created_at&order=created_at.desc&limit=12`,
    );
    const list = Array.isArray(rows) ? rows : [];
    const jevHit = list.find((r) => String(r.model || '').includes(`|${jevVariant}`));
    if (jevHit) return jevHit;
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
    if (!res.ok) return '';
    const html = await res.text();
    return stripHtml(html).slice(0, SITE_TEXT_MAX);
  } catch (err) {
    console.warn('[Icp] website fetch failed', { err: err.message });
    return '';
  } finally {
    clearTimeout(t);
  }
}

function buildGradePrompt(spec, domain, siteText) {
  const lines = Object.entries(spec.criteria)
    .map(([label, def]) => `- ${label}: ${def}`)
    .join('\n');
  // Faithful port of icp-llm JEV_Q[variant] + PASS. Gemini stands in for
  // Jev because ReplyHandler has GEMINI_API_KEY, not OpenRouter.
  return (
    `You classify a company from its website the same way topup icp-llm does ` +
    `(joshuaosborn561-lang/topup supabase function icp-llm).\n\n` +
    `${spec.instructions}\n\n` +
    `Pick exactly one category token:\n${lines}\n\n` +
    `Qualified (fit=yes) only when the category is ${spec.pass}. Otherwise fit=no. ` +
    `If the website text is too thin to tell, pick the "other" / too-thin label and fit=no.\n\n` +
    `Domain: ${domain}\nWebsite text:\n${siteText}\n\n` +
    `Return JSON: {"category":"<token>","confidence":0 to 1,"reason":"under 20 words"}`
  );
}

async function gradeWithGemini(spec, domain, siteText) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: process.env.REPLY_ICP_MODEL || geminiModel(),
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const result = await model.generateContent(buildGradePrompt(spec, domain, siteText));
  const text = result?.response?.text?.() || '{}';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  const category = String(parsed.category || '').trim();
  const allowed = spec.criteria[category] ? category : null;
  const fit = allowed && allowed === spec.pass ? 'yes' : 'no';
  const conf = Number(parsed.confidence);
  const pPass = fit === 'yes'
    ? (Number.isFinite(conf) ? conf : 0.8)
    : (Number.isFinite(conf) ? Math.max(0, 1 - conf) : 0.2);
  return {
    fit,
    prob: pPass,
    reason: String(parsed.reason || allowed || '').slice(0, 300),
    answers: { category: { choice: allowed || category || null } },
  };
}

async function readLocalCache(db, clientTag, domain) {
  const hit = memoryCache.get(memoryKey(clientTag, domain));
  if (hit) return { ...hit, source: hit.source || 'memory' };
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
          SET icp_verdict = $1::jsonb, updated_at = now()
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
 * `grade: false` is cache-only (no fetch / no Gemini) for the first post.
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

  const cached = await readLocalCache(db, clientTag, domain);
  if (cached && cached.status !== 'unknown') return cached;

  const topup = await readTopupLlm(domain, variant.jev_variant);
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
    return cached || checkingVerdict();
  }

  const estimate = icpEstimateUsd();
  const ceiling = icpCeilingUsd();
  if (estimate > ceiling) {
    return unknownVerdict('ceiling', { domain, clientTag, source: 'ceiling' });
  }

  let siteText = await readTopupSiteText(domain);
  if (!siteText) {
    siteText = await fetchWebsiteText(website, { fetchImpl });
  }
  if (!siteText || siteText.length < 80) {
    const unread = unknownVerdict('unreadable', { domain, clientTag, source: 'fetch' });
    await writeLocalCache(db, unread);
    await persistPendingIcp(db, replyId, unread);
    return unread;
  }

  try {
    const grader = gradeFn || gradeWithGemini;
    const graded = await grader(variant.spec, domain, siteText);
    const verdict = fromLlmRow(graded, variant.spec, {
      domain, clientTag, source: 'gemini_icp_llm_port',
    });
    verdict.costUsd = estimate;
    await writeLocalCache(db, verdict);
    await persistPendingIcp(db, replyId, verdict);
    return verdict;
  } catch (err) {
    console.warn('[Icp] grade failed', { err: err.message });
    return unknownVerdict('grade failed', { domain, clientTag, source: 'gemini' });
  }
}

function icpVerdictEquals(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.status === b.status
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
  buildGradePrompt,
  loadVariant,
  FORBIDDEN_WRITE_COLUMNS: Object.freeze(['dl_status', 'sg_exclude', 'skip_*']),
};
