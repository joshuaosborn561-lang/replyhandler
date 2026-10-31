/**
 * Client address lists.
 * - notify_emails: the automatic client updates and the manual "CC client" choice.
 * - cc_emails / cc_email: portal Always-notify (login). Not copied onto prospect sends.
 * - Round-robin remains a stored pool. It is not added to prospect sends or the
 *   three client notifications.
 */
const db = require('../db');
const { filterOwnAddresses } = require('../utils/own-addresses');

function parseEmailList(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || '').split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function formatEmailList(emails) {
  return (emails || []).join(', ');
}

/** Always-CC addresses (legacy cc_email folded in). Portal login only — not prospect CC. */
function alwaysCcEmails(client) {
  const fromList = parseEmailList(client?.cc_emails);
  if (fromList.length) return fromList;
  return parseEmailList(client?.cc_email);
}

/** Addresses for the three client notifications and the manual CC button. */
function notifyEmails(client) {
  return parseEmailList(client?.notify_emails);
}

/**
 * Every client address that must stay off an automatic Smartlead / HeyReach
 * prospect send: the portal lists, the leftover contact column, and the
 * notification list. The manual CC button adds notify_emails back afterwards.
 */
function clientSendBlocklist(client) {
  return parseEmailList([
    client?.cc_emails,
    client?.cc_email,
    client?.contact_email,
    client?.notify_emails,
  ].filter(Boolean).join(','));
}

/** Drop blocklisted client addresses from a CC list. Keeps everyone else. */
function stripClientSendAddresses(list, client) {
  const blocked = new Set(clientSendBlocklist(client));
  const raw = Array.isArray(list) ? list : parseEmailList(list);
  return raw
    .map((email) => String(email || '').trim().toLowerCase())
    .filter((email) => email.includes('@') && !blocked.has(email));
}

/**
 * Client contacts who may be CC'd on a prospect thread when Josh chooses it:
 * notify_emails, minus Josh, Cayden, the primary Gmail and anything on our own
 * domains, the lead (`leadEmail`), the sending inbox and our sending domains
 * (`exclude`, `excludeDomains`). Lowercased, deduped case-insensitively.
 * cc_emails / cc_email / contact_email are not included.
 */
function clientContactEmails(client, { leadEmail = '', exclude = [], excludeDomains = [] } = {}) {
  const extra = [leadEmail, ...(Array.isArray(exclude) ? exclude : [exclude])].filter(Boolean);
  return filterOwnAddresses(notifyEmails(client).join(','), { extra, extraDomains: excludeDomains });
}

/**
 * Prospect-thread CC for "Approve & Send + CC client" and the Edit modal's
 * "CC client on this reply" checkbox. notify_emails only, minus anything that
 * is us or the lead (see clientContactEmails) — not round-robin, not cc_emails.
 */
function alwaysForwardEmailsForProspectCc(client, opts = {}) {
  return formatEmailList(clientContactEmails(client, opts));
}

function roundRobinEmails(client) {
  return parseEmailList(client?.cc_round_robin_emails);
}

/**
 * Atomically pick the next round-robin address and advance the cursor.
 * Returns null when the pool is empty.
 */
async function claimNextRoundRobinEmail(clientId) {
  const { rows } = await db.query(
    `UPDATE clients
        SET cc_round_robin_index = CASE
              WHEN cc_round_robin_emails IS NULL OR btrim(cc_round_robin_emails) = '' THEN 0
              ELSE cc_round_robin_index + 1
            END,
            updated_at = now()
      WHERE id = $1
      RETURNING cc_round_robin_emails, cc_round_robin_index`,
    [clientId]
  );
  const row = rows[0];
  if (!row) return null;
  const pool = parseEmailList(row.cc_round_robin_emails);
  if (!pool.length) return null;
  // index was incremented; previous slot is (index - 1) mod n
  const claimedIndex = ((row.cc_round_robin_index % pool.length) + pool.length - 1) % pool.length;
  return pool[claimedIndex];
}

/**
 * Build the full CC string for a SmartLead send.
 * Always includes always-CC; optionally claims one round-robin rep.
 */
async function buildSmartleadCcList(client, { claimRoundRobin = true } = {}) {
  const always = alwaysCcEmails(client);
  const recipients = [...always];
  let roundRobin = null;

  if (claimRoundRobin && roundRobinEmails(client).length) {
    roundRobin = await claimNextRoundRobinEmail(client.id);
    if (roundRobin && !recipients.includes(roundRobin)) {
      recipients.push(roundRobin);
    }
  }

  return {
    ccEmails: formatEmailList(recipients),
    always,
    roundRobin,
    recipients,
  };
}

module.exports = {
  parseEmailList,
  formatEmailList,
  alwaysCcEmails,
  notifyEmails,
  clientSendBlocklist,
  stripClientSendAddresses,
  clientContactEmails,
  alwaysForwardEmailsForProspectCc,
  roundRobinEmails,
  claimNextRoundRobinEmail,
  buildSmartleadCcList,
};
