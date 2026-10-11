const db = require('../db');
const slack = require('./slack');
const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');
const {
  enrichPendingReplyPhone,
  shouldSkipEnrichment,
} = require('./reply-phone-enrichment');
const {
  isPositivePortalClassification,
  notifyPortalPositiveReply,
} = require('./portal-positive-reply');
const {
  resolveCardIdentity,
  lookupMissingLinkedin,
  linkLookupCeilingUsd,
} = require('./reply-card-identity');

function heyreachLastOutboundFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let last = '';
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || m.sender || '').toLowerCase();
    const isUs = role === 'us' || role === 'me' || role === 'sender' || role === 'user';
    if (!isUs) continue;
    const txt =
      (typeof m.message === 'string' && m.message) ||
      (typeof m.text === 'string' && m.text) ||
      (typeof m.body === 'string' && m.body) ||
      '';
    if (txt && String(txt).trim()) last = String(txt).trim();
  }
  return last;
}

function firstOutboundFromSmartleadHistory(histResponse) {
  if (!histResponse || typeof histResponse !== 'object') return '';
  const list = Array.isArray(histResponse.history)
    ? histResponse.history
    : Array.isArray(histResponse.messages)
      ? histResponse.messages
      : Array.isArray(histResponse)
        ? histResponse
        : [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    if (type === 'SENT' || type === 'OUTBOUND') {
      const raw = m.email_body || m.body || m.text || '';
      const p = String(raw || '').trim();
      if (p) return p;
    }
  }
  return '';
}

function resolveLastOutboundForSlack({ platform, threadContext, lastOutboundMessage }) {
  const explicit = String(lastOutboundMessage || '').trim();
  if (explicit) return explicit;

  let tc = threadContext;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  if (!tc) return '';

  if (platform === 'smartlead') {
    return lastOutboundBodyFromSmartleadHistory(tc) || firstOutboundFromSmartleadHistory(tc) || '';
  }
  if (platform === 'heyreach') {
    const messages = Array.isArray(tc) ? tc : (Array.isArray(tc.messages) ? tc.messages : []);
    return heyreachLastOutboundFromMessages(messages) || '';
  }
  return '';
}

