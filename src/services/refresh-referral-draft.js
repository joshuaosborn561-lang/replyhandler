/**
 * Rewrite a referral card's draft to the fixed template.
 *
 * A row that already has a Slack message is chat.update'd in place.
 * A row with no card is posted once. Nothing is sent to the prospect.
 */

const db = require('../db');
const slack = require('./slack');
const { postProspectSlackCard } = require('./slack-reply-post');
const { formatCampaignDisplay } = require('../utils/campaign-display');
const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');
const {
  extractReferredContacts,
  referralCcCsv,
  referralDraftText,
} = require('../utils/referred-contact');
const { promoteReferral } = require('../utils/referral-promotion');
const { ourIdentitiesFromThread } = require('../utils/reply-all');

const CLOSED = new Set([
  'sent', 'approved', 'sending', 'rejected', 'disqualified', 'meeting_booked',
]);

function hasPostedSlackCard(ts) {
  const s = String(ts || '').trim();
  return Boolean(s) && !s.startsWith('claiming:');
}

function referralGroupKey(row) {
  const mid = String(row.inbound_message_id || '').trim().toLowerCase();
  if (mid) return `mid:${mid}`;
  const email = String(row.lead_email || '').trim().toLowerCase();
  const body = String(row.inbound_message || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 240);
  return `body:${email}|${row.campaign_id || ''}|${body}`;
}

function planReferralCardActions(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = referralGroupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const actions = [];
  for (const group of groups.values()) {
    for (const row of group) {
      if (CLOSED.has(String(row.status || '').toLowerCase())) {
        actions.push({ type: 'skip', reason: 'already_actioned', row });
      }
    }
    const open = group.filter((row) => !CLOSED.has(String(row.status || '').toLowerCase()));
    const postedOpen = open.filter((row) => hasPostedSlackCard(row.slack_message_ts));
    const anyPosted = group.some((row) => hasPostedSlackCard(row.slack_message_ts));
    if (postedOpen.length) {
      for (const row of postedOpen) actions.push({ type: 'update', row });
      for (const row of open) {
        if (!postedOpen.includes(row)) {
          actions.push({ type: 'skip', reason: 'card_already_exists', row });
        }
      }
      continue;
    }
    if (anyPosted) {
      for (const row of open) actions.push({ type: 'skip', reason: 'card_already_exists', row });
      continue;
    }
    const pendingClaim = open.filter((row) => String(row.slack_message_ts || '').startsWith('claiming:'));
    if (pendingClaim.length) {
      for (const row of open) actions.push({ type: 'skip', reason: 'claim_in_flight', row });
      continue;
    }
    const sorted = [...open].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    if (!sorted.length) continue;
    actions.push({ type: 'post', row: sorted[0] });
    for (const row of sorted.slice(1)) actions.push({ type: 'skip', reason: 'duplicate_row', row });
  }
  return actions;
}

function referralOptsForRow(row) {
  let thread = row.thread_context;
  if (typeof thread === 'string') {
    try { thread = JSON.parse(thread); } catch { thread = null; }
  }
  return {
    prospectEmail: row.lead_email,
    prospectName: row.lead_name,
    ourEmails: ourIdentitiesFromThread(thread),
  };
}

function contactsForRow(row) {
  return extractReferredContacts(row.inbound_message, referralOptsForRow(row));
}

function draftForRow(row) {
  const opts = referralOptsForRow(row);
  return referralDraftText({
    leadName: row.lead_name,
    inboundMessage: row.inbound_message,
    referredContacts: contactsForRow(row),
    ...opts,
  });
}

function classificationForRow(row, contacts) {
  const current = String(row.classification || '').toUpperCase();
  if (['INTERESTED', 'MEETING_PROPOSED', 'QUESTION'].includes(current)) return current;
  const ref = promoteReferral(current || 'OTHER', row.inbound_message, referralOptsForRow(row));
  if (ref.classification && (ref.promoted || (ref.referredContacts || []).length || contacts.length)) {
    return ref.classification;
  }
  return current || 'INTERESTED';
}

