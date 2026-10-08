/**
 * Deep Roots Always-notify gate.
 *
 * Tyler: do not email him on every approved send. Only when the prospect
 * looks qualified, meets employee + EBITDA standards, and wants to schedule
 * a call. Other clients are unchanged (notify on every send).
 *
 * Qualification is read from *prospect* text only. Our outbound copy already
 * says "$1M to $10M in EBITDA" — counting that would false-positive every thread.
 */

const { isDeepRootsClient } = require('./meeting-modality');

const EBITDA_MIN_USD = 1_000_000;
const EBITDA_MAX_USD = 10_000_000;
const EMPLOYEE_MIN = 10;
const EMPLOYEE_MAX = 500;

function historyList(threadContext) {
  if (!threadContext) return [];
  let tc = threadContext;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { return []; }
  }
  if (Array.isArray(tc)) return tc;
  if (Array.isArray(tc.history)) return tc.history;
  if (Array.isArray(tc.messages)) return tc.messages;
  return [];
}

function messageBody(m) {
  if (!m || typeof m !== 'object') return '';
  return String(m.email_body || m.body || m.text || m.message || m.email_message || '').trim();
}

function directionOf(m) {
  return String(m?.type || m?.direction || m?.role || m?.sender || '').toUpperCase();
}

function isProspectMessage(m) {
  const d = directionOf(m);
  return d === 'REPLY' || d === 'INBOUND' || d === 'PROSPECT' || d === 'THEM';
}

function isUsMessage(m) {
  const d = directionOf(m);
  return d === 'SENT' || d === 'OUTBOUND' || d === 'US' || d === 'ME' || d === 'USER';
}

function stripQuotedTail(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n(?=On .+ wrote:)/i)[0]
    .split(/\n(?=From:\s)/i)[0]
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function prospectTexts({ inboundMessage, threadContext, extraMessages } = {}) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const t = stripQuotedTail(raw);
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  for (const m of historyList(threadContext)) {
    if (isProspectMessage(m)) push(messageBody(m));
  }
  for (const m of Array.isArray(extraMessages) ? extraMessages : []) {
    if (isProspectMessage(m) || String(m?.type || '').toUpperCase() === 'REPLY') {
      push(messageBody(m));
    }
  }
  push(inboundMessage);
  return out;
}

function lastUsThenProspect({ inboundMessage, threadContext, extraMessages } = {}) {
  const events = [];
  for (const m of historyList(threadContext)) {
    const body = stripQuotedTail(messageBody(m));
    if (!body) continue;
    if (isUsMessage(m)) events.push({ side: 'us', body });
    else if (isProspectMessage(m)) events.push({ side: 'prospect', body });
  }
  for (const m of Array.isArray(extraMessages) ? extraMessages : []) {
    const body = stripQuotedTail(messageBody(m));
    if (!body) continue;
    const type = String(m.type || '').toUpperCase();
    if (type === 'SENT' || isUsMessage(m)) events.push({ side: 'us', body });
    else if (type === 'REPLY' || isProspectMessage(m)) events.push({ side: 'prospect', body });
  }
  const inbound = stripQuotedTail(inboundMessage);
  if (inbound && !events.some((e) => e.side === 'prospect' && e.body.toLowerCase() === inbound.toLowerCase())) {
    events.push({ side: 'prospect', body: inbound });
  }

  let lastUs = '';
  let lastProspect = '';
  for (const e of events) {
    if (e.side === 'us') lastUs = e.body;
    if (e.side === 'prospect') lastProspect = e.body;
  }
  return {
    lastUs,
    lastProspect,
    events,
    prospectTexts: prospectTexts({ inboundMessage, threadContext, extraMessages }),
  };
}

function joinedProspectText(texts) {
  return texts.join('\n');
}

