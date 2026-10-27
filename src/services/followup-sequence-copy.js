'use strict';

/**
 * Offer line + proof point for the follow-up card sequence.
 *
 * Both come from the client's own campaign copy and nothing else:
 *  - proof_point must be a sentence copied word for word from that copy, with
 *    a real number in it. No paraphrase, no rounding, no invented claim.
 *  - offer_line is a short phrase; any number in it must also be in the copy.
 * When no proof qualifies the Day 3 proof card is held (never invented).
 *
 * Results are cached per client + campaign in followup_sequence_copy, and a
 * row with source = 'manual' is never overwritten by extraction.
 */
const crypto = require('crypto');
const db = require('../db');

const MAX_COPY_CHARS = 12000;

function htmlToPlain(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function norm(s) {
  return String(s || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Number tokens like 40, 40%, $1.2m, 1,000. Digits only, normalised. */
function numberTokens(text) {
  return (String(text || '').match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map((n) => n.replace(/,/g, ''));
}

function hasMergeTag(s) {
  return /[{}]|\[\[|\]\]|%[a-z_]+%/i.test(String(s || ''));
}

/**
 * Accepts or rejects what the extractor returned. Pure.
 * @returns {{ offerLine: string|null, proofPoint: string|null, reasons: string[] }}
 */
function validateExtraction(copyText, raw = {}) {
  const reasons = [];
  const haystack = norm(copyText);
  const copyNums = new Set(numberTokens(copyText));

  let offerLine = String(raw.offer_line || raw.offerLine || '').replace(/\s+/g, ' ').trim();
  offerLine = offerLine.replace(/^we emailed you about\s+/i, '').replace(/[.!\s]+$/, '');
  if (offerLine) {
    if (offerLine.length > 220) { reasons.push('offer_too_long'); offerLine = ''; }
    else if (hasMergeTag(offerLine)) { reasons.push('offer_merge_tag'); offerLine = ''; }
    else if (/[.!?]\s+\S/.test(offerLine)) { reasons.push('offer_not_one_sentence'); offerLine = ''; }
    else if (numberTokens(offerLine).some((n) => !copyNums.has(n))) {
      reasons.push('offer_number_not_in_copy');
      offerLine = '';
    }
  }

  let proofPoint = String(raw.proof_point || raw.proofPoint || '').replace(/\s+/g, ' ').trim();
  if (proofPoint) {
    const nums = numberTokens(proofPoint);
    if (proofPoint.length > 320) { reasons.push('proof_too_long'); proofPoint = ''; }
    else if (hasMergeTag(proofPoint)) { reasons.push('proof_merge_tag'); proofPoint = ''; }
    else if (!nums.length) { reasons.push('proof_no_number'); proofPoint = ''; }
    else if (!haystack.includes(norm(proofPoint))) { reasons.push('proof_not_verbatim'); proofPoint = ''; }
    else if (nums.some((n) => !copyNums.has(n))) { reasons.push('proof_number_not_in_copy'); proofPoint = ''; }
  }

  return { offerLine: offerLine || null, proofPoint: proofPoint || null, reasons };
}

const SYSTEM = `You read a company's own cold-email copy and pull out two things. Output JSON only.

{"offer_line": string|null, "proof_point": string|null}

offer_line: a short phrase (max 25 words, no period) that completes the sentence "We emailed you about ____". It names what is offered and the value, e.g. "cutting your monthly IT support cost without changing providers". Use only what the copy says. Any number in it must appear in the copy. No merge tags.

proof_point: ONE sentence copied EXACTLY, word for word, from the copy, that states a concrete result or track record for the sender's company and contains a real number (a percentage, dollar amount, count of clients, timeframe). If no sentence in the copy has that, return null. Never paraphrase, never combine sentences, never round, never invent. A guarantee or a vague claim with no number is not proof.`;

async function defaultLlm({ system, user }) {
  const { anthropicModel } = require('./anthropic-model');
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: anthropicModel(),
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic extract failed (${res.status})`);
  const data = JSON.parse(text);
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function parseJsonLoose(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/** Extract + validate. `llm` is injectable for tests. */
async function extractFromCopy(copyText, { llm = defaultLlm } = {}) {
  const copy = String(copyText || '').slice(0, MAX_COPY_CHARS);
  if (!copy.trim()) return { offerLine: null, proofPoint: null, reasons: ['no_copy'] };
  const out = await llm({ system: SYSTEM, user: `CAMPAIGN COPY:\n"""\n${copy}\n"""` });
  const parsed = parseJsonLoose(out);
  if (!parsed) return { offerLine: null, proofPoint: null, reasons: ['llm_unparseable'] };
  return validateExtraction(copy, parsed);
}

/** Outbound campaign mail in a stored thread: every message before the first reply. */
function copyFromThreadContext(platform, threadContext) {
  let tc = threadContext;
  if (typeof tc === 'string') { try { tc = JSON.parse(tc); } catch { tc = null; } }
  if (!tc || typeof tc !== 'object') return '';
  const parts = [];
  if (platform === 'smartlead') {
    const history = Array.isArray(tc.history) ? tc.history : [];
    for (const m of history) {
      const type = String(m?.type || '').toUpperCase();
      if (type === 'REPLY') break;
      if (type === 'SENT') {
        const t = htmlToPlain(m.email_body || m.body || '');
        if (t) parts.push(t);
      }
    }
  } else {
    const msgs = Array.isArray(tc.messages) ? tc.messages : [];
    for (const m of msgs) {
      const role = String(m?.role || '').toLowerCase();
      if (role === 'them') break;
      if (role === 'us' || role === 'me') {
        const t = String(m.message || m.text || '').trim();
        if (t) parts.push(t);
      }
    }
  }
  return parts.join('\n\n');
}

function hashCopy(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

/**
 * Offer + proof for one lead's campaign. Reads the cache; on a miss pulls the
 * campaign sequence (SmartLead), falls back to the first outbound mail in the
 * lead's own thread, extracts, validates, caches.
 *
 * @returns {{ offerLine: string|null, proofPoint: string|null, source: string }}
 */
async function resolveOfferAndProof({
  client, campaignId, platform, threadContext,
  fetchSequence, llm, dbClient = db,
}) {
  const camp = campaignId != null ? String(campaignId) : '';
  const { rows: found } = await dbClient.query(
    `SELECT offer_line, proof_point, source, source_hash, campaign_id
       FROM followup_sequence_copy
      WHERE client_id = $1 AND campaign_id IN ($2, '')
      ORDER BY (campaign_id = $2) DESC`,
    [client.id, camp],
  );
  // A hand-entered row (this campaign, else client-wide) always wins.
  const manual = found.find((r) => r.source === 'manual');
  if (manual) {
    return { offerLine: manual.offer_line, proofPoint: manual.proof_point, source: 'manual' };
  }
  const cached = found.find((r) => r.campaign_id === camp) || null;

  let copy = '';
  let copySource = 'none';
  const getSeq = fetchSequence || (async () => {
    if (platform !== 'smartlead' || !client.smartlead_api_key || !camp) return [];
    return require('./smartlead').getCampaignSequence(client.smartlead_api_key, camp);
  });
  try {
    const seq = await getSeq();
    copy = (seq || []).map((s) => htmlToPlain(s.body)).filter(Boolean).join('\n\n');
    if (copy) copySource = 'campaign_sequence';
  } catch (err) {
    console.warn('[FollowupSeq] campaign sequence fetch failed', { campaignId: camp, err: err.message });
  }
  if (!copy) {
    copy = copyFromThreadContext(platform, threadContext);
    if (copy) copySource = 'thread_outbound';
  }
  if (!copy) {
    return { offerLine: cached?.offer_line || null, proofPoint: cached?.proof_point || null, source: 'none' };
  }

  const hash = hashCopy(copy);
  if (cached && cached.source_hash === hash) {
    return { offerLine: cached.offer_line, proofPoint: cached.proof_point, source: copySource };
  }

  let result;
  try {
    result = await extractFromCopy(copy, { llm });
  } catch (err) {
    console.warn('[FollowupSeq] offer/proof extraction failed', { campaignId: camp, err: err.message });
    return { offerLine: cached?.offer_line || null, proofPoint: cached?.proof_point || null, source: 'error' };
  }
  if (result.reasons.length) {
    console.log('[FollowupSeq] extraction rejected parts', { campaignId: camp, reasons: result.reasons });
  }
  await dbClient.query(
    `INSERT INTO followup_sequence_copy (client_id, campaign_id, offer_line, proof_point, source, source_hash, extracted_at)
     VALUES ($1, $2, $3, $4, 'campaign_copy', $5, now())
     ON CONFLICT (client_id, campaign_id) DO UPDATE
       SET offer_line = EXCLUDED.offer_line, proof_point = EXCLUDED.proof_point,
           source_hash = EXCLUDED.source_hash, extracted_at = now()
     WHERE followup_sequence_copy.source <> 'manual'`,
    [client.id, camp, result.offerLine, result.proofPoint, hash],
  );
  return { offerLine: result.offerLine, proofPoint: result.proofPoint, source: copySource };
}

module.exports = {
  htmlToPlain,
  numberTokens,
  validateExtraction,
  extractFromCopy,
  copyFromThreadContext,
  resolveOfferAndProof,
  hashCopy,
};
