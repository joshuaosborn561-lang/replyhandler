/**
 * Resolve SmartLead CC recipients for a client.
 * - Always-CC list is included on every send when configured.
 * - Round-robin pool contributes exactly one address per send, rotating evenly.
 */
const db = require('../db');

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

/** Always-CC addresses (legacy cc_email folded in). */
function alwaysCcEmails(client) {
  const fromList = parseEmailList(client?.cc_emails);
  if (fromList.length) return fromList;
  return parseEmailList(client?.cc_email);
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
  roundRobinEmails,
  claimNextRoundRobinEmail,
  buildSmartleadCcList,
};
