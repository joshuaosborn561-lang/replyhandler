/**
 * A referred contact is an email the prospect typed in the human reply,
 * asking us to talk to that person. Signatures, quoted history, and
 * disclaimer / scanner footers are not that email. Never invent an address
 * from a name.
 */

const { looksLikeReferral, normalizeEmail, isAutoReplyAddress } = require('./reply-all');
const {
  humanTextForClassification,
  looksLikeHtml,
} = require('./smartlead-webhook-helpers');

const EMAIL_RE = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const GENERIC_LOCAL = new Set([
  'info', 'sales', 'admin', 'support', 'hello', 'contact', 'team', 'office',
  'hr', 'billing', 'legal', 'privacy', 'noreply', 'no-reply', 'mail',
  'newsletter', 'webmaster', 'jobs', 'careers',
]);

function stripDivsMatching(html, attrRe) {
  const s = String(html || '');
  const openRe = /<div\b[^>]*>/gi;
  let out = '';
  let i = 0;
  while (i < s.length) {
    openRe.lastIndex = i;
    const m = openRe.exec(s);
    if (!m) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, m.index);
    const tag = m[0];
    if (!attrRe.test(tag)) {
      out += tag;
      i = m.index + tag.length;
      continue;
    }
    let depth = 1;
    let j = m.index + tag.length;
    const token = /<\/?div\b[^>]*>/gi;
    token.lastIndex = j;
    let closed = false;
    let t;
    while ((t = token.exec(s))) {
      if (/^<\/div/i.test(t[0])) depth -= 1;
      else depth += 1;
      if (depth === 0) {
        j = t.index + t[0].length;
        closed = true;
        break;
      }
    }
    i = closed ? j : s.length;
  }
  return out;
}

