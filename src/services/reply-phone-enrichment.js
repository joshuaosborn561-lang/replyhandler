/**
 * Enrich and persist the person who sent an inbound reply.
 *
 * Provider order is implemented by enrichProspect:
 *   GetLeads -> AI Ark -> LeadMagic
 *
 * Phone/waterfall enrichment runs only for positive classifications.
 * Declines, OOO, remove-me, wrong-person, competitor, and other alerts
 * still reach Slack — they just do not burn enrichment credits.
 */

const db = require('../db');
const { enrichProspect } = require('./prospect-enrich');

/**
 * Positive replies worth a cellphone lookup for booking / client notify.
 * Everything else skips the paid waterfall.
 */
const PHONE_ENRICH_CLASSIFICATIONS = new Set([
  'INTERESTED',
  'MEETING_PROPOSED',
  'QUESTION',
]);

/** @deprecated kept for tests that imported the old skip-set name */
const SKIP_ENRICH_CLASSIFICATIONS = new Set([
  'OOO',
  'OUT_OF_OFFICE',
  'REMOVE_ME',
  'NOT_INTERESTED',
  'OBJECTION',
  'OTHER',
  'WRONG_PERSON',
  'COMPETITOR',
  'FOLLOW_UP',
]);

function shouldEnrichPhone(classification) {
  return PHONE_ENRICH_CLASSIFICATIONS.has(String(classification || '').toUpperCase());
}

/** True when phone/waterfall enrichment must not run. */
function shouldSkipEnrichment(classification) {
  return !shouldEnrichPhone(classification);
}

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
            phone_enrichment_error, phone_enriched_at, classification, status
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
  if (shouldSkipEnrichment(existing.classification) || existing.status === 'suppressed') {
    if (existing.phone_enrichment_status !== 'skipped') {
      try {
        await db.query(
          `UPDATE pending_replies
              SET phone_enrichment_status = 'skipped',
                  phone_enrichment_error = $2,
                  phone_enriched_at = now(),
                  updated_at = now()
            WHERE id = $1
              AND (phone_enrichment_status IS NULL
                   OR phone_enrichment_status = 'failed'
                   OR phone_enrichment_status = 'processing')`,
          [
            replyId,
            shouldSkipEnrichment(existing.classification)
              ? `skipped_non_positive_${String(existing.classification || 'unknown').toLowerCase()}`
              : 'skipped_suppressed',
          ]
        );
      } catch (err) {
        // Pre-migration DBs reject 'skipped' on the CHECK — still return skipped.
        console.warn('[ReplyPhone] Could not persist skipped status', {
          replyId, err: err.message,
        });
      }
    }
    return { ...storedResult(existing), status: 'skipped' };
  }
  if (existing.phone_enrichment_status === 'found' ||
      existing.phone_enrichment_status === 'not_found' ||
      existing.phone_enrichment_status === 'skipped') {
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

module.exports = {
  enrichPendingReplyPhone,
  storedResult,
  shouldSkipEnrichment,
  shouldEnrichPhone,
  PHONE_ENRICH_CLASSIFICATIONS,
  SKIP_ENRICH_CLASSIFICATIONS,
};
