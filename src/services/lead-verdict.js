/**
 * ICP fit + decision-maker verdicts for one contact, for email-waterfall's
 * call-ready enrichment (POST /internal/lead-verdict).
 *
 * ICP reuses resolveReplyIcp (same topup grader, same Fireflies-built
 * clients.icp_profile). Decision maker is an AI verdict against the client's
 * buyer personas, with the deterministic floor from decision-maker.js
 * applied first: sales reps / coordinators are always "no".
 *
 * Never writes pending_replies, dl_status, sg_exclude or skip_*.
 * Logs carry the client tag and verdicts only, never a lead row.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { geminiModel } = require('./gemini-model');
const { resolveReplyIcp, resolveClientTag } = require('./reply-icp');
const { judgeDecisionMaker, targetPersonas } = require('./decision-maker');

const DM_ESTIMATE_USD = 0.001;

async function findClientByTag(db, clientTag) {
  const want = resolveClientTag(clientTag);
  const { rows } = await db.query('SELECT id, name, icp_profile FROM clients');
  return rows.find((r) => resolveClientTag(r.name) === want) || null;
}

async function aiDecisionMaker({ title, companyName, personas, model }) {
  if (!model && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const m = model || new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({
    model: process.env.LEAD_DM_MODEL || geminiModel(),
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 200,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const prompt = [
    'Decide if this person can approve buying an outsourced B2B lead-generation / outbound service for their company.',
    'A decision maker owns budget or the buying decision: owner, founder, C-level, president, partner, GM, VP, director or head of the relevant function.',
    'Sales reps, account executives, BDR/SDRs, coordinators, assistants, specialists and interns are NOT decision makers.',
    personas.length ? `The client's target buyer titles: ${personas.join('; ')}.` : '',
    `Title: ${title}`,
    companyName ? `Company: ${companyName}` : '',
    'Reply JSON: {"verdict":"yes"|"no"|"unknown","reason":"<= 15 words"}',
  ].filter(Boolean).join('\n');
  const res = await m.generateContent(prompt);
  let parsed = {};
  try { parsed = JSON.parse(res?.response?.text?.() || '{}'); } catch { parsed = {}; }
  const v = String(parsed.verdict || '').toLowerCase();
  return {
    verdict: ['yes', 'no', 'unknown'].includes(v) ? v : 'unknown',
    reason: String(parsed.reason || '').slice(0, 160),
  };
}

async function leadVerdict(db, {
  client_tag: clientTag, domain, company_name: companyName, title,
} = {}, { gradeFn, dmModel } = {}) {
  const client = await findClientByTag(db, clientTag);
  const out = {
    ok: true,
    client_found: Boolean(client),
    icp_verdict: 'unknown',
    icp_reason: '',
    dm_verdict: 'unknown',
    dm_reason: '',
    cost_usd: 0,
  };

  // ICP fit (company-level)
  if (domain) {
    const icp = await resolveReplyIcp({
      website: domain,
      clientName: client?.name || clientTag,
      clientId: client?.id,
      db,
      grade: true,
      gradeFn,
    });
    out.icp_verdict = icp.status || 'unknown';
    out.icp_reason = icp.reason || '';
    out.cost_usd += Number(icp.costUsd || 0);
  } else {
    out.icp_reason = 'no company domain';
  }

  // Decision maker (person-level)
  const personas = targetPersonas(client?.icp_profile);
  const floor = judgeDecisionMaker(title, personas);
  if (!title) {
    out.dm_reason = 'title unknown';
  } else if (floor.status === 'no' && /sales role|not a buying role/.test(floor.reason)) {
    out.dm_verdict = 'no';
    out.dm_reason = floor.reason;
  } else {
    try {
      const ai = await aiDecisionMaker({ title, companyName, personas, model: dmModel });
      out.dm_verdict = ai.verdict;
      out.dm_reason = ai.reason || floor.reason;
      out.cost_usd += DM_ESTIMATE_USD;
    } catch (err) {
      out.dm_verdict = floor.status;
      out.dm_reason = `${floor.reason} (rules)`;
    }
  }
  out.cost_usd = Number(out.cost_usd.toFixed(6));
  console.log('[LeadVerdict]', { clientTag, icp: out.icp_verdict, dm: out.dm_verdict });
  return out;
}

module.exports = { leadVerdict, aiDecisionMaker, findClientByTag };
