/**
 * Enrich and persist the person who sent an inbound reply.
 *
 * Provider order is the email-waterfall MCP/HTTP service (max_tier fullenrich):
 *   GetLeads → AI Ark → LeadMagic → Prospeo → FullEnrich (email + cellphone)
 *
 * OOO / REMOVE_ME never get enriched for client Slack channels — those cards
 * are informational only and burning waterfall credits on them is waste.
 */

const db = require('../db');
const { enrichProspect } = require('./prospect-enrich');
const { draftSkipReason } = require('../utils/client-draft-policy');
const { extractLinkedinUrl } = require('../utils/linkedin-url');
const getleads = require('./getleads');
const smartlead = require('./smartlead');

/** Classifications that must never trigger phone/waterfall enrichment. */
const SKIP_ENRICH_CLASSIFICATIONS = new Set([
  'OOO',
  'OUT_OF_OFFICE',
  'REMOVE_ME',
]);

function shouldSkipEnrichment(classification) {
  return SKIP_ENRICH_CLASSIFICATIONS.has(String(classification || '').toUpperCase());
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

async function persistLinkedinUrl(replyId, linkedinUrl) {
  const url = String(linkedinUrl || '').trim();
  if (!replyId || !url) return null;
  const { rows } = await db.query(
    `UPDATE pending_replies
        SET linkedin_url = COALESCE(linkedin_url, $2),
            updated_at = now()
      WHERE id = $1
      RETURNING linkedin_url`,
    [replyId, url]
  );
  return rows[0]?.linkedin_url || url;
}

/**
 * LinkedIn-only fill when the waterfall host is unset / 401s / returns no URL.
 * Uses the GetLeads contact search already in this repo — not a local vendor walk.
 * Phone still comes only from email-waterfall /enrich-one.
 */
async function linkedinFromGetLeads(email) {
  const workEmail = String(email || '').trim().toLowerCase();
  if (!workEmail || !workEmail.includes('@') || !getleads.isConfigured()) return null;
  try {
    const hit = await getleads.findPhoneByEmail(workEmail);
    return extractLinkedinUrl(hit) || hit?.linkedinUrl || null;
  } catch (err) {
    console.warn('[ReplyPhone] GetLeads LinkedIn lookup failed', { err: err.message });
    return null;
  }
}

async function linkedinFromSmartleadLead(reply) {
  if (reply?.linkedin_url) return reply.linkedin_url;
  const email = String(reply?.lead_email || '').trim();
  if (!email || !reply?.client_id) return null;
  try {
    const { rows } = await db.query(
      `SELECT smartlead_api_key FROM clients WHERE id = $1`,
      [reply.client_id]
    );
    const apiKey = rows[0]?.smartlead_api_key;
    if (!apiKey) return null;
    const lead = await smartlead.getLeadByEmail(apiKey, email);
    return extractLinkedinUrl(lead);
  } catch (err) {
    console.warn('[ReplyPhone] SmartLead LinkedIn lookup failed', { err: err.message });
    return null;
  }
}

async function fillMissingLinkedin(replyId, email, existing) {
  let url = extractLinkedinUrl(existing) || existing?.linkedin_url || null;
  if (!url) url = await linkedinFromSmartleadLead(existing);
  if (!url) url = await linkedinFromGetLeads(email || existing?.lead_email);
  if (url) {
    const stored = await persistLinkedinUrl(replyId, url);
    return stored || url;
  }
  return null;
}

async function getReply(replyId) {
  const { rows } = await db.query(
    `SELECT id, client_id, campaign_id, lead_name, lead_email, linkedin_url, lead_phone,
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
  const clientDqReason = draftSkipReason(
    { id: existing.client_id },
    existing.lead_email
  );
  if (
    shouldSkipEnrichment(existing.classification) ||
    existing.status === 'suppressed' ||
    clientDqReason
  ) {
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
            clientDqReason
              ? 'skipped_client_dq_domain'
              : shouldSkipEnrichment(existing.classification)
                ? `skipped_${String(existing.classification || '').toLowerCase()}`
                : 'skipped_suppressed',
          ]
        );
      } catch (err) {
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
    if (!existing.linkedin_url && existing.phone_enrichment_status !== 'skipped') {
      const url = await fillMissingLinkedin(replyId, existing.lead_email, existing);
      if (url) return { ...storedResult(existing), linkedinUrl: url };
    }
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
    let seedLinkedin = claimed.linkedin_url || null;
    if (!seedLinkedin) {
      seedLinkedin = await linkedinFromSmartleadLead({ ...existing, ...claimed });
      if (seedLinkedin) await persistLinkedinUrl(replyId, seedLinkedin);
    }

    const enriched = await enrichProspect({
      email: claimed.lead_email,
      linkedinUrl: seedLinkedin,
      leadName: claimed.lead_name,
    });
    const provider = enriched.sources?.phone || null;
    const waterfallSkipped = enriched.reason === 'waterfall_url_unset';
    let linkedinUrl = enriched.linkedinUrl || seedLinkedin || null;
    if (!linkedinUrl) {
      linkedinUrl = await linkedinFromGetLeads(claimed.lead_email);
    }
    const status = enriched.phone ? 'found' : 'not_found';
    const error = waterfallSkipped ? 'waterfall_url_unset' : null;

    const { rows } = await db.query(
      `UPDATE pending_replies
          SET lead_phone = $1,
              lead_phone_provider = $2,
              linkedin_url = COALESCE(linkedin_url, $3),
              lead_website = $4,
              phone_enrichment_status = $5,
              phone_enrichment_error = $6,
              phone_enriched_at = now(),
              updated_at = now()
        WHERE id = $7
        RETURNING id, lead_name, lead_email, linkedin_url, lead_phone,
                  lead_phone_provider, lead_website, phone_enrichment_status,
                  phone_enrichment_error, phone_enriched_at`,
      [
        enriched.phone || null,
        provider,
        linkedinUrl || null,
        enriched.website || null,
        status,
        error,
        replyId,
      ]
    );
    console.log('[ReplyPhone] Enrichment complete', {
      replyId,
      status,
      provider,
      phone: enriched.phone || null,
      linkedinUrl: rows[0]?.linkedin_url || linkedinUrl || null,
      waterfallSkipped,
    });
    return storedResult(rows[0]);
  } catch (err) {
    const linkedinUrl = await fillMissingLinkedin(replyId, existing.lead_email, existing);
    await db.query(
      `UPDATE pending_replies
          SET phone_enrichment_status = 'failed',
              phone_enrichment_error = $1,
              linkedin_url = COALESCE(linkedin_url, $3),
              phone_enriched_at = now(),
              updated_at = now()
        WHERE id = $2`,
      [String(err.message || err).slice(0, 1000), replyId, linkedinUrl || null]
    );
    console.error('[ReplyPhone] Enrichment failed', { replyId, err: err.message });
    return {
      ...storedResult(existing),
      linkedinUrl: linkedinUrl || existing.linkedin_url || null,
      status: 'failed',
      error: err.message,
    };
  }
}

module.exports = {
  enrichPendingReplyPhone,
  storedResult,
  shouldSkipEnrichment,
  SKIP_ENRICH_CLASSIFICATIONS,
  linkedinFromGetLeads,
  fillMissingLinkedin,
};
