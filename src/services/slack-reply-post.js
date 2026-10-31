const { extractLeadPhone } = require('../utils/lead-phone');
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
const { resolvePersonLocation, timezoneForLocation } = require('./lead-location');
const { lookupPersonProfile } = require('./person-profile-lookup');
const { alwaysForwardEmailsForProspectCc } = require('./client-cc');
const {
  resolveReplyIcp,
  checkingVerdict,
  unknownVerdict,
  icpVerdictEquals,
  parseStoredIcp,
} = require('./reply-icp');

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
    leadPhone: extra.phone || card.leadPhone || sourcePhoneForCard(card),
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
    leadIcpVerdict:
      extra.icp
      || identity.icp
      || card.leadIcpVerdict
      || undefined,
    leadFullName: extra.fullName || identity.fullName || card.leadFullName || undefined,
    leadPhoneAlt: extra.phoneAlt || card.leadPhoneAlt || undefined,
    leadLocation: extra.location || identity.location || card.leadLocation || undefined,
    leadTimezone:
      extra.timezone
      || identity.timezone
      || card.leadTimezone
      || timezoneForLocation(extra.location || identity.location || card.leadLocation)
      || undefined,
  };
}

/**
 * Latest rendered payload per posted card. The Smartlead webhook posts with
 * an empty draft, then the draft update and the late enrichment update race.
 * Each used to chat.update from its own stale copy, so whichever landed last
 * wiped the other (draft gone, or LinkedIn / website / phone / ICP back to
 * "not found"). Every update now merges into this state.
 */
const latestCards = new Map();
const LATEST_CARDS_MAX = 2000;
const IDENTITY_FIELDS = [
  'leadEmail', 'leadPhone', 'phoneProvider', 'leadPhoneAlt', 'leadLinkedinUrl', 'leadWebsite',
  'leadFullName', 'leadLocation', 'leadTimezone', 'enrichmentReceipt',
];

function isPlaceholderIcp(v) {
  return !v || (typeof v === 'object' && (v.status === 'unknown' || !v.status)
    && /checking/i.test(String(v.reason || '')));
}

/** Patch wins, except an empty identity field never erases a found one. */
function mergeCardPayload(base = {}, patch = {}) {
  const out = { ...base, ...patch };
  for (const k of IDENTITY_FIELDS) {
    if ((patch[k] == null || patch[k] === '') && base[k]) out[k] = base[k];
  }
  if (base.leadIcpVerdict && isPlaceholderIcp(patch.leadIcpVerdict) && !isPlaceholderIcp(base.leadIcpVerdict)) {
    out.leadIcpVerdict = base.leadIcpVerdict;
  }
  if (base.phoneEnrichmentStatus && !patch.phoneEnrichmentStatus) {
    out.phoneEnrichmentStatus = base.phoneEnrichmentStatus;
  }
  return out;
}

function rememberCard(replyId, payload, dbClient = db) {
  if (!replyId || !payload) return payload;
  latestCards.delete(replyId);
  latestCards.set(replyId, payload);
  while (latestCards.size > LATEST_CARDS_MAX) {
    latestCards.delete(latestCards.keys().next().value);
  }
  persistCardPayload(dbClient, replyId, payload);
  return payload;
}

function latestCard(replyId) {
  return replyId ? latestCards.get(replyId) || null : null;
}

function forgetCardMemory(replyId) {
  if (replyId) latestCards.delete(replyId);
}

/** Memory first, then the row. Survives a restart and the in-memory cap. */
async function loadLatestCard(replyId, dbClient = db) {
  if (!replyId) return null;
  const cached = latestCards.get(replyId);
  if (cached) return cached;
  try {
    const { rows } = await dbClient.query(
      'SELECT card_payload FROM pending_replies WHERE id = $1',
      [replyId]
    );
    const payload = rows[0]?.card_payload || null;
    if (payload && typeof payload === 'object') {
      latestCards.set(replyId, payload);
      return payload;
    }
  } catch (err) {
    if (!/card_payload/.test(err.message || '')) {
      console.warn('[Slack] load card payload failed', { replyId, err: err.message });
    }
  }
  return null;
}