function parseUsdAmount(raw, unit) {
  const n = parseFloat(String(raw || '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || '').toLowerCase().replace(/\s+/g, '');
  if (!u) {
    if (n >= 50_000) return n;
    return null;
  }
  if (u.startsWith('b')) return n * 1e9;
  if (u === 'mm' || u.startsWith('m')) return n * 1e6;
  if (u.startsWith('k')) return n * 1e3;
  return null;
}

function extractMoneyMentions(text) {
  const s = String(text || '');
  const out = [];
  const re = /\$?\s*(\d+(?:\.\d+)?)\s*(billion|b|million|mm|m|k|thousand)?\b/gi;
  let m;
  while ((m = re.exec(s))) {
    const usd = parseUsdAmount(m[1], m[2]);
    if (usd != null) out.push({ usd, raw: m[0] });
  }
  return out;
}

function looksLikeEbitdaAsk(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return false;
  if (/\b(ebitda|ebita|ebit)\b/.test(s)) return true;
  if (/\b1\s*[-–to]+\s*10\s*m/.test(s) && /\b(ebitda|ebita|range|sound like you|ticket)\b/.test(s)) {
    return true;
  }
  if (/\b(does (that|this) sound like you|are you in that range)\b/.test(s)) return true;
  return false;
}

function looksLikeEbitdaAffirmation(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return false;
  if (/\b(not|no|smaller|below|under|less than|we'?re too small)\b/.test(s)
      && /\b(ebitda|range|that|1-10|million)\b/.test(s)) {
    return false;
  }
  return /\b(yes|yeah|yep|yup|correct|that'?s us|that'?s me|that is us|we are|we'?re in (that )?range|sounds like us|about right|ballpark|we do)\b/.test(s);
}

function extractEmployeeCount(text) {
  const s = String(text || '');
  const patterns = [
    /\b(\d{1,4})\s*(?:[-–]\s*\d{1,4}\s*)?(?:employees?|staff|headcount|people on (?:staff|payroll))\b/i,
    /\b(?:employees?|staff|headcount)\s*(?:of|is|are|:)?\s*(\d{1,4})\b/i,
    /\bteam of\s*(\d{1,4})\b/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function ebitdaVerdict({ prospectTexts: texts, lastUs, lastProspect, events = [] } = {}) {
  const combined = joinedProspectText(texts || []);
  const money = extractMoneyMentions(combined).filter((x) => {
    // Ignore our range repeated back without a claim ("what's your 1-10m")
    return x.usd >= 50_000;
  });

  const ebitdaNearby = (mention) => {
    const idx = combined.toLowerCase().indexOf(String(mention.raw).toLowerCase());
    const window = combined.slice(Math.max(0, idx - 40), idx + String(mention.raw).length + 40).toLowerCase();
    return /\b(ebitda|ebita|ebit|profit|earnings)\b/.test(window) || looksLikeEbitdaAsk(lastUs);
  };

  for (const mention of money) {
    if (!ebitdaNearby(mention) && !looksLikeEbitdaAsk(lastUs)) continue;
    if (mention.usd < EBITDA_MIN_USD || mention.usd > EBITDA_MAX_USD) {
      return { status: 'out_of_range', usd: mention.usd };
    }
    return { status: 'in_range', usd: mention.usd };
  }

  // Only the next prospect turn after an EBITDA ask can affirm. A dodge
  // (Neel: "What will you require?") clears the ask so a later "yes we
  // are" about ownership does not count.
  let pendingAsk = false;
  for (const e of events) {
    if (e.side === 'us') {
      pendingAsk = looksLikeEbitdaAsk(e.body);
      continue;
    }
    if (e.side === 'prospect' && pendingAsk) {
      if (looksLikeEbitdaAffirmation(e.body)) {
        return { status: 'in_range', usd: null, via: 'affirmed_range' };
      }
      pendingAsk = false;
    }
  }
  if (pendingAsk && looksLikeEbitdaAffirmation(lastProspect)) {
    return { status: 'in_range', usd: null, via: 'affirmed_range' };
  }

  if (/\b(in that range|we'?re in (the )?range|that(?:'s| is) us)\b/i.test(combined)
      && /\b(ebitda|1\s*[-–to]+\s*10)\b/i.test(combined + ' ' + lastUs)) {
    return { status: 'in_range', usd: null, via: 'range_claim' };
  }

  return { status: 'unknown' };
}

function employeeVerdict(texts) {
  const combined = joinedProspectText(texts || []);
  const n = extractEmployeeCount(combined);
  if (n == null) return { status: 'unknown', count: null };
  if (n < EMPLOYEE_MIN || n > EMPLOYEE_MAX) {
    return { status: 'out_of_range', count: n };
  }
  return { status: 'in_range', count: n };
}

function wantsToScheduleCall(text, classification) {
  if (String(classification || '').toUpperCase() === 'MEETING_PROPOSED') return true;
  const s = String(text || '');
  if (!s.trim()) return false;

  if (/\b(monday|tuesday|wednesday|thursday|friday|tomorrow|today|next week)\b/i.test(s)
      && /\b(\d{1,2}\s*(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|\d{1,2}\s*-\s*\d{1,2}|noon|morning|afternoon|evening)\b/i.test(s)) {
    return true;
  }
  if (/\b\d{1,2}\s*(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\s*(est|edt|cst|cdt|mst|mdt|pst|pdt)?\b/i.test(s)) {
    return true;
  }
  if (/\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|next week)\b/i.test(s)
      && /\b(works?|free|available|open|good|fine|perfect)\b/i.test(s)) {
    return true;
  }
  if (/\b(let'?s (schedule|set (up|a time)|book|talk|chat)|set up a (call|time|meeting)|book a (call|time)|give me a call|call me|i'?m free|send (me )?an invite)\b/i.test(s)) {
    return true;
  }
  return false;
}

/**
 * @returns {string|null} skip reason, or null when Tyler should be emailed
 */
function deepRootsClientNotifySkipReason({
  clientName,
  inboundMessage,
  threadContext,
  extraMessages,
  classification,
} = {}) {
  if (!isDeepRootsClient(clientName)) return null;

  const ctx = lastUsThenProspect({ inboundMessage, threadContext, extraMessages });
  const latest = ctx.lastProspect || stripQuotedTail(inboundMessage);
  const allProspect = joinedProspectText(ctx.prospectTexts);

  if (!wantsToScheduleCall(latest, classification) && !wantsToScheduleCall(allProspect, classification)) {
    return 'not_scheduling';
  }

  const ebitda = ebitdaVerdict(ctx);
  if (ebitda.status === 'out_of_range') return 'ebitda_out_of_range';
  if (ebitda.status !== 'in_range') return 'ebitda_unconfirmed';

  const employees = employeeVerdict(ctx.prospectTexts);
  if (employees.status === 'out_of_range') return 'employees_out_of_range';
  // Unknown headcount does not block once EBITDA is confirmed. Tyler named both
  // standards; a stated too-small shop still kills the alert. We do not ask
  // headcount on every first touch, so silence is not a fail.
  return null;
}

function shouldNotifyDeepRootsClient(opts) {
  return !deepRootsClientNotifySkipReason(opts);
}

module.exports = {
  EBITDA_MIN_USD,
  EBITDA_MAX_USD,
  EMPLOYEE_MIN,
  EMPLOYEE_MAX,
  deepRootsClientNotifySkipReason,
  shouldNotifyDeepRootsClient,
  wantsToScheduleCall,
  ebitdaVerdict,
  employeeVerdict,
  prospectTexts,
  extractEmployeeCount,
};