function cardPayload(row, draft, contacts) {
  let thread = row.thread_context;
  if (typeof thread === 'string') {
    try { thread = JSON.parse(thread); } catch { thread = null; }
  }
  const lastOutbound = thread && typeof thread === 'object' && !Array.isArray(thread)
    ? (lastOutboundBodyFromSmartleadHistory(thread) || '')
    : '';
  return {
    replyId: row.id,
    leadName: row.lead_name,
    leadEmail: row.lead_email,
    leadPhone: row.lead_phone || undefined,
    phoneProvider: row.lead_phone_provider || undefined,
    phoneEnrichmentStatus: row.phone_enrichment_status || undefined,
    enrichmentReceipt: (row.enrichment_receipt && row.enrichment_receipt.phoneLookup) ? { phoneLookup: row.enrichment_receipt.phoneLookup } : undefined,
    leadLinkedinUrl: row.linkedin_url || undefined,
    leadWebsite: row.lead_website || undefined,
    leadPhoneAlt: row.lead_phone_alt || undefined,
    leadLocation: row.lead_location || undefined,
    leadTimezone: row.lead_timezone || undefined,
    leadFullName: row.lead_full_name || undefined,
    leadIcpVerdict: row.icp_verdict || undefined,
    platform: row.platform || 'smartlead',
    classification: classificationForRow(row, contacts),
    draft,
    reasoning: 'Referral draft template.',
    inboundMessage: row.inbound_message,
    campaignDisplay: formatCampaignDisplay(row.campaign_name, row.campaign_id) || undefined,
    lastOutboundMessage: lastOutbound || undefined,
    ccEmails: row.notify_emails || undefined,
    ccEmail: row.notify_emails || undefined,
    ccRoundRobinEmails: row.cc_round_robin_emails || undefined,
    clientName: row.client_name || undefined,
    referredContacts: contacts,
  };
}

async function defaultSaveDraft(query, row, draft, contacts) {
  const cc = referralCcCsv(contacts);
  const classification = classificationForRow(row, contacts);
  await query(
    `UPDATE pending_replies
        SET draft_reply = $1,
            classification = $2,
            referral_cc = COALESCE($3, referral_cc),
            status = CASE WHEN status = 'suppressed' THEN 'pending' ELSE status END,
            suppression_reason = CASE WHEN status = 'suppressed' THEN NULL ELSE suppression_reason END,
            updated_at = now()
      WHERE id = $4
        AND status NOT IN ('sent', 'approved', 'sending', 'rejected', 'disqualified', 'meeting_booked')`,
    [draft, classification, cc || null, row.id]
  );
}

async function defaultUpdateCard(row, card) {
  await slack.updateDraftApprovalCard(
    row.slack_bot_token,
    row.slack_channel_id,
    row.slack_message_ts,
    card,
  );
}

async function defaultPostCard(row, card) {
  return postProspectSlackCard({
    token: row.slack_bot_token,
    channelId: row.slack_channel_id,
    clientId: row.client_id,
    platform: row.platform || 'smartlead',
    campaignId: row.campaign_id,
    leadId: row.lead_id,
    threadContext: row.thread_context,
    isDraft: true,
    replyId: row.id,
    card,
  });
}

