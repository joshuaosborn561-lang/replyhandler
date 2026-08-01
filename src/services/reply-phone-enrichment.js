/**
 * Enrich and persist the person who sent an inbound reply.
 *
 * Provider order is implemented by enrichProspect:
 *   GetLeads -> AI Ark -> LeadMagic
 */

const db = require('../db');
const { enrichProspect } = require('./prospect-enrich');

function storedResult(reply) {
  return {
    phone: reply?.lead_phone || null,
    provider: reply?.lead_phone_provider || null,
    email: reply?.lead_email || null,
    linkedinUrl: reply?.linkedin_url || null,
    website: reply?.lead_website || null,
    status: reply?.phone_enrichment_status || null,
    error: reply?.phone_enrichment_error || null,
    enrichedAt: reply?.phone_enriched_at || null,
  };
}

async function getReply(replyId) {
  const { rows } = await db.query(
    `SELECT id, campaign_id, lead_name, lead_email, linkedin_url, lead_phone,
            lead_phone_provider, lead_website, phone_enrichment_status,
            phone_enrichment_error, phone_enriched_at
       FROM pending_replies
      WHERE id = $1`,
    [replyId]
  );
  return rows[0] || null;
}

/**
 * Claims one pending row so duplicate webhook/poller paths do not spend twice.
 * Completed `not_found` rows are not retried automatically.
 */
async function enrichPendingReplyPhone(replyId) {
  if (!replyId) return { status: 'skipped', error: 'missing_reply_id' };

  const existing = await getReply(replyId);
  if (!existing) return { status: 'skipped', error: 'reply_not_found' };
  if (existing.campaign_id === 'test-campaign') {
    return { ...storedResult(existing), status: 'skipped' };
  }
  if (existing.phone_enrichment_status === 'found' ||
      existing.phone_enrichment_status === 'not_found') {
    return storedResult(existing);
  }
  if (existing.phone_enrichment_status === 'processing') {
    return storedResult(existing);
  }

  const { rows: claimedRows } = await db.query(
    `UPDATE pending_replies
        SET phone_enrichment_status = 'processing',
            phone_enrichment_error = NULL,
            updated_at = now()
      WHERE id = $1
        AND (
          phone_enrichment_status IS NULL
          OR phone_enrichment_status = 'failed'
        )
      RETURNING id, lead_name, lead_email, linkedin_url`,
    [replyId]
  );
  const claimed = claimedRows[0];
  if (!claimed) return storedResult(await getReply(replyId));

  try {
    const enriched = await enrichProspect({
      email: claimed.lead_email,
      linkedinUrl: claimed.linkedin_url,
      leadName: claimed.lead_name,
    });
    const provider = enriched.sources?.phone || null;
    const status = enriched.phone ? 'found' : 'not_found';

    const { rows } = await db.query(
      `UPDATE pending_replies
          SET lead_phone = $1,
              lead_phone_provider = $2,
              linkedin_url = COALESCE(linkedin_url, $3),
              lead_website = $4,
              phone_enrichment_status = $5,
              phone_enrichment_error = NULL,
              phone_enriched_at = now(),
              updated_at = now()
        WHERE id = $6
        RETURNING id, lead_name, lead_email, linkedin_url, lead_phone,
                  lead_phone_provider, lead_website, phone_enrichment_status,
                  phone_enrichment_error, phone_enriched_at`,
      [
        enriched.phone || null,
        provider,
        enriched.linkedinUrl || null,
        enriched.website || null,
        status,
        replyId,
      ]
    );
    console.log('[ReplyPhone] Enrichment complete', {
      replyId,
      status,
      provider,
      phone: enriched.phone || null,
    });
    return storedResult(rows[0]);
  } catch (err) {
    await db.query(
      `UPDATE pending_replies
          SET phone_enrichment_status = 'failed',
              phone_enrichment_error = $1,
              phone_enriched_at = now(),
              updated_at = now()
        WHERE id = $2`,
      [String(err.message || err).slice(0, 1000), replyId]
    );
    console.error('[ReplyPhone] Enrichment failed', { replyId, err: err.message });
    return {
      ...storedResult(existing),
      status: 'failed',
      error: err.message,
    };
  }
}

async function waitForReplyPhoneEnrichment(replyId, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let row = await getReply(replyId);
  while (row && row.phone_enrichment_status === 'processing' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    row = await getReply(replyId);
  }
  return row ? storedResult(row) : { status: 'skipped', error: 'reply_not_found' };
}

/**
 * Single spend-safe entry point for approve/send. It never bypasses the DB
 * claim with a direct provider call.
 */
async function getOrAwaitReplyEnrichment(replyId, options = {}) {
  const existing = await getReply(replyId);
  if (!existing) return { status: 'skipped', error: 'reply_not_found' };
  if (existing.phone_enrichment_status === 'found' ||
      existing.phone_enrichment_status === 'not_found') {
    return storedResult(existing);
  }
  if (existing.phone_enrichment_status === 'processing') {
    return waitForReplyPhoneEnrichment(replyId, options);
  }
  const claimed = await enrichPendingReplyPhone(replyId);
  if (claimed.status === 'processing') {
    return waitForReplyPhoneEnrichment(replyId, options);
  }
  return claimed;
}

module.exports = {
  enrichPendingReplyPhone,
  waitForReplyPhoneEnrichment,
  getOrAwaitReplyEnrichment,
  storedResult,
};
