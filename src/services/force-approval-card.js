/**
 * Force a fresh approval card.
 *
 * Used by the admin card endpoints when another bot needs a new, working
 * Approve / Edit & send card even though the reply already has a card, or a
 * previous send failed. The old row is never touched. Every forced card is a
 * new pending_replies row, so the buttons act on the new row only.
 *
 * Never sends. Refuses a lead who unsubscribed or was disqualified.
 */

const db = require('../db');
const { SLACK_CLAIM_PREFIX } = require('./reply-dedupe');
const { isDisqualified } = require('./disqualified-prospects');

const THREAD_TS_RE = /^\d+\.\d+$/;

function httpError(status, message, reason) {
  const err = new Error(message);
  err.status = status;
  if (reason) err.reason = reason;
  return err;
}

function parseForce(value) {
  if (value === true) return true;
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/** Optional Slack thread ts. Returns null when absent; throws 400 when malformed. */
function parseThreadTs(raw) {
  const ts = String(raw ?? '').trim();
  if (!ts) return null;
  if (!THREAD_TS_RE.test(ts)) {
    throw httpError(400, 'thread_ts must look like 1234567890.123456');
  }
  return ts;
}

function conversationIdOf(threadContext) {
  let tc = threadContext;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  const id = tc && tc.heyreach && tc.heyreach.conversationId;
  return id != null && id !== '' ? String(id) : null;
}

/**
 * Returns a reason string when this lead must not get a new card, else null.
 * Covers: a disqualified_prospects entry, any other row for the same lead that
 * was disqualified, or a row classed REMOVE_ME / suppressed as unsubscribe.
 */
async function findForceBlock({
  clientId,
  platform,
  campaignId = null,
  leadId = null,
  leadEmail = null,
  linkedinUrl = null,
  threadContext = null,
  status = null,
  classification = null,
  suppressionReason = null,
  query = (...args) => db.query(...args),
  isDisqualifiedFn = isDisqualified,
} = {}) {
  if (status === 'disqualified') return 'disqualified';
  if (String(classification || '').toUpperCase() === 'REMOVE_ME') return 'unsubscribed';
  if (String(suppressionReason || '').toLowerCase() === 'unsubscribe') return 'unsubscribed';

  const email = leadEmail ? String(leadEmail).trim().toLowerCase() : '';
  const lead = leadId != null ? String(leadId) : '';
  const li = linkedinUrl ? String(linkedinUrl).trim() : '';

  const dq = await isDisqualifiedFn(clientId, {
    platform,
    campaignId,
    leadId,
    conversationId: conversationIdOf(threadContext),
    leadEmail,
    linkedinUrl,
  });
  if (dq) return 'disqualified';

  if (!email && !lead && !li) return null;
  const { rows } = await query(
    `SELECT id, status, classification, suppression_reason
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND (
          status = 'disqualified'
          OR classification = 'REMOVE_ME'
          OR lower(COALESCE(suppression_reason, '')) = 'unsubscribe'
        )
        AND (
          ($3::text <> '' AND COALESCE(lead_id, '') = $3)
          OR ($4::text <> '' AND lower(lead_email) = $4)
          OR ($5::text <> '' AND linkedin_url = $5)
        )
      LIMIT 1`,
    [clientId, platform, lead, email, li]
  );
  const hit = rows && rows[0];
  if (!hit) return null;
  return hit.status === 'disqualified' ? 'disqualified' : 'unsubscribed';
}

function throwBlocked(reason) {
  throw httpError(
    409,
    reason === 'unsubscribed'
      ? 'lead unsubscribed; force cannot post a card'
      : 'lead disqualified; force cannot post a card',
    reason === 'unsubscribed' ? 'lead_unsubscribed' : 'lead_disqualified'
  );
}

/**
 * Claim a fresh row for posting. Skips the "a sibling already has a card"
 * check on purpose; that check is what force overrides.
 */
function makeForceClaim(query = (...args) => db.query(...args)) {
  return async function forceClaim({ replyId }) {
    const { rows } = await query(
      `UPDATE pending_replies
          SET slack_message_ts = $1, updated_at = now()
        WHERE id = $2 AND slack_message_ts IS NULL
        RETURNING id`,
      [`${SLACK_CLAIM_PREFIX}${replyId}`, replyId]
    );
    return rows && rows[0] ? { claimed: true } : { claimed: false, reason: 'lost_race' };
  };
}

/** Park a forced row that never got a card so no recovery job posts it later. */
async function parkForcedRow(query, replyId) {
  try {
    await query(
      `UPDATE pending_replies
          SET status = 'skipped', suppression_reason = 'force_card_not_posted', updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [replyId]
    );
  } catch (err) {
    console.warn('[ForceCard] could not park unposted row', { replyId, err: err.message });
  }
}

/** New pending row copied from a stored HeyReach reply, with a new draft. */
async function insertHeyreachCopy(query, row, { threadContextJson, classification, draft }) {
  const { rows } = await query(
    `INSERT INTO pending_replies
       (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email,
        linkedin_url, lead_phone, lead_phone_provider, lead_phone_alt, lead_website,
        lead_full_name, lead_location, lead_timezone, inbound_message, thread_context,
        classification, draft_reply, status)
     VALUES ($1, 'heyreach', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             $17, $18, 'pending')
     RETURNING *`,
    [
      row.client_id, row.campaign_id, row.campaign_name, row.lead_id, row.lead_name,
      row.lead_email, row.linkedin_url, row.lead_phone, row.lead_phone_provider,
      row.lead_phone_alt, row.lead_website, row.lead_full_name, row.lead_location,
      row.lead_timezone, row.inbound_message, threadContextJson,
      classification, draft,
    ]
  );
  return rows && rows[0] ? rows[0] : null;
}

module.exports = {
  insertHeyreachCopy,
  parseForce,
  parseThreadTs,
  conversationIdOf,
  findForceBlock,
  throwBlocked,
  makeForceClaim,
  parkForcedRow,
  httpError,
};