async function findReferralRows({ leadEmail, replyId, campaignId, query }) {
  const email = String(leadEmail || '').trim().toLowerCase();
  const id = String(replyId || '').trim();
  const campaign = String(campaignId || '').trim();
  // A named lead or reply id is one prospect. The poller lookback and this
  // scan window must not hide that row. An unscoped dry run stays recent.
  const targeted = Boolean(email || id);
  const ageClause = targeted ? '' : `AND pr.created_at > now() - interval '30 days'`;
  const { rows } = await query(
    `SELECT pr.*,
            c.slack_bot_token,
            c.slack_channel_id,
            c.name AS client_name,
            c.cc_email,
            c.cc_emails,
            c.notify_emails,
            c.cc_round_robin_emails
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE COALESCE(pr.classification, '') <> 'FOLLOW_UP'
        AND ($1 = '' OR lower(pr.lead_email) = $1)
        AND ($2 = '' OR pr.id::text = $2)
        AND ($3 = '' OR pr.campaign_id::text = $3)
        ${ageClause}
      ORDER BY pr.created_at ASC
      LIMIT 50`,
    [email, id, campaign]
  );
  return rows.filter((row) => draftForRow(row));
}

async function refreshReferralDrafts({
  dry = true,
  leadEmail = '',
  replyId = '',
  campaignId = '',
  missingOnly = false,
  query = (...args) => db.query(...args),
  saveDraft = null,
  updateCard = null,
  postCard = null,
} = {}) {
  const rows = await findReferralRows({ leadEmail, replyId, campaignId, query });
  const actions = planReferralCardActions(rows);
  const summary = {
    dry: Boolean(dry),
    scanned: rows.length,
    updated: 0,
    posted: 0,
    skipped: 0,
    rows: [],
  };
  const write = saveDraft || ((row, draft, contacts) => defaultSaveDraft(query, row, draft, contacts));
  const rewrite = updateCard || defaultUpdateCard;
  const publish = postCard || defaultPostCard;

  for (const action of actions) {
    const row = action.row;
    const contacts = contactsForRow(row);
    const draft = draftForRow(row);
    if (action.type === 'skip' || !draft) {
      summary.skipped += 1;
      summary.rows.push({
        replyId: row.id,
        leadEmail: row.lead_email,
        action: 'skip',
        reason: action.reason || 'not_a_referral',
        slackMessageTs: row.slack_message_ts || null,
      });
      continue;
    }
    if (missingOnly && action.type === 'update') {
      summary.skipped += 1;
      summary.rows.push({
        replyId: row.id,
        leadEmail: row.lead_email,
        action: 'skip',
        reason: 'card_already_exists',
        slackMessageTs: row.slack_message_ts || null,
      });
      continue;
    }
    const card = cardPayload(row, draft, contacts);
    if (dry) {
      summary.rows.push({
        replyId: row.id,
        leadEmail: row.lead_email,
        action: action.type === 'update' ? 'would_update' : 'would_post',
        draft,
        slackMessageTs: row.slack_message_ts || null,
        cc: referralCcCsv(contacts) || null,
      });
      continue;
    }
    await write(row, draft, contacts);
    if (action.type === 'update') {
      await rewrite(row, card);
      summary.updated += 1;
      summary.rows.push({
        replyId: row.id,
        leadEmail: row.lead_email,
        action: 'updated',
        draft,
        slackMessageTs: row.slack_message_ts,
        cc: referralCcCsv(contacts) || null,
      });
      console.log('[ReferralDraft] Updated card in place', {
        replyId: row.id, slackMessageTs: row.slack_message_ts, cc: referralCcCsv(contacts) || null,
      });
      continue;
    }
    const posted = await publish(row, card);
    summary.posted += 1;
    summary.rows.push({
      replyId: row.id,
      leadEmail: row.lead_email,
      action: posted?.skipped ? 'post_skipped' : 'posted',
      reason: posted?.reason || posted?.skipped || null,
      draft,
      slackMessageTs: posted?.ts || row.slack_message_ts || null,
      cc: referralCcCsv(contacts) || null,
    });
    console.log('[ReferralDraft] Posted one referral card', {
      replyId: row.id, skipped: posted?.skipped || null, cc: referralCcCsv(contacts) || null,
    });
  }
  return summary;
}

module.exports = {
  CLOSED,
  hasPostedSlackCard,
  referralGroupKey,
  planReferralCardActions,
  draftForRow,
  cardPayload,
  refreshReferralDrafts,
};
