const { stripHtmlToText } = require('./smartlead-webhook-helpers');

/**
 * Flatten SmartLead / HeyReach thread_context into chronological messages
 * for Slack FOLLOW_UP cards ("all messages between us").
 */

function cleanBody(raw) {
  const plain = stripHtmlToText(raw) || String(raw || '');
  return plain.replace(/\s+/g, ' ').trim();
}

function parseContext(threadContext) {
  if (!threadContext) return null;
  if (typeof threadContext === 'string') {
    try { return JSON.parse(threadContext); } catch { return null; }
  }
  return typeof threadContext === 'object' ? threadContext : null;
}

function messageList(platform, tc) {
  if (!tc) return [];
  if (platform === 'heyreach') {
    if (Array.isArray(tc)) return tc;
    if (Array.isArray(tc.messages)) return tc.messages;
    return [];
  }
  // smartlead
  if (Array.isArray(tc.history)) return tc.history;
  if (Array.isArray(tc.messages)) return tc.messages;
  if (Array.isArray(tc)) return tc;
  return [];
}

function classifySmartlead(m) {
  const type = String(m.type || m.direction || '').toUpperCase();
  if (type === 'SENT' || type === 'OUTBOUND') return 'us';
  if (type === 'REPLY' || type === 'INBOUND') return 'them';
  return null;
}

function classifyHeyreach(m) {
  const role = String(m.role || m.sender || '').toLowerCase();
  if (role === 'us' || role === 'me' || role === 'sender' || role === 'user') return 'us';
  if (role === 'them' || role === 'lead' || role === 'prospect' || role === 'correspondent') return 'them';
  // Heuristic: if it looks like our outbound role labels missed, leave unknown out
  return null;
}

function bodyFrom(m) {
  return cleanBody(
    m.email_body || m.body || m.text || m.message || m.html || ''
  );
}

/**
 * Times reach this module in three shapes and must come out as one.
 *
 * SmartLead/HeyReach payloads carry ISO strings, but rows read back from
 * Postgres carry real Date objects (node-pg hydrates timestamptz), and some
 * payloads use epoch millis. The sort below compares with localeCompare, so a
 * Date reaching it throws `a.time.localeCompare is not a function` — which is
 * exactly what killed every FOLLOW_UP card between 2026-08-09 and 2026-08-13
 * (follow-up-runner's priorSentMessages passes `time: r.updated_at`).
 *
 * ISO is the normal form on purpose: it sorts lexicographically, so normalised
 * Dates order correctly against the ISO strings already in thread history.
 */
function normalizeTime(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return String(value);
}

function timeFrom(m) {
  return normalizeTime(m.time || m.sent_at || m.received_at || m.created_at || m.timestamp);
}

/**
 * @returns {{ role: 'us'|'them', body: string, time: string }[]}
 */
function extractThreadMessages(platform, threadContext, {
  maxMessages = 12,
  extraMessages = [],
  /** Prefer keeping the start of the thread (original inbound + our reply). */
  pinStart = false,
} = {}) {
  const tc = parseContext(threadContext);
  const list = messageList(platform, tc);
  const out = [];

  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = platform === 'heyreach' ? classifyHeyreach(m) : classifySmartlead(m);
    if (!role) continue;
    const body = bodyFrom(m);
    if (!body) continue;
    // Skip obvious system noise
    if (/^\(no new reply/i.test(body)) continue;
    out.push({ role, body, time: timeFrom(m) });
  }

  for (const extra of extraMessages) {
    if (!extra || !extra.body) continue;
    const body = cleanBody(extra.body);
    if (!body) continue;
    const role = extra.role === 'them' ? 'them' : 'us';
    // Avoid exact duplicate of the last same-role message
    const last = out[out.length - 1];
    if (last && last.role === role && last.body.toLowerCase() === body.toLowerCase()) continue;
    // Also skip if identical body already present
    if (out.some((x) => x.role === role && x.body.toLowerCase() === body.toLowerCase())) continue;
    out.push({ role, body, time: normalizeTime(extra.time) });
  }

  // Keep chronological when times exist; otherwise keep insertion order.
  // String() belt-and-braces: normalizeTime already guarantees strings, but the
  // comparator must never be the thing that throws — a sort error here takes
  // down the whole card, and the card is the only way a reply reaches a human.
  out.sort((a, b) => {
    if (a.time && b.time && a.time !== b.time) {
      return String(a.time).localeCompare(String(b.time));
    }
    return 0;
  });

  if (out.length <= maxMessages) return out;

  if (pinStart) {
    // Keep the opening exchange + the most recent turns so the original inbound
    // is never dropped when history is long.
    const headCount = Math.min(2, out.length);
    const tailCount = Math.max(0, maxMessages - headCount);
    const head = out.slice(0, headCount);
    const tail = out.slice(out.length - tailCount);
    const seen = new Set();
    const merged = [];
    for (const m of [...head, ...tail]) {
      const key = `${m.role}|${m.body.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(m);
    }
    return merged;
  }

  return out.slice(out.length - maxMessages);
}

module.exports = {
  extractThreadMessages,
  cleanBody,
};