/** chat.update a posted card with a partial patch merged over its latest state. */
async function patchPostedCard({
  slackApi = slack, token, channelId, ts, isDraft, replyId, base = {}, patch = {}, dbClient = db,
}) {
  const stored = await loadLatestCard(replyId, dbClient);
  const merged = mergeCardPayload(mergeCardPayload(base, stored || {}), patch);
  rememberCard(replyId, merged, dbClient);
  return updatePostedCard(slackApi, { token, channelId, ts, isDraft, payload: merged });
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

function persistCardPayload(dbClient, replyId, payload) {
  if (!dbClient || !replyId || !payload) return;
  let json;
  try { json = JSON.stringify(payload); } catch { return; }
  // Do not touch updated_at. A card refresh must not look like a fresh send.
  Promise.resolve(dbClient.query(
    'UPDATE pending_replies SET card_payload = $1::jsonb WHERE id = $2',
    [json, replyId]
  )).catch((err) => {
    if (!/card_payload/.test(err.message || '')) {
      console.warn('[Slack] persist card payload failed', { replyId, err: err.message });
    }
  });
}

/** Person location + time zone. Tolerates a DB without migration 038. */
async function persistLeadLocation(dbClient, replyId, { location, timezone, fullName } = {}) {
  if (!replyId || !dbClient || (!location && !timezone && !fullName)) return;
  try {
    await dbClient.query(
      `UPDATE pending_replies
          SET lead_location = COALESCE(lead_location, $1),
              lead_timezone = COALESCE(lead_timezone, $2),
              lead_full_name = COALESCE(lead_full_name, $3),
              updated_at = now()
        WHERE id = $4`,
      [location || null, timezone || null, fullName || null, replyId]
    );
  } catch (err) {
    if (!/lead_location|lead_timezone|lead_full_name/.test(err.message || '')) {
      console.warn('[Slack] persist lead location failed', { replyId, err: err.message });
    }
  }
}

/** A client with no ICP gets one built from Fireflies right away (single-flight per client). */
const icpBuildsInFlight = new Map();
function triggerClientIcpBuild(clientId, dbClient, { ensureFn } = {}) {
  if (!clientId || !dbClient || icpBuildsInFlight.has(clientId)) return icpBuildsInFlight.get(clientId) || null;
  const run = (async () => {
    const { rows } = await dbClient.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!rows[0]) return null;
    const ensure = ensureFn || require('./client-icp-profile').ensureClientIcp;
    const result = await ensure(rows[0], { db: dbClient });
    if (result?.status === 'ready' && result.reason !== 'existing_profile') {
      const { regradeNoIcpCards } = require('./regrade-no-icp-cards');
      await regradeNoIcpCards({ clientId, dbClient }).catch((err) => {
        console.warn('[Icp] regrade after on-demand build failed', { err: err.message });
      });
    }
    return result;
  })().catch((err) => {
    console.warn('[Icp] on-demand client ICP build failed', { err: err.message });
    return null;
  }).finally(() => {
    setTimeout(() => icpBuildsInFlight.delete(clientId), 60 * 60 * 1000).unref?.();
  });
  icpBuildsInFlight.set(clientId, run);
  return run;
}

function sourcePhoneForCard(card = {}) {
  return extractLeadPhone(
    { phone: card.leadPhone },
    card.leadData,
    card.payload,
    card.lead,
  ) || undefined;
}

/** Store the lead's own phone (free, from the reply source) so later card refreshes keep it. */
async function persistSourcePhone(dbClient, replyId, phone) {
  if (!replyId || !dbClient || !phone) return;
  try {
    await dbClient.query(
      `UPDATE pending_replies
          SET lead_phone = COALESCE(NULLIF(lead_phone, ''), $1),
              lead_phone_provider = COALESCE(lead_phone_provider, 'source'),
              updated_at = now()
        WHERE id = $2`,
      [phone, replyId]
    );
  } catch (err) {
    console.warn('[Slack] persist source phone failed', { replyId, err: err.message });
  }
}