/** Drop Gmail signature and quoted-thread blocks before text extraction. */
function stripSignatureAndQuoteHtml(raw) {
  let html = String(raw || '');
  if (!looksLikeHtml(html)) return html;
  html = stripDivsMatching(html, /data-smartmail\s*=\s*["']gmail_signature["']/i);
  html = stripDivsMatching(html, /class\s*=\s*["'][^"']*gmail_signature[^"']*["']/i);
  html = stripDivsMatching(html, /class\s*=\s*["'][^"']*gmail_quote[^"']*["']/i);
  html = html.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, ' ');
  return html;
}

function isLoneEmailLine(line) {
  return /^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/i.test(String(line || '').trim());
}

function isNameLine(line) {
  const l = String(line || '').trim();
  if (!l || l.length > 60 || /[.!?]/.test(l)) return false;
  if (/\b(please|talk|speak|contact|email|reach|thanks|thank|hi|hello|hey)\b/i.test(l)) return false;
  const words = l.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[\p{Lu}][\p{L}'’.-]*$/u.test(w));
}

function isLabeledContactLine(line) {
  return /^(?:e|email|c|cell|m|mobile|p|phone|ph|t|tel|w|web|o|office)\s*[:.-]\s*\S/i.test(String(line || '').trim());
}

function isPhoneLine(line) {
  return /^\+?[\d\s().-]{10,}$/.test(String(line || '').trim());
}

function isTitleOrUrlLine(line) {
  const l = String(line || '').trim();
  if (!l || l.length > 120) return false;
  if (/^--\s*$/.test(l)) return true;
  if (/^sent from my\b/i.test(l)) return true;
  if (/^https?:\/\/\S+$/i.test(l) || /^www\.\S+$/i.test(l)) return true;
  if (/^(senior|sr\.?|junior|jr\.?|lead|head|chief|director|manager|vp|vice president|president|founder|co-founder|owner|partner|principal|designer|engineer|counsel|attorney|analyst|coordinator|specialist|administrator|associate|officer|consultant)\b/i.test(l) && !/[.?!]/.test(l)) {
    return true;
  }
  return false;
}

function prospectNameMatches(line, prospectName) {
  const l = String(line || '').trim().toLowerCase();
  const prospect = String(prospectName || '').trim().toLowerCase();
  if (!l || !prospect) return false;
  if (l === prospect) return true;
  const parts = prospect.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && l === `${parts[0]} ${parts[parts.length - 1]}`) return true;
  return false;
}

function nextNonBlankAbove(lines, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = String(lines[i] || '').trim();
    if (line) return line;
  }
  return '';
}

/**
 * Trailing signature block. A lone email above that block stays — that is
 * how "talk to Guy" plus Guy@... is written. The sender's own address under
 * their name does not.
 */
function cutTrailingSignature(text, { prospectName, prospectEmail } = {}) {
  const lines = String(text || '').split('\n');
  let end = lines.length;
  let sawFurniture = false;
  let sawName = false;
  const prospectEmailNorm = normalizeEmail(prospectEmail);

  while (end > 0) {
    const line = lines[end - 1].trim();
    if (!line) {
      end -= 1;
      continue;
    }
    if (isLoneEmailLine(line)) {
      const email = normalizeEmail(line);
      if (email && email === prospectEmailNorm) {
        sawFurniture = true;
        end -= 1;
        continue;
      }
      const above = nextNonBlankAbove(lines, end - 1);
      const aboveIsSignature = Boolean(above) && (
        isNameLine(above)
        || prospectNameMatches(above, prospectName)
        || isTitleOrUrlLine(above)
        || isLabeledContactLine(above)
        || isPhoneLine(above)
        || isLoneEmailLine(above)
      );
      // Under a name, title, or another signature line: the sender's address.
      // A lone address with the human sentence above it stays.
      if (aboveIsSignature) {
        sawFurniture = true;
        end -= 1;
        continue;
      }
      break;
    }
    const furniture = isLabeledContactLine(line)
      || isPhoneLine(line)
      || isTitleOrUrlLine(line)
      || prospectNameMatches(line, prospectName)
      || (sawFurniture && isNameLine(line))
      || (sawFurniture && isNameLine(line) === false && line.length <= 40 && !/[.?!]/.test(line) && line.split(/\s+/).length <= 4 && /[\p{L}]/u.test(line) && !/\b(please|talk|thanks|thank)\b/i.test(line));
    if (furniture) {
      if (isNameLine(line) || prospectNameMatches(line, prospectName)) sawName = true;
      sawFurniture = true;
      end -= 1;
      continue;
    }
    break;
  }
  return lines.slice(0, end).join('\n').trim();
}

function emailsInText(text) {
  const found = [];
  const seen = new Set();
  const s = String(text || '');
  for (const match of s.match(EMAIL_RE) || []) {
    const email = match.replace(/[)>.,;:]+$/g, '');
    const key = normalizeEmail(email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    found.push(email);
  }
  return found;
}

function mailtoEmails(html) {
  const found = [];
  const seen = new Set();
  const re = /mailto:([^"'>\s]+)/gi;
  let m;
  const s = String(html || '');
  while ((m = re.exec(s))) {
    const email = decodeURIComponent(m[1]).replace(/[)>.,;:]+$/g, '');
    const key = normalizeEmail(email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    found.push(email);
  }
  return found;
}

function humanReplyForReferral(raw, opts = {}) {
  const cleanedHtml = stripSignatureAndQuoteHtml(raw);
  const classified = humanTextForClassification(cleanedHtml);
  return cutTrailingSignature(classified, opts);
}

function excludedSet({ prospectEmail, ourEmails } = {}) {
  const out = new Set();
  const prospect = normalizeEmail(prospectEmail);
  if (prospect) out.add(prospect);
  const list = Array.isArray(ourEmails) ? ourEmails : [ourEmails];
  for (const raw of list) {
    const email = normalizeEmail(raw);
    if (email) out.add(email);
  }
  return out;
}

function isHandoff(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (looksLikeReferral(s)) return true;
  return /\b(talk|speak|contact|email|reach|loop|cc'?d|copying|colleague|instead)\b/i.test(s) && /@/.test(s);
}

function nameForEmail(text, email) {
  const key = normalizeEmail(email);
  const at = String(text || '').toLowerCase().indexOf(key);
  const before = at >= 0 ? String(text).slice(Math.max(0, at - 180), at) : String(text || '');
  const named = before.match(/\b(?:talk|speak|contact|email|reach|loop(?:ing)?(?:\s+in)?|cc)\s+(?:to\s+|with\s+)?([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,2})/u);
  if (named) {
    const full = named[1].trim();
    const local = key.split('@')[0].replace(/[._-]+/g, ' ');
    const first = full.split(/\s+/)[0];
    if (local.toLowerCase().includes(first.toLowerCase()) || first.toLowerCase().startsWith(local.split(' ')[0])) {
      return first;
    }
    return full;
  }
  const token = key.split('@')[0].split(/[._-]+/)[0];
  if (/^[A-Za-z]{2,}$/.test(token) && !GENERIC_LOCAL.has(token.toLowerCase())) {
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  }
  return '';
}

/**
 * @returns {{ name: string, email: string }[]}
 */
function extractReferredContacts(raw, opts = {}) {
  const cleanedHtml = stripSignatureAndQuoteHtml(raw);
  const human = cutTrailingSignature(humanTextForClassification(cleanedHtml), opts);
  if (!isHandoff(human)) return [];
  const skip = excludedSet(opts);
  const seen = new Set();
  const contacts = [];
  const candidates = [...emailsInText(human), ...mailtoEmails(cleanedHtml)];
  for (const email of candidates) {
    const key = normalizeEmail(email);
    if (!key || seen.has(key) || skip.has(key) || isAutoReplyAddress(key)) continue;
    // A mailto that survived only inside a signature line we already cut
    // is not the human reply. It has to appear in the human text, or be a
    // mailto whose visible message we kept.
    // The address has to be in the human text. A mailto that only lived in
    // the signature or the quoted thread is already gone, and one that the
    // signature cutter dropped stays dropped.
    if (!human.toLowerCase().includes(key)) continue;
    seen.add(key);
    contacts.push({
      name: nameForEmail(human, email),
      email,
    });
  }
  return contacts;
}

function referralCcCsv(contacts) {
  return (contacts || []).map((c) => c.email).filter(Boolean).join(', ');
}

function referralCcButtonText(contacts) {
  const emails = (contacts || []).map((c) => c.email).filter(Boolean);
  if (!emails.length) return '';
  const full = `Approve & send with CC ${emails.join(', ')}`;
  if (full.length <= 75) return full;
  if (emails.length === 1) return full.slice(0, 74) + '…';
  return `Approve & send with CC (${emails.length})`;
}

const NOT_A_FIRST_NAME = new Set([
  ...GENERIC_LOCAL,
  'colleague', 'manager', 'management', 'ops', 'office', 'team', 'assistant',
  'director', 'person', 'contact', 'rep', 'representative', 'someone',
  'somebody', 'operations', 'support', 'please', 'thanks', 'thank',
]);

function looksLikeFirstName(token) {
  const raw = String(token || '').trim();
  const letters = raw.replace(/[^A-Za-z]/g, '');
  if (!/^[A-Za-z]{2,}$/.test(letters)) return '';
  if (NOT_A_FIRST_NAME.has(letters.toLowerCase())) return '';
  if (/^[A-Z][a-z]+$/.test(raw)) return raw;
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

function prospectFirstName(leadName) {
  const s = String(leadName || '').trim();
  if (!s || /^(unknown|prospect|linkedin(\s+prospect)?)$/i.test(s)) return 'there';
  const first = s.split(/\s+/)[0];
  return looksLikeFirstName(first) || 'there';
}

function firstNameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  const token = local.split(/[._+-]+/).filter(Boolean)[0] || '';
  return looksLikeFirstName(token);
}

/** First name the prospect typed. "talk to Guy" → Guy. Roles are not names. */
function referredFirstNameFromText(text) {
  const s = String(text || '');
  const patterns = [
    /\b(?:talk|speak|contact|email|reach(?:\s+out)?|connect|introduc(?:e|ed|ing)|loop(?:ing)?(?:\s+in)?|cc(?:'d|ed)?|copied|copying)\s+(?:to\s+|with\s+|in\s+)?(?:(?:my|our|the|a|an)\s+(?:colleague|manager|ops|team|assistant|director|person|contact)\s+)?([A-Z][\p{L}'’.-]+)/gu,
    /\b([A-Z][\p{L}'’.-]+)\s+(?:handles|manages|oversees)\b/gu,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(s))) {
      const name = looksLikeFirstName(match[1]);
      if (name) return name;
    }
  }
  return '';
}

function referredGreetingName({ human, contacts } = {}) {
  const fromText = referredFirstNameFromText(human);
  if (fromText) return fromText;
  const list = Array.isArray(contacts) ? contacts : [];
  for (const contact of list) {
    const named = looksLikeFirstName(String(contact?.name || '').split(/\s+/)[0]);
    if (named) return named;
  }
  for (const contact of list) {
    const fromEmail = firstNameFromEmail(contact?.email);
    if (fromEmail) return fromEmail;
  }
  return '';
}

/**
 * Cayden's referral reply. Exact two lines. No sign-off — the mailbox
 * appends its signature on send, same as every other draft.
 * Empty string when this is not a handoff.
 */
function referralDraftText({
  leadName,
  inboundMessage,
  referredContacts,
  prospectEmail,
  prospectName,
  ourEmails,
} = {}) {
  const opts = {
    prospectEmail,
    prospectName: prospectName || leadName,
    ourEmails,
  };
  const provided = (Array.isArray(referredContacts) ? referredContacts : [])
    .filter((c) => c && c.email);
  const extracted = inboundMessage ? extractReferredContacts(inboundMessage, opts) : [];
  const contacts = provided.length ? provided : extracted;
  const human = inboundMessage ? humanReplyForReferral(inboundMessage, opts) : '';
  const handoff = contacts.length > 0 || looksLikeReferral(human || inboundMessage || '');
  if (!handoff) return '';
  const prospect = prospectFirstName(leadName);
  const who = referredGreetingName({ human, contacts });
  const line2 = who
    ? `Hey ${who}, would this be worth meeting about for you guys?`
    : 'Hey there, would this be worth meeting about for you guys?';
  return `Thank you so much for the contact, ${prospect}!\n\n${line2}`;
}

function isFixedReferralDraft(text) {
  const s = String(text || '');
  return s.startsWith('Thank you so much for the contact,')
    && s.includes('would this be worth meeting about for you guys?');
}

function referralDraftNote({ leadName, contacts } = {}) {
  const list = Array.isArray(contacts) ? contacts.filter((c) => c && c.email) : [];
  if (!list.length) return '';
  const prospect = String(leadName || '').trim().split(/\s+/)[0] || 'they';
  const people = list.map((c) => (c.name ? `${c.name} (${c.email})` : c.email)).join(' and ');
  const who = list[0].name || 'them';
  return (
    `REFERRAL HANDOFF: ${prospect} asked us to talk to ${people}. ` +
    `Thank ${prospect} for the introduction and address ${who} directly in the same reply. ` +
    `The send will CC ${list.map((c) => c.email).join(', ')}. ` +
    'Do not invent any other person, company, or address.'
  );
}

/**
 * Edit field. Empty means send with no referral CC. A non-empty field that
 * is not an email fails closed. The prospect's own address is not a CC.
 */
function parseReferralCcInput(raw, { prospectEmail, ourEmails } = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { emails: [] };
  const found = emailsInText(text);
  if (!found.length) {
    return { error: 'No valid CC address in that field. Nothing was sent.' };
  }
  const skip = excludedSet({ prospectEmail, ourEmails });
  const emails = [];
  const seen = new Set();
  for (const email of found) {
    const key = normalizeEmail(email);
    if (!key || seen.has(key) || isAutoReplyAddress(key)) continue;
    if (skip.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  if (!emails.length) {
    return { error: 'That address is the prospect or our sender. Nothing was sent.' };
  }
  return { emails };
}

module.exports = {
  stripSignatureAndQuoteHtml,
  cutTrailingSignature,
  humanReplyForReferral,
  extractReferredContacts,
  referralCcCsv,
  referralCcButtonText,
  referralDraftNote,
  referralDraftText,
  isFixedReferralDraft,
  referredFirstNameFromText,
  referredGreetingName,
  parseReferralCcInput,
  emailsInText,
};
