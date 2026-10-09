/**
 * Enrich and persist the person who sent an inbound reply.
 *
 * One job per reply, claimed on phone_enrichment_status so webhook retries
 * never pay twice. Free cache first (pending_replies / wf_contacts / name_bank),
 * then email-waterfall /enrich-one:
 *   email: getleads → smartlead → aiark → prospeo → fullenrich
 *   mobile: getleads → aiark → prospeo → (FullEnrich only for INTERESTED /
 *           MEETING_PROPOSED under the $1 hot ceiling)
 *
 * Accept a cellphone only when Veriphone says valid + mobile.
 * Default ceiling $0.25. Never write dl_status / sg_exclude / skip_*.
 * Logs carry ids, tiers, and spend — never a lead row.
 */

const db = require('../db');
const { enrichProspect, clientTagFor } = require('./prospect-enrich');
const { lookupReplyIdentity } = require('./reply-contact-cache');
const { applyClientDraftPolicy, draftSkipReason } = require('../utils/client-draft-policy');
const {
  resolveReplyEnrichCeiling,
  estimateNeedUsd,
  canAfford,
  dropMaxTierToFit,
  resolvePhoneMaxTier,
  resolveEmailMaxTier,
  gateMobilePhone,
  remainingCeiling,
  spentFromHit,
  FORBIDDEN_WRITE_COLUMNS,
} = require('./reply-enrich-policy');

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
    phoneAlt: reply?.lead_phone_alt || null,
    email: reply?.lead_email || null,
    linkedinUrl: reply?.linkedin_url || null,
    website: reply?.lead_website || null,
    status: reply?.phone_enrichment_status || null,
    error: reply?.phone_enrichment_error || null,
    enrichedAt: reply?.phone_enriched_at || null,
    receipt: reply?.enrichment_receipt || null,
  };
}

function logJob(event, fields) {
  console.log(`[ReplyEnrich] ${event}`, {
    replyId: fields.replyId || null,
    status: fields.status || null,
    emailTier: fields.emailTier || null,
    phoneTier: fields.phoneTier || null,
    spentUsd: fields.spentUsd ?? null,
    ceilingUsd: fields.ceilingUsd ?? null,
    reason: fields.reason || null,
  });
}

async function getReply(replyId) {
  const { rows } = await db.query(
    `SELECT pr.id, pr.client_id, pr.campaign_id, pr.lead_name, pr.lead_email, pr.linkedin_url,
            pr.lead_phone, pr.lead_phone_provider, pr.lead_phone_alt, pr.lead_website,
            pr.phone_enrichment_status, pr.phone_enrichment_error, pr.phone_enriched_at,
            pr.classification, pr.status, pr.draft_reply, pr.enrichment_receipt,
            c.name AS client_name,
            c.reply_enrich_ceiling_usd, c.reply_enrich_ceiling_hot_usd
       FROM pending_replies pr
       LEFT JOIN clients c ON c.id = pr.client_id
      WHERE pr.id = $1`,
    [replyId]
  );
  return rows[0] || null;
}

async function loadClient(clientId) {
  const { rows } = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  return rows[0] || { id: clientId };
}

function emptyReceipt({ ceilingUsd, hot, cache }) {
  return {
    ceilingUsd,
    hot: Boolean(hot),
    spentUsd: 0,
    emailTier: cache?.sources?.email || null,
    phoneTier: null,
    linkedinSource: cache?.sources?.linkedin || null,
    phoneGate: null,
    cache: {
      email: Boolean(cache?.email),
      phone: Boolean(cache?.phone),
      website: Boolean(cache?.website),
    },
    tiers: [],
    at: new Date().toISOString(),
  };
}

async function runWaterfallStep({
  need, maxTier, remainingUsd, input, receipt,
}) {
  const fitted = dropMaxTierToFit({ need, maxTier, remainingUsd });
  if (!fitted) {
    receipt.tiers.push({ need, skipped: 'ceiling', maxTier });
    return { hit: null, spentUsd: 0, skipped: 'ceiling' };
  }
  const estimateUsd = estimateNeedUsd(need, fitted);
  if (!canAfford({ spentUsd: 0, nextUsd: estimateUsd, ceilingUsd: remainingUsd })) {
    receipt.tiers.push({ need, skipped: 'ceiling', estimateUsd, maxTier: fitted });
    return { hit: null, spentUsd: 0, skipped: 'ceiling' };
  }
  const hit = await enrichProspect({
    ...input,
    need,
    maxTier: fitted,
    approveCostUsd: remainingUsd,
    verifyPhone: need === 'phone',
  });
  const spentUsd = spentFromHit(hit);
  receipt.tiers.push({
    need,
    maxTier: fitted,
    estimateUsd,
    spentUsd,
    hit: need === 'phone' ? (hit.sources?.phone || null) : (hit.sources?.email || null),
    stoppedAtCeiling: Boolean(hit.stoppedAtCeiling),
  });
  return { hit, spentUsd };
}

/**
 * Claims one pending row so duplicate webhook/poller paths do not spend twice.
 * Completed `not_found` rows are not retried automatically.
 */