/** Best effort: keep the lead's title and company so follow-up cards can show them. */
async function persistLeadTitleCompany(dbClient, replyId, { title, company } = {}) {
  const t = String(title || '').trim().slice(0, 200);
  const c = String(company || '').trim().slice(0, 200);
  if (!dbClient || !replyId || (!t && !c)) return;
  try {
    await dbClient.query(
      `UPDATE pending_replies
          SET lead_title = COALESCE(NULLIF($1, ''), lead_title),
              lead_company = COALESCE(NULLIF($2, ''), lead_company),
              updated_at = now()
        WHERE id = $3`,
      [t, c, replyId]
    );
  } catch (err) {
    if (!/lead_title|lead_company/.test(err.message || '')) {
      console.warn('[Slack] persist lead title/company skipped', { replyId, err: err.message });
    }
  }
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
    `SELECT c.cc_email, c.cc_emails, c.notify_emails, c.cc_round_robin_emails,
            c.name AS client_name, pr.cc_on_send, pr.lead_email
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.id = $1`,
    [replyId]
  );
  if (!ccRow) return payload;
  const ccClientEmails = alwaysForwardEmailsForProspectCc(ccRow, { leadEmail: ccRow.lead_email });
  return {
    ...payload,
    ccEmail: ccClientEmails || null,
    ccEmails: ccClientEmails || null,
    ccRoundRobinEmails: ccRow.cc_round_robin_emails,
    ccOnSend: !!ccRow.cc_on_send,
    clientName: ccRow.client_name,
  };
}

