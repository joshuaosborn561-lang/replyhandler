/**
 * Clean FOLLOW_UP thread turns for Slack: quoted history, signatures, and
 * legal disclaimers stripped. Prospect turns stay in full. Our older turns
 * trim to ~400 chars; the last two stay in full.
 */

const {
  stripHtmlToText,
  stripEmailQuotePrefix,
  stripOutlookCss,
} = require('./smartlead-webhook-helpers');

const DISPLAY_TZ = 'America/Chicago';
const OLDER_TURN_MAX = 400;

const SIGNATURE_LINE = /(\+?\d[\d\s().-]{8,}\d)|(https?:\/\/|www\.)|(\S+@\S+\.\S+)|(\s\|\s)|^(ceo|founder|co-founder|president|owner|director|manager|vp|chief|head of)\b/i;
const CLOSING_LINE = /^(best|best regards|kind regards|warm regards|regards|thanks|thanks again|thank you|cheers|talk soon|speak soon|sincerely|all the best|appreciate it|looking forward)[,!.]?\s*(\w+)?$/i;
const NAME_LINE = /^[A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.&-]*){0,2}$/u;
const DISCLAIMER_LINE = /confidential|privileged|intended solely|not the intended recipient|please consider the environment|this (e-?mail|message) and any attachments|circulars 230|disclaimer:|unsubscribe|view (this|it) in (your )?browser/i;

function stripTrailingSignature(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const sep = lines.findIndex((l) => /^--\s*$/.test(l.trim()));
  if (sep > 0) lines.splice(sep);

  const popBlank = () => { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); };
  popBlank();
  let poppedSig = 0;
  while (lines.length > 1 && SIGNATURE_LINE.test(lines[lines.length - 1].trim())) {
    lines.pop();
    poppedSig += 1;
    popBlank();
  }
  for (let i = 0; i < 3 && poppedSig > 0 && lines.length > 1; i += 1) {
    const last = lines[lines.length - 1].trim();
    if (last.length <= 40 && NAME_LINE.test(last)) { lines.pop(); popBlank(); continue; }
    break;
  }
  popBlank();
  for (let guard = 0; guard < 3 && lines.length > 1; guard += 1) {
    const last = lines[lines.length - 1].trim();
    if (CLOSING_LINE.test(last)) { lines.pop(); popBlank(); continue; }
    if (/^[-–—]\s*[A-Z][\p{L}'’.-]*$/u.test(last)) { lines.pop(); popBlank(); continue; }
    if (last.length <= 40 && NAME_LINE.test(last) && last.split(/\s+/).length <= 2) {
      lines.pop();
      popBlank();
      continue;
    }
    break;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripDisclaimerBlocks(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex((l) => DISCLAIMER_LINE.test(l) && l.trim().length > 12);
  if (cut <= 0) return String(text || '').trim();
  return lines.slice(0, cut).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanThreadBody(raw) {
  let t = stripHtmlToText(raw) || String(raw || '');
  t = stripOutlookCss(t);
  t = stripEmailQuotePrefix(t);
  t = t.replace(/\[cid:[^\]]+\]/gi, ' ');
  // Disclaimer first so a trailing legal block does not hide the signature
  // lines that sit above it.
  t = stripDisclaimerBlocks(t);
  t = stripTrailingSignature(t);
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function trimThreadBody(body, { full = false, maxLen = OLDER_TURN_MAX } = {}) {
  const t = String(body || '').trim();
  if (full || t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function formatThreadDate(iso, timeZone = DISPLAY_TZ) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || DISPLAY_TZ,
      month: 'short',
      day: 'numeric',
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
  }
}

function threadTurnLabel(role, time, timeZone = DISPLAY_TZ) {
  const who = role === 'us' ? 'us' : 'them';
  const date = formatThreadDate(time, timeZone);
  return date ? `${who} · ${date}` : who;
}

/**
 * Identity for one thread turn.
 *
 * Smartlead history, the stored sent_reply, and the "last outbound" extra are
 * often the same email with a signature, a link bracket, or different
 * whitespace. Exact body match kept all of them, so one send showed up two or
 * three times on the follow-up card.
 *
 * A later turn that only adds a short tail (signature, "Miyu Suzuki / Emcor")
 * is the same email. A rewrite that diverges in the middle is not.
 */
function threadTurnKey(body) {
  let t = cleanThreadBody(body);
  t = t.replace(/\s*\[https?:\/\/[^\]]+\]/gi, '');
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameThreadTurn(a, b) {
  if (!a || !b) return false;
  const idA = a.messageId || a.message_id || '';
  const idB = b.messageId || b.message_id || '';
  if (idA && idB && idA === idB) return true;
  const roleA = a.role === 'us' ? 'us' : 'them';
  const roleB = b.role === 'us' ? 'us' : 'them';
  if (roleA !== roleB) return false;
  const ka = threadTurnKey(a.body || a.text || a.message || '');
  const kb = threadTurnKey(b.body || b.text || b.message || '');
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const short = ka.length <= kb.length ? ka : kb;
  const long = ka.length <= kb.length ? kb : ka;
  if (short.length < 60) return false;
  if (!long.startsWith(short)) return false;
  return (long.length - short.length) <= 180;
}

function dedupeThreadTurns(messages) {
  const kept = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (kept.some((k) => sameThreadTurn(k, m))) continue;
    kept.push(m);
  }
  return kept;
}

/**
 * Oldest → newest, signatures stripped, older turns trimmed, last two full.
 * Repeated copies of the same email are dropped first.
 */
function prepareFollowUpThreadTurns(threadMessages, { timeZone = DISPLAY_TZ } = {}) {
  const raw = dedupeThreadTurns(threadMessages);
  const cleaned = [];
  for (const m of raw) {
    if (!m) continue;
    const body = cleanThreadBody(m.body || m.text || m.message || '');
    if (!body) continue;
    cleaned.push({
      role: m.role === 'us' ? 'us' : 'them',
      body,
      time: m.time || '',
    });
  }
  return cleaned.map((m, i) => {
    const full = m.role === 'them' || i >= cleaned.length - 2;
    return {
      ...m,
      display: trimThreadBody(m.body, { full }),
      label: threadTurnLabel(m.role, m.time, timeZone),
      full,
    };
  });
}

function formatThreadForPrompt(threadMessages) {
  const turns = prepareFollowUpThreadTurns(threadMessages);
  if (!turns.length) return '(no prior thread available)';
  return turns.map((m) => {
    const who = m.role === 'us' ? 'Josh' : 'Prospect';
    const when = m.time ? ` [${m.time}]` : '';
    return `${who}${when}: ${m.body}`;
  }).join('\n\n');
}

function daysSinceLastMessage(threadMessages, fallbackDate) {
  const times = [];
  for (const m of Array.isArray(threadMessages) ? threadMessages : []) {
    if (m && m.time) times.push(m.time);
  }
  const last = times.length ? times[times.length - 1] : fallbackDate;
  if (!last) return null;
  const ms = Date.now() - new Date(last).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / (24 * 60 * 60 * 1000) * 10) / 10);
}

module.exports = {
  OLDER_TURN_MAX,
  cleanThreadBody,
  trimThreadBody,
  formatThreadDate,
  threadTurnLabel,
  threadTurnKey,
  sameThreadTurn,
  dedupeThreadTurns,
  prepareFollowUpThreadTurns,
  formatThreadForPrompt,
  daysSinceLastMessage,
  stripTrailingSignature,
  stripDisclaimerBlocks,
};