async function enrichPendingReplyPhone(replyId, { identityLookup = lookupReplyIdentity } = {}) {
  if (!replyId) return { status: 'skipped', error: 'missing_reply_id' };

  const existing = await getReply(replyId);
  if (!existing) return { status: 'skipped', error: 'reply_not_found' };
  if (existing.campaign_id === 'test-campaign') {
    return { ...storedResult(existing), status: 'skipped' };
  }
  const clientDqReason = draftSkipReason(
    { id: existing.client_id, name: existing.client_name },
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
        console.warn('[ReplyEnrich] Could not persist skipped status', {
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
      RETURNING id, lead_name, lead_email, linkedin_url, lead_phone, lead_website`,
    [replyId]
  );
  const claimed = claimedRows[0];
  if (!claimed) return storedResult(await getReply(replyId));

  const { ceilingUsd, hot } = resolveReplyEnrichCeiling({
    classification: existing.classification,
    client: existing,
  });

  try {
    const clientTag = clientTagFor(existing.client_name);
    const cache = await identityLookup(db, {
      linkedinUrl: claimed.linkedin_url,
      excludeReplyId: replyId,
      clientTag,
    });

    const receipt = emptyReceipt({ ceilingUsd, hot, cache });
    let spentUsd = 0;
    let email = claimed.lead_email || cache.email || null;
    let linkedinUrl = claimed.linkedin_url || cache.linkedinUrl || null;
    let website = claimed.lead_website || cache.website || null;
    let domain = cache.domain || null;
    let phone = null;
    let phoneAlt = null;
    let phoneProvider = null;

    const input = {
      email,
      phone: claimed.lead_phone || cache.phone || null,
      linkedinUrl,
      leadName: claimed.lead_name,
      domain,
      clientTag,
    };

    if (!email) {
      const remaining = remainingCeiling(ceilingUsd, spentUsd);
      const emailCap = resolveEmailMaxTier({ remainingUsd: remaining });
      const step = await runWaterfallStep({
        need: 'email',
        maxTier: emailCap,
        remainingUsd: remaining,
        input,
        receipt,
      });
      spentUsd += step.spentUsd;
      if (step.hit) {
        email = step.hit.email || email;
        linkedinUrl = step.hit.linkedinUrl || linkedinUrl;
        website = step.hit.website || website;
        domain = step.hit.domain || domain;
        receipt.emailTier = step.hit.sources?.email || receipt.emailTier;
        input.email = email;
        input.linkedinUrl = linkedinUrl;
        input.domain = domain;
      }
    } else {
      receipt.emailTier = receipt.emailTier || 'cache';
    }

    const remainingForPhone = remainingCeiling(ceilingUsd, spentUsd);
    const phoneCap = resolvePhoneMaxTier({
      classification: existing.classification,
      remainingUsd: remainingForPhone,
    });
    const phoneStep = await runWaterfallStep({
      need: 'phone',
      maxTier: phoneCap,
      remainingUsd: remainingForPhone,
      input: { ...input, phone: claimed.lead_phone || cache.phone || null },
      receipt,
    });
    spentUsd += phoneStep.spentUsd;
    if (phoneStep.hit) {
      const gated = gateMobilePhone({
        phone: phoneStep.hit.phone,
        phone_valid: phoneStep.hit.phoneValid,
        phone_type: phoneStep.hit.phoneType,
      });
      receipt.phoneGate = gated.reason;
      if (gated.mobile) {
        phone = gated.mobile;
        phoneProvider = phoneStep.hit.sources?.phone || null;
        receipt.phoneTier = phoneProvider;
      } else {
        phoneAlt = gated.alt;
        receipt.phoneTier = null;
      }
      linkedinUrl = phoneStep.hit.linkedinUrl || linkedinUrl;
      website = phoneStep.hit.website || website;
      if (!email) email = phoneStep.hit.email || email;
    }

    receipt.spentUsd = Number(spentUsd.toFixed(6));
    const status = phone || email || linkedinUrl || website ? 'found' : 'not_found';

    let draftSql = '';
    if (email && !claimed.lead_email) {
      const client = await loadClient(existing.client_id);
      const latePolicy = applyClientDraftPolicy(client, email, {
        classification: existing.classification,
        draft: existing.draft_reply,
      });
      if (latePolicy.skippedDraft) {
        draftSql = `,
              draft_reply = NULL,
              status = 'alert_only'`;
      }
    }

    const { rows } = await db.query(
      `UPDATE pending_replies
          SET lead_email = COALESCE(lead_email, $1),
              lead_phone = $2,
              lead_phone_provider = $3,
              lead_phone_alt = $4,
              linkedin_url = COALESCE(linkedin_url, $5),
              lead_website = $6,
              enrichment_receipt = $7::jsonb,
              phone_enrichment_status = $8,
              phone_enrichment_error = NULL,
              phone_enriched_at = now(),
              updated_at = now()
              ${draftSql}
        WHERE id = $9
        RETURNING id, lead_name, lead_email, linkedin_url, lead_phone, lead_phone_alt,
                  lead_phone_provider, lead_website, phone_enrichment_status,
                  phone_enrichment_error, phone_enriched_at, enrichment_receipt`,
      [
        email || null,
        phone || null,
        phoneProvider,
        phoneAlt || null,
        linkedinUrl || null,
        website || null,
        JSON.stringify(receipt),
        status,
        replyId,
      ]
    );
    logJob('complete', {
      replyId,
      status,
      emailTier: receipt.emailTier,
      phoneTier: receipt.phoneTier,
      spentUsd: receipt.spentUsd,
      ceilingUsd,
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
    console.error('[ReplyEnrich] failed', { replyId, err: err.message });
    return {
      ...storedResult(existing),
      status: 'failed',
      error: err.message,
    };
  }
}

const enrichPendingReply = enrichPendingReplyPhone;

module.exports = {
  enrichPendingReplyPhone,
  enrichPendingReply,
  storedResult,
  shouldSkipEnrichment,
  SKIP_ENRICH_CLASSIFICATIONS,
  FORBIDDEN_WRITE_COLUMNS,
};
