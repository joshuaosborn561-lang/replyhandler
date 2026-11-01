'use strict';

/**
 * Redaction pass for the client copy of the day-of brief.
 *
 * Josh's own brief is the source. The client copy is that same brief (same
 * sections, same order, same bullets) with only the lines below removed:
 *   - campaign names and any line that identifies the campaign
 *   - sender mailboxes and sending domains
 *   - internal-only notes (pricing, LTV bars, other clients' proof, unsubscribe,
 *     calendar-wipe ops notes, internal offer names)
 *   - vendor and tool names that are not one of Josh's own section titles
 *
 * Josh's section titles (Allo, Fireflies / Cube) are kept: his brief does not
 * label them internal and Josh asked for the same sections in the same order.
 * To hide a whole section from clients, add its key to CLIENT_HIDDEN_SECTION_KEYS.
 *
 * Nothing here rewrites a line. A line is kept exactly as Josh's brief has it,
 * or it is removed and reported in `removed`.
 */

/** Pricing, LTV, other-client proof, unsubscribe and ops notes. Also used to refuse EA HTML on POST /send. */
const INTERNAL_BULLET = /\bLTV\b|\bunsubscrib|\bsmartlead\b|\bproof to lean on\b|\bcalendly wipe\b|\$\s?\d[\d,.]*\s*K\b|\bour (price|pricing|rate card)\b|\binternal pricing\b|\$\s?\d[\d,.]*\s*(?:\/|per\s+)(?:month|mo|meeting|account|inbox)/i;

/** Vendor and tool names a client never sees. Allo and Fireflies stay: they are Josh's own section titles. */
const TOOL_NAME = /\b(smartlead|heyreach|serper|openrouter|anthropic|reply\s?handler|supabase|railway|instantly|lemlist)\b/i;

/** Mailbox and sending words. Specific mailbox values come from facts.how.sender. */
const MAILBOX_WORD = /\b(sender mailbox|sending (?:mailbox|domain|inbox|account)|warm-?up (?:mailbox|inbox))\b/i;

/** Internal offer and list names, and any line that talks about a campaign. */
const CAMPAIGN_WORD = /\bcampaigns?\b|\bsalesglider (intro|staffing|subs)\b/i;

/** Same union the brief writer uses to drop internal bullets. */
const INTERNAL_LINE = new RegExp(
  `${INTERNAL_BULLET.source}|\\bheyreach\\b|\\bsalesglider (intro|staffing|subs)\\b|\\bcampaigns?\\b`,
  'i',
);

/** Whole sections hidden from clients. Empty on purpose: Josh wants the same sections. */
const CLIENT_HIDDEN_SECTION_KEYS = [];

function norm(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Values from the facts that must never appear on a client line. */
function sensitiveValues(facts = {}) {
  const how = facts.how || {};
  const raw = [how.campaign, how.campaignName, how.sender, how.mailbox, how.senderEmail, how.sequence];
  const out = [];
  for (const v of raw) {
    const s = norm(v);
    if (s.length >= 3) out.push(s);
    // A mailbox's domain is a sending domain.
    const dom = s.match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
    if (dom) out.push(dom[1]);
  }
  return [...new Set(out)];
}

/** Why a line must not reach the client, or null when it can stay. */
function redactionReason(line, facts = {}, values = sensitiveValues(facts)) {
  const s = String(line || '');
  const n = norm(s);
  if (!n) return null;
  for (const v of values) if (n.includes(v)) return 'campaign_or_mailbox';
  if (CAMPAIGN_WORD.test(s)) return 'campaign';
  if (MAILBOX_WORD.test(s)) return 'mailbox';
  if (INTERNAL_BULLET.test(s)) return 'internal_note';
  if (TOOL_NAME.test(s)) return 'tool_name';
  return null;
}

/**
 * Takes Josh's brief ({ subject, sections: [{ title, key, items }] }) and returns the client copy
 * plus the list of removed lines. `placeholders` gives the one honest line a section shows when
 * everything in it was removed, so a section is never empty and no section is dropped.
 */
function redactBriefForClient(josh, facts = {}, { placeholders = {} } = {}) {
  const values = sensitiveValues(facts);
  const removed = [];
  const sections = [];
  for (const section of josh.sections) {
    if (CLIENT_HIDDEN_SECTION_KEYS.includes(section.key)) {
      for (const item of section.items) removed.push({ section: section.title, line: item, reason: 'hidden_section' });
      continue;
    }
    const items = [];
    for (const item of section.items) {
      const reason = redactionReason(item, facts, values);
      if (reason) removed.push({ section: section.title, line: item, reason });
      else items.push(item);
    }
    if (!items.length && placeholders[section.key]) items.push(placeholders[section.key]);
    sections.push({ ...section, items });
  }
  const subjectReason = redactionReason(josh.subject, facts, values);
  return {
    subject: subjectReason ? 'Brief' : josh.subject,
    sections,
    removed,
  };
}

module.exports = {
  INTERNAL_BULLET,
  INTERNAL_LINE,
  TOOL_NAME,
  CLIENT_HIDDEN_SECTION_KEYS,
  sensitiveValues,
  redactionReason,
  redactBriefForClient,
};
