/**
 * One-sentence company description for Slack DQ.
 *
 * Prefer the website on the prospect's reply email domain (or stored lead_website).
 * LinkedIn URL is only a secondary hint in the prompt — we do not scrape LinkedIn.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../db');
const { domainFromEmail, asWebsite } = require('./prospect-enrich');

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
  'yandex.com', 'zoho.com', 'qq.com',
]);

const FETCH_TIMEOUT_MS = Number(process.env.PROSPECT_DESC_FETCH_MS || 8000);
const MAX_HTML_CHARS = 250_000;

function isFreeEmailDomain(domain) {
  return FREE_EMAIL_DOMAINS.has(String(domain || '').toLowerCase());
}

function resolveWebsite({ email, website } = {}) {
  const fromStored = asWebsite(website);
  if (fromStored) return { website: fromStored, source: 'lead_website' };

  const domain = domainFromEmail(email);
  if (!domain || isFreeEmailDomain(domain)) {
    return { website: null, source: null, domain: domain || null, freeEmail: !!domain };
  }
  return { website: `https://${domain}`, source: 'email_domain', domain };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    });
}

function metaContent(html, names) {
  const h = String(html || '');
  for (const name of names) {
    const re1 = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
      'i'
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
      'i'
    );
    const m = h.match(re1) || h.match(re2);
    if (m?.[1]) return decodeEntities(m[1]).trim();
  }
  return '';
}

function extractPageSignals(html) {
  const h = String(html || '').slice(0, MAX_HTML_CHARS);
  const titleMatch = h.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  const title = decodeEntities(titleMatch?.[1] || '').replace(/\s+/g, ' ').trim();
  const description =
    metaContent(h, ['og:description', 'description', 'twitter:description']) || '';
  const ogSite = metaContent(h, ['og:site_name']) || '';
  const ogTitle = metaContent(h, ['og:title']) || '';

  // Strip scripts/styles then grab visible-ish text for a short body sample.
  const body = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bodySample = decodeEntities(body).slice(0, 2500);

  return {
    title: title || ogTitle || '',
    description: description.slice(0, 800),
    siteName: ogSite,
    bodySample,
  };
}

async function fetchWebsiteSignals(websiteUrl) {
  const url = asWebsite(websiteUrl);
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'ReplyHandlerBot/1.0 (+https://replyhandler; company summary for ICP review)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      throw new Error(`website_fetch_${res.status}`);
    }
    const ctype = String(res.headers.get('content-type') || '');
    if (ctype && !/text\/html|application\/xhtml/i.test(ctype) && !/text\/plain/i.test(ctype)) {
      throw new Error(`website_not_html:${ctype.split(';')[0]}`);
    }
    const html = await res.text();
    return { url: res.url || url, ...extractPageSignals(html) };
  } finally {
    clearTimeout(timer);
  }
}

function heuristicSummary({ signals, companyHint, domain } = {}) {
  const title = String(signals?.title || '').trim();
  const desc = String(signals?.description || '').trim();
  const site = String(signals?.siteName || companyHint || domain || '').trim();
  const base = desc || title;
  if (!base) return null;

  let category = 'Company';
  const blob = `${title} ${desc} ${signals?.bodySample || ''}`.toLowerCase();
  if (/\broof/.test(blob)) category = 'Roofing';
  else if (/\bhvac\b|heating|air conditioning/.test(blob)) category = 'HVAC';
  else if (/\bplumb/.test(blob)) category = 'Plumbing';
  else if (/\bsoftware|saas|platform\b/.test(blob)) category = 'Software';
  else if (/\breal estate|propert/.test(blob)) category = 'Real estate';
  else if (/\bconstruct|general contractor|builder\b/.test(blob)) category = 'Construction';
  else if (/\binsur/.test(blob)) category = 'Insurance';
  else if (/\bstaff|recruit|staffing\b/.test(blob)) category = 'Staffing';
  else if (/\bmarket(ing)?\b|agency\b/.test(blob)) category = 'Marketing';

  const sentence = base.replace(/\s+/g, ' ').trim();
  const clipped = sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}…` : sentence;
  const who = site || 'This company';
  return {
    category,
    description: `${category}. ${who}: ${clipped}`,
  };
}

async function summarizeWithGemini({
  signals, companyHint, domain, leadName, linkedinUrl,
} = {}) {
  if (!genAI) return null;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction:
      'You help a B2B sales rep quickly DQ prospects that are outside their ICP.\n' +
      'Given website page signals (and optional LinkedIn URL as a weak hint only), ' +
      'return ONE plain-English sentence that states (1) the company category/industry and ' +
      '(2) what they do.\n' +
      'Format exactly:\n' +
      'CATEGORY: <short category>\n' +
      'DESCRIPTION: <one sentence>\n' +
      'Rules: no fluff, no marketing slogans, no "I think", no markdown. ' +
      'If the site is unclear, say so briefly. Prefer concrete product/service over taglines.',
    generationConfig: {
      maxOutputTokens: 120,
      temperature: 0.2,
      responseMimeType: 'text/plain',
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const prompt = [
    `Lead name: ${leadName || 'unknown'}`,
    `Domain: ${domain || 'unknown'}`,
    `Company hint: ${companyHint || 'unknown'}`,
    `Website URL: ${signals?.url || 'unknown'}`,
    `Page title: ${signals?.title || ''}`,
    `Meta description: ${signals?.description || ''}`,
    `Site name: ${signals?.siteName || ''}`,
    `LinkedIn URL (hint only, may be person not company): ${linkedinUrl || 'none'}`,
    `Page text sample: ${(signals?.bodySample || '').slice(0, 1800)}`,
  ].join('\n');

  const res = await model.generateContent(prompt);
  const text = String(res?.response?.text?.() || '').trim();
  const cat = (text.match(/CATEGORY:\s*(.+)/i) || [])[1]?.trim();
  const desc = (text.match(/DESCRIPTION:\s*(.+)/i) || [])[1]?.trim();
  if (!desc) return null;
  const category = (cat || 'Company').replace(/\s+/g, ' ').slice(0, 80);
  const oneLiner = desc.replace(/\s+/g, ' ').slice(0, 280);
  // Ensure category appears in the sentence shown on Slack.
  const withCategory = new RegExp(`^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(oneLiner)
    ? oneLiner
    : `${category}. ${oneLiner}`;
  return { category, description: withCategory };
}

function storedResult(reply) {
  return {
    description: reply?.lead_company_description || null,
    category: reply?.lead_company_category || null,
    status: reply?.company_description_status || null,
    error: reply?.company_description_error || null,
    website: reply?.lead_website || null,
  };
}

async function getReply(replyId) {
  const { rows } = await db.query(
    `SELECT id, lead_name, lead_email, linkedin_url, lead_website,
            lead_company_description, lead_company_category,
            company_description_status, company_description_error,
            company_described_at, campaign_id
       FROM pending_replies
      WHERE id = $1`,
    [replyId]
  );
  return rows[0] || null;
}

/**
 * Build + persist a one-sentence company description for a pending reply.
 * Safe to call for every classification. Never throws to callers — returns status.
 */
