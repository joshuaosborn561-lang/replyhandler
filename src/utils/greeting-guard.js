'use strict';

/**
 * The greeting on a drafted reply is the LEAD's first name, never the name of
 * anyone on our side (the sending persona or the inbox name). Josh, Oct 29 2026:
 * a draft opened "Hey Allisonb" where Allison is our sender.
 */

const { historyMessages, normalizeEmail, ourIdentitiesFromThread } = require('./reply-all');

const GREETING_RE = /^(\s*)(hey|hi|hello|dear)(\s+)([A-Za-z][A-Za-z'’.-]*)(\s*[,!:.-]?)/i;

function lc(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

/** Lower-case name tokens that belong to our side: sender display names, inbox local parts. */
function ourNameTokens({ threadContext, extraEmails = [], extraNames = [] } = {}) {
  const out = new Set();
  const addEmail = (e) => {
    const n = normalizeEmail(e);
    if (!n) return;
    const local = n.split('@')[0] || '';
    const whole = lc(local);
    if (whole.length >= 2) out.add(whole);
    const first = lc(local.split(/[._+-]+/)[0]);
    if (first.length >= 2) out.add(first);
  };
  for (const e of ourIdentitiesFromThread(threadContext)) addEmail(e);
  for (const e of extraEmails) addEmail(e);
  const addName = (n) => {
    const toks = String(n || '').split(/\s+/).filter(Boolean);
    if (!toks.length) return;
    const first = lc(toks[0]);
    if (first.length >= 2) out.add(first);
    if (toks.length > 1) {
      const fl = lc(toks[0] + toks[toks.length - 1][0]); // "Allison B." -> allisonb
      if (fl.length >= 3) out.add(fl);
    }
  };
  for (const m of historyMessages(threadContext)) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type !== 'SENT' && type !== 'OUTBOUND') continue;
    addName(m.from_name || m.fromName || m.sender_name);
    const raw = String(m.from || m.from_email || '');
    const angle = raw.match(/^(.*?)\s*<[^>]+>/);
    if (angle && angle[1].trim()) addName(angle[1].replace(/["']/g, ''));
  }
  for (const n of extraNames) addName(n);
  return out;
}

function isOurName(candidate, ours) {
  const c = lc(candidate);
  return Boolean(c) && ours.has(c);
}

function firstToken(name) {
  const t = String(name || '').trim().split(/\s+/)[0] || '';
  return t.replace(/[^A-Za-z'’.-]/g, '');
}

/**
 * Rewrite a greeting that names someone on our side to the lead's first name
 * (or "there" when the lead's name is unknown or also looks like our side).
 * @returns {{ text: string, fixed: boolean }}
 */
function enforceLeadGreeting(text, { leadName, leadEmail, threadContext, extraEmails, extraNames } = {}) {
  const src = String(text || '');
  const m = src.match(GREETING_RE);
  if (!m) return { text: src, fixed: false };
  const ours = ourNameTokens({ threadContext, extraEmails, extraNames });
  const greeted = m[4];
  if (!isOurName(greeted, ours)) return { text: src, fixed: false };
  let lead = firstToken(leadName);
  if (!lead || /^(unknown|there|lead|prospect)$/i.test(lead) || isOurName(lead, ours)) {
    const local = String(leadEmail || '').split('@')[0].split(/[._+-]+/)[0];
    lead = local && local.length >= 2 && !/\d/.test(local) && !isOurName(local, ours)
      ? local.charAt(0).toUpperCase() + local.slice(1).toLowerCase()
      : '';
  }
  const replacement = lead || 'there';
  return {
    text: src.replace(GREETING_RE, (_all, lead0, hello, sp, _name, tail) => `${lead0}${hello}${sp}${replacement}${tail}`),
    fixed: true,
  };
}

module.exports = { enforceLeadGreeting, ourNameTokens, isOurName };