function resolvePreviousThreadMessage({ platform, threadContext, inboundMessage }) {
  let tc = threadContext;
  if (typeof tc === 'string') {
    try { tc = JSON.parse(tc); } catch { tc = null; }
  }
  if (!tc) return '';

  const inboundNorm = String(inboundMessage || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const messages = platform === 'heyreach' && !Array.isArray(tc) && Array.isArray(tc.messages)
    ? tc.messages
    : Array.isArray(tc)
      ? tc
      : Array.isArray(tc.history)
        ? tc.history
        : Array.isArray(tc.messages)
          ? tc.messages
          : [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const body =
      (typeof m.message === 'string' && m.message) ||
      (typeof m.text === 'string' && m.text) ||
      (typeof m.body === 'string' && m.body) ||
      (typeof m.email_body === 'string' && m.email_body) ||
      '';
    const plain = String(body || '').replace(/\s+/g, ' ').trim();
    if (!plain) continue;
    if (inboundNorm && plain.toLowerCase() === inboundNorm) continue;
    return plain;
  }
  return '';
}

function resolveSlackContextMessage({ platform, threadContext, lastOutboundMessage, inboundMessage }) {
  const outbound = resolveLastOutboundForSlack({ platform, threadContext, lastOutboundMessage });
  if (outbound) {
    return { label: 'Your last message', body: outbound };
  }
  const previous = resolvePreviousThreadMessage({ platform, threadContext, inboundMessage });
  if (previous) {
    return { label: 'Previous in thread', body: previous };
  }
  return { label: 'Your last message', body: '' };
}

async function findSlackThreadRootTs(clientId, platform, campaignId, leadId, dbClient = db) {
  const { rows } = await dbClient.query(
    `SELECT slack_message_ts
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND COALESCE(campaign_id, '') = COALESCE($3::text, '')
        AND COALESCE(lead_id, '') = COALESCE($4::text, '')
        AND slack_message_ts IS NOT NULL
        AND slack_message_ts NOT LIKE 'claiming:%'
      ORDER BY created_at ASC
      LIMIT 1`,
    [
      clientId,
      platform,
      campaignId != null ? String(campaignId) : '',
      leadId != null ? String(leadId) : '',
    ]
  );
  return rows[0]?.slack_message_ts || null;
}

function applyCardLinks(card, identity = {}, extra = {}) {
  return {
    ...card,
    leadEmail: extra.email || identity.email || card.leadEmail || undefined,
    leadPhone: extra.phone || card.leadPhone || undefined,
    phoneProvider: extra.phoneProvider || card.phoneProvider || undefined,
    phoneEnrichmentStatus: extra.phoneEnrichmentStatus || card.phoneEnrichmentStatus || undefined,
    enrichmentReceipt: extra.enrichmentReceipt || card.enrichmentReceipt || undefined,
    leadLinkedinUrl:
      extra.linkedinUrl
      || identity.linkedinUrl
      || card.leadLinkedinUrl
      || card.linkedinUrl
      || undefined,
    leadWebsite:
      extra.website
      || identity.website
      || card.leadWebsite
      || card.website
      || undefined,
  };
}

/**
 * Persist LinkedIn / website / email with COALESCE so a later miss cannot
 * wipe a cheap hit. Never writes dl_status / sg_exclude / skip_*.
 */
async function persistCardIdentity(dbClient, replyId, {
  linkedinUrl, website, email,
} = {}) {
  if (!replyId || !dbClient) return;
  const li = linkedinUrl || null;
  const site = website || null;
  const em = email || null;
  if (!li && !site && !em) return;
  await dbClient.query(
    `UPDATE pending_replies
        SET linkedin_url = COALESCE(linkedin_url, $1),
            lead_website = COALESCE(lead_website, $2),
            lead_email = COALESCE(lead_email, $3),
            updated_at = now()
      WHERE id = $4`,
    [li, site, em, replyId]
  );
}

function firePortalNotify(card, {
  clientId, platform, campaignId, leadId, replyId, extra = {}, dbClient = db,
} = {}) {
  if (!isPositivePortalClassification(card?.classification)) return;
  notifyPortalPositiveReply({
    clientId,
    platform,
    email: extra.email || card.leadEmail,
    name: card.leadName,
    company: card.leadCompany,
    campaignId,
    leadId,
    snippet: card.inboundMessage,
    repliedAt: card.repliedAt,
    replyId,
    classification: card.classification,
    phone: extra.phone || card.leadPhone || null,
    phoneProvider: extra.phoneProvider || card.phoneProvider || null,
    linkedinUrl: extra.linkedinUrl || card.leadLinkedinUrl || card.linkedinUrl || null,
    website: extra.website || card.leadWebsite || null,
  }, { db: dbClient }).catch((err) => {
    console.warn('[Portal] Positive-reply notify threw', { err: err.message });
  });
}

async function attachDraftCc(dbClient, { replyId, platform, isDraft, payload }) {
  if (!isDraft || !replyId || platform !== 'smartlead') return payload;
  const { rows: [ccRow] } = await dbClient.query(
    `SELECT c.cc_email, c.cc_emails, c.cc_round_robin_emails, c.name AS client_name, pr.cc_on_send
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.id = $1`,
    [replyId]
  );
  if (!ccRow) return payload;
  return {
    ...payload,
    ccEmail: ccRow.cc_email,
    ccEmails: ccRow.cc_emails || ccRow.cc_email,
    ccRoundRobinEmails: ccRow.cc_round_robin_emails,
    ccOnSend: !!ccRow.cc_on_send,
    clientName: ccRow.client_name,
  };
}

async function updatePostedCard(slackApi, {
  token, channelId, ts, isDraft, payload,
}) {
  if (!ts) return null;
  if (isDraft) {
    return slackApi.updateDraftApprovalCard(token, channelId, ts, payload);
  }
  return slackApi.updateAlertCard(token, channelId, ts, payload);
}

/**
 * After the card is already in Slack: finish phone enrich + a $0.05 LinkedIn
 * lookup if the cheap path missed, then chat.update the same message.
 */
async function completeCardLinks({
  token,
  channelId,
  postedTs,
  isDraft,
  payload,
  card,
  replyId,
  classification,
  slackApi,
  enrichFn,
  linkLookup,
  identity,
  dbClient,
  clientId,
  platform,
  campaignId,
  leadId,
}) {
  let linkedinUrl = identity.linkedinUrl || null;
  let website = identity.website || null;
  let email = identity.email || card.leadEmail || null;
  let enrichment = null;

  if (replyId && !shouldSkipEnrichment(card?.classification)) {
    try {
      enrichment = await enrichFn(replyId);
    } catch (err) {
      console.warn('[Slack] Background enrich failed after card post', {
        replyId, err: err.message,
      });
    }
    if (enrichment) {
      email = enrichment.email || email;
      linkedinUrl = enrichment.linkedinUrl || linkedinUrl;
      website = enrichment.website || website;
    }
  }

  if (!linkedinUrl) {
    try {
      const paid = await linkLookup({
        email,
        leadName: card.leadName,
        companyName: card.leadCompany,
        domain: null,
        linkedinUrl: null,
        clientTag: payload.clientName || null,
        ceilingUsd: linkLookupCeilingUsd(),
      });
      if (paid?.linkedinUrl) linkedinUrl = paid.linkedinUrl;
      if (!website && paid?.website) website = paid.website;
      if (!email && paid?.email) email = paid.email;
    } catch (err) {
      console.warn('[Slack] LinkedIn lookup failed after card post', {
        replyId, err: err.message,
      });
    }
  }

  const extra = {
    email,
    phone: enrichment?.phone || undefined,
    phoneProvider: enrichment?.provider || undefined,
    phoneEnrichmentStatus: enrichment?.status || undefined,
    enrichmentReceipt: enrichment?.receipt || undefined,
    linkedinUrl,
    website,
  };
  const updatedCard = applyCardLinks(card, identity, extra);
  const updatedPayload = {
    ...payload,
    ...updatedCard,
  };

  await persistCardIdentity(dbClient, replyId, { linkedinUrl, website, email });
  firePortalNotify(updatedCard, {
    clientId, platform, campaignId, leadId, replyId, extra, dbClient,
  });

  const beforeLi = payload.leadLinkedinUrl || null;
  const beforeWeb = payload.leadWebsite || null;
  const beforePhone = payload.leadPhone || null;
  const changed =
    (linkedinUrl && linkedinUrl !== beforeLi)
    || (website && website !== beforeWeb)
    || (extra.phone && extra.phone !== beforePhone)
    || extra.phoneEnrichmentStatus === 'not_found'
    || extra.phoneEnrichmentStatus === 'failed';

  if (changed) {
    try {
      await updatePostedCard(slackApi, {
        token, channelId, ts: postedTs, isDraft, payload: updatedPayload,
      });
    } catch (err) {
      console.warn('[Slack] chat.update after link enrich failed', {
        replyId, err: err.message,
      });
    }
  }

  return { linkedinUrl, website, email, enrichment, updated: changed };
}

/**
 * Post a prospect reply card to Slack.
 * Every client/channel path (Smartlead, HeyReach, FOLLOW_UP, recover, admin)
 * goes through this builder so LinkedIn + website always render.
 *
 * Cheap fields/cache first, post immediately, then chat.update when the
 * slower enrich / $0.05 LinkedIn lookup arrives.
 */
async function postProspectSlackCard({
  token,
  channelId,
  clientId,
  platform,
  campaignId,
  leadId,
  threadContext,
  isDraft,
  card,
  replyId,
  postInThread = true,
  slackApi = slack,
  enrichFn = enrichPendingReplyPhone,
  identityResolve = resolveCardIdentity,
  linkLookup = lookupMissingLinkedin,
  claimFn = null,
  dbClient = db,
  awaitLinkUpdate = false,
}) {
  if (replyId) {
    // Lazy require — reply-dedupe loads this file at the top level.
    const { claimSlackCard } = require('./reply-dedupe');
    const claim = claimFn
      ? await claimFn({
          replyId,
          clientId,
          platform,
          leadId,
          leadEmail: card?.leadEmail,
          inboundMessage: card?.inboundMessage,
          classification: card?.classification,
        })
      : await claimSlackCard({
          replyId,
          clientId,
          platform,
          leadId,
          leadEmail: card?.leadEmail,
          inboundMessage: card?.inboundMessage,
          classification: card?.classification,
        });
    if (!claim.claimed) {
      console.log('[Slack] Skip card — already claimed or posted', {
        replyId, reason: claim.reason,
      });
      return { skipped: true, reason: claim.reason, ts: null };
    }
  }

  let postedTs = null;
  try {
    const identity = await identityResolve({
      card,
      reply: {
        linkedin_url: card?.leadLinkedinUrl || card?.linkedinUrl,
        lead_website: card?.leadWebsite || card?.website,
        lead_email: card?.leadEmail,
        lead_name: card?.leadName,
      },
      leadData: card?.leadData || {},
      payload: card?.payload || {},
      db: dbClient,
      clientTag: card?.clientName,
      excludeReplyId: replyId,
    });

    let enrichedCard = applyCardLinks(card, identity);
    await persistCardIdentity(dbClient, replyId, {
      linkedinUrl: identity.linkedinUrl,
      website: identity.website,
      email: identity.email || card?.leadEmail,
    });

    const threadTs = postInThread
      ? await findSlackThreadRootTs(clientId, platform, campaignId, leadId, dbClient)
      : null;
    const contextMessage = resolveSlackContextMessage({
      platform,
      threadContext,
      lastOutboundMessage: enrichedCard.lastOutboundMessage,
      inboundMessage: enrichedCard.inboundMessage,
    });

    let payload = {
      ...enrichedCard,
      lastOutboundMessage: contextMessage.body || undefined,
      contextLabel: contextMessage.label,
      threadTs: threadTs || undefined,
      inThread: !!threadTs,
    };
    payload = await attachDraftCc(dbClient, { replyId, platform, isDraft, payload });

    const result = isDraft
      ? await slackApi.postDraftApproval(token, channelId, payload)
      : await slackApi.postAlert(token, channelId, payload);

    postedTs = result.ts;
    if (replyId) {
      await dbClient.query(
        'UPDATE pending_replies SET slack_message_ts = $1, updated_at = now() WHERE id = $2',
        [result.ts, replyId]
      );
    }

    const late = completeCardLinks({
      token,
      channelId,
      postedTs,
      isDraft,
      payload,
      card: enrichedCard,
      replyId,
      classification: card?.classification,
      slackApi,
      enrichFn,
      linkLookup,
      identity,
      dbClient,
      clientId,
      platform,
      campaignId,
      leadId,
    }).catch((err) => {
      console.warn('[Slack] Late card-link update failed', { replyId, err: err.message });
      return null;
    });

    if (awaitLinkUpdate) await late;

    return { ...result, threadRootTs: threadTs || result.ts, identity };
  } catch (err) {
    if (replyId && !postedTs) {
      const { releaseSlackCardClaim } = require('./reply-dedupe');
      await releaseSlackCardClaim(replyId).catch((releaseErr) => {
        console.warn('[Slack] Failed to release card claim', {
          replyId, err: releaseErr.message,
        });
      });
    }
    throw err;
  }
}

module.exports = {
  postProspectSlackCard,
  findSlackThreadRootTs,
  resolveLastOutboundForSlack,
  resolveSlackContextMessage,
  applyCardLinks,
  persistCardIdentity,
  completeCardLinks,
};