async function describePendingReplyCompany(replyId, {
  email,
  website,
  linkedinUrl,
  leadName,
  companyName,
} = {}) {
  if (!replyId) return { status: 'skipped', error: 'missing_reply_id' };

  let existing = null;
  try {
    existing = await getReply(replyId);
  } catch (err) {
    // Column may not exist until migration 021 is applied — still compute in-memory.
    console.warn('[ProspectDesc] DB read failed (continuing without cache)', {
      replyId, err: err.message,
    });
  }

  if (existing?.campaign_id === 'test-campaign') {
    return { ...storedResult(existing), status: 'skipped' };
  }
  if (existing?.company_description_status === 'found' && existing.lead_company_description) {
    return storedResult(existing);
  }

  const resolvedEmail = email || existing?.lead_email || null;
  const resolvedWebsite = website || existing?.lead_website || null;
  const resolvedLi = linkedinUrl || existing?.linkedin_url || null;
  const resolvedName = leadName || existing?.lead_name || null;
  const site = resolveWebsite({ email: resolvedEmail, website: resolvedWebsite });

  if (!site.website) {
    const result = {
      description: site.freeEmail
        ? 'Personal email domain — no company website to review for ICP.'
        : 'No company website found from reply email domain.',
      category: site.freeEmail ? 'Personal email' : 'Unknown',
      status: 'skipped',
      error: site.freeEmail ? 'free_email_domain' : 'no_website',
      website: null,
    };
    await persistDescription(replyId, result).catch(() => {});
    return result;
  }

  try {
    await db.query(
      `UPDATE pending_replies
          SET company_description_status = 'processing',
              company_description_error = NULL,
              lead_website = COALESCE(lead_website, $2),
              updated_at = now()
        WHERE id = $1`,
      [replyId, site.website]
    ).catch(() => {});

    const signals = await fetchWebsiteSignals(site.website);
    let summary = null;
    try {
      summary = await summarizeWithGemini({
        signals,
        companyHint: companyName || signals?.siteName,
        domain: site.domain || domainFromEmail(resolvedEmail),
        leadName: resolvedName,
        linkedinUrl: resolvedLi,
      });
    } catch (err) {
      console.warn('[ProspectDesc] Gemini summary failed', { replyId, err: err.message });
    }
    if (!summary) {
      summary = heuristicSummary({
        signals,
        companyHint: companyName || signals?.siteName,
        domain: site.domain || domainFromEmail(resolvedEmail),
      });
    }
    if (!summary) {
      throw new Error('no_summary_from_website');
    }

    const result = {
      description: summary.description,
      category: summary.category,
      status: 'found',
      error: null,
      website: site.website,
    };
    await persistDescription(replyId, result);
    return result;
  } catch (err) {
    const result = {
      description: null,
      category: null,
      status: 'failed',
      error: String(err.message || err).slice(0, 500),
      website: site.website,
    };
    await persistDescription(replyId, result).catch(() => {});
    console.warn('[ProspectDesc] Failed', { replyId, err: err.message, website: site.website });
    return result;
  }
}

async function persistDescription(replyId, result) {
  if (!replyId || !result) return;
  await db.query(
    `UPDATE pending_replies
        SET lead_company_description = $1,
            lead_company_category = $2,
            company_description_status = $3,
            company_description_error = $4,
            lead_website = COALESCE(lead_website, $5),
            company_described_at = now(),
            updated_at = now()
      WHERE id = $6`,
    [
      result.description || null,
      result.category || null,
      result.status || null,
      result.error || null,
      result.website || null,
      replyId,
    ]
  );
}

/** Format for Slack: one line, category + what they do. */
function formatProspectDescriptionLine({ description, category } = {}) {
  const d = String(description || '').trim();
  if (d) return d;
  const c = String(category || '').trim();
  return c || '';
}

module.exports = {
  describePendingReplyCompany,
  resolveWebsite,
  extractPageSignals,
  heuristicSummary,
  formatProspectDescriptionLine,
  isFreeEmailDomain,
  FREE_EMAIL_DOMAINS,
};