async function updatePostedCard(slackApi, {
  token, channelId, ts, isDraft, payload,
}) {
  if (!ts) return null;
  if (payload?.replyId) rememberCard(payload.replyId, payload);
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
  evaluateIcp = resolveReplyIcp,
  profileLookup = lookupPersonProfile,
  icpBuild = triggerClientIcpBuild,
}) {
  let linkedinUrl = identity.linkedinUrl || null;
  let location = identity.location || null;
  let fullName = identity.fullName || null;
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

  // Person profile: full name, LinkedIn fallback, and the PERSON's location.
  const firstOnly = String(card.leadName || '').trim().split(/\s+/).filter(Boolean).length < 2;
  const dmLib = require('./decision-maker');
  let title = dmLib.extractLeadTitle(card.leadData, card.payload, card.lead, card) || null;
  if (!linkedinUrl || !location || firstOnly || !title) {
    try {
      const prof = await profileLookup({
        email,
        leadName: card.leadName,
        companyName: card.leadCompany,
        linkedinUrl,
        location,
        title,
      });
      if (prof?.title && !title) title = prof.title;
      if (prof?.linkedinUrl && !linkedinUrl) linkedinUrl = prof.linkedinUrl;
      if (prof?.location && !location) location = prof.location;
      if (prof?.fullName && !fullName) fullName = prof.fullName;
    } catch (err) {
      console.warn('[Slack] Person profile lookup failed', { replyId, err: err.message });
    }
  }
  const timezone = identity.timezone || timezoneForLocation(location) || null;

  let icp = payload.leadIcpVerdict || card.leadIcpVerdict || null;
  try {
    icp = await evaluateIcp({
      website,
      clientName: payload.clientName || card.clientName,
      clientId,
      replyId,
      db: dbClient,
      grade: true,
    });
  } catch (err) {
    console.warn('[Slack] ICP verdict failed after card post', {
      replyId, err: err.message,
    });
    icp = icp || unknownVerdict('grade failed');
  }
  // Is the PERSON replying a buyer per this client's ICP titles?
  try {
    const personas = await dmLib.loadClientPersonas(dbClient, clientId);
    const dm = dmLib.judgeDecisionMaker(title, personas);
    icp = { ...(icp || unknownVerdict('grade failed')), decision_maker: dm };
    await dmLib.persistDecisionMaker(dbClient, replyId, dm);
  } catch (err) {
    console.warn('[Slack] decision-maker check failed', { replyId, err: err.message });
  }
  if (icp && icp.status === 'unknown' && /no ICP/i.test(String(icp.reason || ''))) {
    // Build this client's ICP from its Fireflies calls now; regrade updates the card.
    try { icpBuild(clientId, dbClient); } catch (err) { void err; }
  }

  const extra = {
    email,
    phone: enrichment?.phone || undefined,
    phoneProvider: enrichment?.provider || undefined,
    phoneEnrichmentStatus: enrichment?.status || undefined,
    enrichmentReceipt: enrichment?.receipt || undefined,
    phoneAlt: enrichment?.phoneAlt || undefined,
    linkedinUrl,
    website,
    icp,
    location: location || undefined,
    timezone: timezone || undefined,
    fullName: fullName || undefined,
  };
  const updatedCard = applyCardLinks(card, identity, extra);
  const storedLatest = await loadLatestCard(replyId, dbClient);
  const updatedPayload = mergeCardPayload(
    mergeCardPayload(payload, storedLatest || {}),
    updatedCard,
  );
  // Keep the newest draft text if the draft update landed first.
  const newest = latestCard(replyId) || storedLatest;
  if (newest && newest.draft) {
    updatedPayload.draft = newest.draft;
    if (newest.reasoning) updatedPayload.reasoning = newest.reasoning;
    if (newest.needsReview != null) updatedPayload.needsReview = newest.needsReview;
  }
  const callNowSwap = enrichment?.draftVariant === 'call_now_v1'
    && enrichment.draftReply && enrichment.draftReply !== updatedPayload.draft;
  if (callNowSwap) {
    updatedPayload.draft = enrichment.draftReply;
    updatedPayload.draftVariant = enrichment.draftVariant;
  }

  await persistCardIdentity(dbClient, replyId, { linkedinUrl, website, email });
  await persistLeadLocation(dbClient, replyId, { location, timezone, fullName });
  await persistLeadTitleCompany(dbClient, replyId, { title, company: card.leadCompany });
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
    || (extra.phoneAlt && extra.phoneAlt !== (payload.leadPhoneAlt || null))
    || (location && location !== (payload.leadLocation || null))
    || (fullName && fullName !== (payload.leadFullName || null))
    || callNowSwap
    || extra.phoneEnrichmentStatus === 'not_found'
    || extra.phoneEnrichmentStatus === 'failed'
    || (!extra.phone && !extra.phoneAlt
        && JSON.stringify(extra.enrichmentReceipt?.phoneLookup || null)
          !== JSON.stringify(payload.enrichmentReceipt?.phoneLookup || null))
    || !icpVerdictEquals(payload.leadIcpVerdict, icp);

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

  return {
    linkedinUrl, website, email, enrichment, icp, location, timezone, fullName, updated: changed,
  };
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
  postInThread = false,
  threadTs: explicitThreadTs = null,
  slackApi = slack,
  enrichFn = enrichPendingReplyPhone,
  identityResolve = resolveCardIdentity,
  linkLookup = lookupMissingLinkedin,
  evaluateIcp = resolveReplyIcp,
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

    const personLoc = resolvePersonLocation(card?.leadData, card?.payload, card?.lead, card);
    if (personLoc.location) {
      identity.location = identity.location || personLoc.location;
      identity.timezone = identity.timezone || personLoc.timezone;
    }

    const initialIcp = identity.website
      ? (card?.leadIcpVerdict || parseStoredIcp(card?.icpVerdict) || checkingVerdict())
      : unknownVerdict('no website');
    let enrichedCard = applyCardLinks(card, identity, { icp: initialIcp });
    await persistSourcePhone(dbClient, replyId, enrichedCard.leadPhone);
    await persistCardIdentity(dbClient, replyId, {
      linkedinUrl: identity.linkedinUrl,
      website: identity.website,
      email: identity.email || card?.leadEmail,
    });

    const earlierTs = await findSlackThreadRootTs(clientId, platform, campaignId, leadId, dbClient);
    const threadTs = explicitThreadTs || (postInThread ? earlierTs : null);
    let earlierPermalink = enrichedCard.threadPermalink || null;
    if (!postInThread && earlierTs && !earlierPermalink && token && channelId) {
      try {
        earlierPermalink = await slackApi.getPermalink(token, channelId, earlierTs);
      } catch (err) {
        console.warn('[Slack] Earlier-card permalink failed', { replyId, err: err.message });
      }
    }
    const contextMessage = resolveSlackContextMessage({
      platform,
      threadContext,
      lastOutboundMessage: enrichedCard.lastOutboundMessage,
      inboundMessage: enrichedCard.inboundMessage,
    });

    let heyreachPrep = null;
    if (platform === 'heyreach' && replyId) {
      try {
        const { prepareHeyreachDraftCard } = require('./heyreach-card-gate');
        heyreachPrep = await prepareHeyreachDraftCard({
          replyId, card: enrichedCard, dbClient, isDraft,
        });
      } catch (err) {
        console.warn('[Slack] HeyReach id resolve failed', { replyId, err: err.message });
        heyreachPrep = { canSend: false, linkedinUrl: enrichedCard.leadLinkedinUrl || enrichedCard.linkedinUrl || null };
      }
    }

    let payload = {
      ...enrichedCard,
      lastOutboundMessage: contextMessage.body || undefined,
      contextLabel: contextMessage.label,
      threadTs: threadTs || undefined,
      inThread: !!threadTs,
      threadPermalink: earlierPermalink || undefined,
      leadId,
      heyreachCanSend: heyreachPrep ? heyreachPrep.canSend : undefined,
      linkedinReplyUrl: heyreachPrep?.linkedinUrl || enrichedCard.leadLinkedinUrl || enrichedCard.linkedinUrl || undefined,
      conversationId: heyreachPrep?.conversationId || undefined,
      linkedInAccountId: heyreachPrep?.linkedInAccountId || undefined,
      hasHeyreachApiKey: heyreachPrep ? heyreachPrep.hasApiKey : undefined,
    };
    payload = await attachDraftCc(dbClient, { replyId, platform, isDraft, payload });

    const result = isDraft
      ? await slackApi.postDraftApproval(token, channelId, payload)
      : await slackApi.postAlert(token, channelId, payload);

    postedTs = result.ts;
    rememberCard(replyId, { ...payload, replyId }, dbClient);
    if (replyId) {
      try {
        await dbClient.query(
          `UPDATE pending_replies
              SET slack_message_ts = $1,
                  slack_channel_id = COALESCE($2, slack_channel_id),
                  updated_at = now()
            WHERE id = $3`,
          [result.ts, channelId || null, replyId]
        );
      } catch (err) {
        if (!/slack_channel_id/.test(err.message || '')) throw err;
        await dbClient.query(
          'UPDATE pending_replies SET slack_message_ts = $1, updated_at = now() WHERE id = $2',
          [result.ts, replyId]
        );
      }
    }

    if (
      platform === 'heyreach'
      && replyId
      && postedTs
      && String(card?.classification || payload.classification || '').toUpperCase() !== 'FOLLOW_UP'
    ) {
      try {
        const { supersedeEarlierOpenCards } = require('./supersede-cards');
        await supersedeEarlierOpenCards({
          clientId,
          platform,
          campaignId,
          leadId,
          leadEmail: payload.leadEmail || card?.leadEmail,
          keepId: replyId,
          newTs: postedTs,
          channelId,
          token,
          query: (sql, params) => dbClient.query(sql, params),
        });
      } catch (err) {
        console.warn('[Slack] Could not supersede older HeyReach cards', { replyId, err: err.message });
      }
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
      evaluateIcp,
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
  updatePostedCard,
  patchPostedCard,
  mergeCardPayload,
  rememberCard,
  latestCard,
  loadLatestCard,
  forgetCardMemory,
  persistLeadLocation,
  triggerClientIcpBuild,
};
