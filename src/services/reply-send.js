const db = require('../db');
const smartlead = require('./smartlead');
const heyreach = require('./heyreach');
const calendar = require('./calendar');
const { parseProposedTime } = require('../utils/parse-proposed-time');
const {
  notifyEmails,
  formatEmailList,
  stripClientSendAddresses,
  alwaysForwardEmailsForProspectCc,
} = require('./client-cc');
const { enrichProspect } = require('./prospect-enrich');
const { buildClientNotifyEmail, pickRicherThreadContext } = require('./client-notify-email');
const clientDigest = require('./client-reply-digest');
const gmail = require('./gmail-send');
const clientClaimed = require('./client-claimed');
const {
  alreadySentSameOutbound,
  claimOutboundSend,
  normalizeInboundText,
  sameNormalizedInbound,
} = require('./reply-dedupe');
const { deepRootsClientNotifySkipReason } = require('../utils/deep-roots-client-notify');
const { fyiCcEmails, fyiReplyTo, mergeEmailLists } = require('../utils/fyi-notify');
const {
  buildReplyAll, mergeCcLists, emailsFromValue, ourIdentitiesFromThread,
} = require('../utils/reply-all');
const { filterOwnAddresses } = require('../utils/own-addresses');
const { sendCcNotice } = require('./cc-notice-email');
const { trackSend } = require('./send-inflight');

/** Rows created by POST /admin/test/slack-draft — not real SmartLead/HeyReach leads */
function isSlackTestFixtureReply(reply) {
  return reply.campaign_id === 'test-campaign' && reply.lead_id === 'test-lead';
}

function isFollowUpPlaceholder(text) {
  const s = String(text || '').trim().toLowerCase();
  return !s
    || s.startsWith('(no new reply')
    || s.includes('follow-up re-attempt');
}

/**
 * Live SmartLead history + prior approved sends, so a FOLLOW_UP notify
 * includes the first reply — not just the inbound-time snapshot.
 */
async function resolveClientNotifyThread(client, reply) {
  let live = null;
  const leadIdNumeric = reply.lead_id != null && /^\d+$/.test(String(reply.lead_id).trim());
  if (
    reply.platform === 'smartlead'
    && client.smartlead_api_key
    && reply.campaign_id
    && leadIdNumeric
  ) {
    try {
      live = await smartlead.getThreadHistory(
        client.smartlead_api_key,
        reply.campaign_id,
        reply.lead_id,
      );
    } catch (err) {
      console.warn('[ReplySend] Live thread history for client notify failed', {
        replyId: reply.id, err: err.message,
      });
    }
  }

  const extraMessages = [];
  if (reply.client_id && reply.platform) {
    try {
      const { rows } = await db.query(
        `SELECT id, sent_reply, inbound_message, classification, updated_at
           FROM pending_replies
          WHERE client_id = $1
            AND platform = $2
            AND status = 'sent'
            AND sent_reply IS NOT NULL
            AND trim(sent_reply) <> ''
            AND ($5::uuid IS NULL OR id <> $5)
            AND (
              ($3::text <> '' AND COALESCE(lead_id, '') = $3)
              OR ($4::text <> '' AND lower(COALESCE(lead_email, '')) = $4)
            )
          ORDER BY updated_at ASC
          LIMIT 20`,
        [
          reply.client_id,
          reply.platform,
          reply.lead_id != null ? String(reply.lead_id) : '',
          reply.lead_email ? String(reply.lead_email).trim().toLowerCase() : '',
          reply.id || null,
        ],
      );
      for (const r of rows) {
        if (
          r.inbound_message
          && !isFollowUpPlaceholder(r.inbound_message)
          && String(r.classification || '').toUpperCase() !== 'FOLLOW_UP'
        ) {
          extraMessages.push({
            type: 'REPLY',
            email_body: r.inbound_message,
            time: r.updated_at,
          });
        }
        extraMessages.push({
          type: 'SENT',
          email_body: r.sent_reply,
          time: r.updated_at,
        });
      }
    } catch (err) {
      console.warn('[ReplySend] Prior-send lookup for client notify failed', {
        replyId: reply.id, err: err.message,
      });
    }
  }

  return {
    threadContext: pickRicherThreadContext(live, reply.thread_context),
    extraMessages,
  };
}

function parseStoredThreadContext(raw) {
  if (!raw) return {};
  let ctx = raw;
  if (typeof ctx === 'string') {
    try { ctx = JSON.parse(ctx); } catch { return {}; }
  }
  if (Array.isArray(ctx)) return { messages: ctx, heyreach: {} };
  if (!ctx || typeof ctx !== 'object') return {};
  return { ...ctx, heyreach: { ...(ctx.heyreach || {}) } };
}

function heyreachMeta(reply) {
  return parseStoredThreadContext(reply?.thread_context).heyreach || {};
}

function nonEmpty(value) {
  const s = String(value ?? '').trim();
  return s || null;
}

function heyreachSendReady(meta, linkedinUrl) {
  const conversationId = nonEmpty(meta?.conversationId);
  const linkedInAccountId = meta?.linkedinAccountId ?? meta?.linkedInAccountId ?? null;
  const listId = meta?.listId ?? null;
  const url = nonEmpty(meta?.linkedinUrl) || nonEmpty(linkedinUrl);
  if (conversationId && linkedInAccountId) return true;
  if (listId && linkedInAccountId && url) return true;
  return false;
}

function slackFailure(message) {
  const s = String(message || 'HeyReach send failed').replace(/\s+/g, ' ').trim();
  return s.length > 500 ? `${s.slice(0, 497)}…` : s;
}

function redactSecret(message, secret) {
  const text = String(message || '');
  if (!secret) return text;
  return text.split(String(secret)).join('[redacted]');
}

function identifiersFromSiblingRow(row) {
  const ctx = parseStoredThreadContext(row?.thread_context);
  const meta = ctx.heyreach || {};
  return {
    linkedinUrl: nonEmpty(row?.linkedin_url) || nonEmpty(meta.linkedinUrl),
    conversationId: nonEmpty(meta.conversationId),
    linkedinAccountId: meta.linkedinAccountId ?? meta.linkedInAccountId ?? null,
    listId: meta.listId ?? null,
    senderId: meta.senderId ?? null,
    inboundMessage: row?.inbound_message || '',
    leadName: row?.lead_name || '',
  };
}

/**
 * A manual card can be missing HeyReach ids while the suppressed inbox row
 * still has the LinkedIn URL (or, after this change, the conversation ids).
 * Same inbound text wins. A name-only match is used only when every stored
 * URL for that name is the same person.
 */
async function lookupStoredHeyreachIdentifiers(reply, query) {
  const name = nonEmpty(reply?.lead_name);
  const leadId = nonEmpty(reply?.lead_id);
  const usableLeadId = leadId && leadId !== 'test-lead' ? leadId : '';
  const ownUrl = nonEmpty(reply?.linkedin_url) || nonEmpty(heyreachMeta(reply).linkedinUrl);
  if (!reply?.client_id || !reply?.id) return null;
  if (!name && !usableLeadId && !ownUrl) return null;
  const nameTokens = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .map((token) => token.replace(/[%_\\]/g, ''));
  const firstToken = nameTokens[0] || '';
  const lastToken = nameTokens.length > 1 ? nameTokens[nameTokens.length - 1] : '';

  const { rows } = await query(
    `SELECT id, linkedin_url, thread_context, inbound_message, lead_name, lead_id
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'heyreach'
        AND id <> $2
        AND (
          ($3::text <> '' AND COALESCE(lead_id, '') = $3)
          OR ($4::text <> '' AND lower(COALESCE(lead_name, '')) = lower($4))
          OR ($5::text <> '' AND lower(COALESCE(linkedin_url, '')) = lower($5))
          OR (
            $6::text <> '' AND $7::text <> ''
            AND lower(COALESCE(lead_name, '')) LIKE '%' || $6 || '%'
            AND lower(COALESCE(lead_name, '')) LIKE '%' || $7 || '%'
          )
        )
      ORDER BY created_at DESC
      LIMIT 25`,
    [reply.client_id, reply.id, usableLeadId, name || '', ownUrl || '', firstToken, lastToken]
  );

  const parsed = (rows || []).map(identifiersFromSiblingRow).filter((row) => (
    row.linkedinUrl || (row.conversationId && row.linkedinAccountId)
  ));
  if (!parsed.length) return null;

  const ownSlug = heyreach.linkedinProfileSlug(ownUrl);
  const compatible = parsed.filter((row) => {
    const slug = heyreach.linkedinProfileSlug(row.linkedinUrl);
    if (ownSlug && slug && ownSlug !== slug) return false;
    return true;
  });
  if (!compatible.length) return null;

  const wantInbound = normalizeInboundText(reply.inbound_message);
  const inboundHits = wantInbound
    ? compatible.filter((row) => normalizeInboundText(row.inboundMessage) === wantInbound)
    : [];
  if (inboundHits.length) {
    return inboundHits.find((row) => row.conversationId && row.linkedinAccountId)
      || inboundHits.find((row) => row.linkedinUrl)
      || inboundHits[0];
  }

  if (usableLeadId) {
    const byLead = compatible.find((row) => row.conversationId && row.linkedinAccountId)
      || compatible.find((row) => row.linkedinUrl);
    if (byLead) return byLead;
  }

  if (!name) return null;
  const sameName = compatible.filter((row) => (
    heyreach.namesMatch(name, { name: row.leadName })
  ));
  const slugs = [...new Set(sameName.map((row) => heyreach.linkedinProfileSlug(row.linkedinUrl)).filter(Boolean))];
  if (slugs.length !== 1) return null;
  return sameName.find((row) => heyreach.linkedinProfileSlug(row.linkedinUrl) === slugs[0]) || null;
}

async function heyreachConversationAlreadySent(reply, conversationId, query) {
  const want = normalizeInboundText(reply?.inbound_message);
  if (!want || !reply?.client_id || !reply?.id || !conversationId) return false;
  const { rows } = await query(
    `SELECT id, inbound_message
       FROM pending_replies
      WHERE client_id = $1
        AND platform = 'heyreach'
        AND status = 'sent'
        AND id <> $2
        AND thread_context #>> '{heyreach,conversationId}' = $3
      ORDER BY updated_at DESC
      LIMIT 20`,
    [reply.client_id, reply.id, String(conversationId)]
  );
  return (rows || []).some((row) => {
    const got = normalizeInboundText(row.inbound_message);
    return got === want || sameNormalizedInbound(got, want);
  });
}

async function persistHeyreachIdentifiers(reply, patch, query) {
  const ctx = parseStoredThreadContext(reply.thread_context);
  const prev = ctx.heyreach || {};
  const next = { ...prev };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value == null || value === '') continue;
    next[key] = value;
  }
  ctx.heyreach = next;
  const linkedinUrl = nonEmpty(next.linkedinUrl) || nonEmpty(reply.linkedin_url);
  if (linkedinUrl) {
    next.linkedinUrl = linkedinUrl;
    reply.linkedin_url = linkedinUrl;
  }
  reply.thread_context = ctx;
  if (!reply.id) return ctx;
  await query(
    `UPDATE pending_replies
        SET thread_context = $1::jsonb,
            linkedin_url = COALESCE(NULLIF(linkedin_url, ''), $2),
            updated_at = now()
      WHERE id = $3`,
    [JSON.stringify(ctx), linkedinUrl, reply.id]
  );
  return ctx;
}

/**
 * Send a HeyReach reply. When the stored row has no conversationId +
 * linkedInAccountId (suppressed inbox rows, or a manual card), look the
 * conversation up with the server-side HeyReach key and persist the ids
 * before sending. Lookup failure does not send.
 */
async function sendHeyreachReply(client, reply, replyText, deps = {}) {
  const query = deps.query || ((sql, params) => db.query(sql, params));
  const findConversation = deps.findConversation || heyreach.findConversation.bind(heyreach);
  const sendMessage = deps.sendMessage || heyreach.sendMessage.bind(heyreach);
  const lookupSibling = deps.lookupSibling
    || ((row) => lookupStoredHeyreachIdentifiers(row, query));

  const ctx = parseStoredThreadContext(reply.thread_context);
  let meta = { ...(ctx.heyreach || {}) };
  let linkedinUrl = nonEmpty(meta.linkedinUrl) || nonEmpty(reply.linkedin_url);
  let filled = false;

  if (!heyreachSendReady(meta, linkedinUrl)) {
    let sibling = null;
    try {
      sibling = await lookupSibling(reply);
    } catch (err) {
      console.warn('[ReplySend] HeyReach sibling identifier lookup failed', {
        replyId: reply.id, err: err.message,
      });
    }
    if (sibling) {
      const siblingSlug = heyreach.linkedinProfileSlug(sibling.linkedinUrl);
      const ownSlug = heyreach.linkedinProfileSlug(linkedinUrl);
      const slugOk = !ownSlug || !siblingSlug || ownSlug === siblingSlug;
      if (slugOk) {
        if (!linkedinUrl && sibling.linkedinUrl) linkedinUrl = sibling.linkedinUrl;
        if (!nonEmpty(meta.conversationId) && sibling.conversationId) meta.conversationId = sibling.conversationId;
        if ((meta.linkedinAccountId == null && meta.linkedInAccountId == null) && sibling.linkedinAccountId) {
          meta.linkedinAccountId = sibling.linkedinAccountId;
        }
        if (meta.listId == null && sibling.listId != null) meta.listId = sibling.listId;
        if (meta.senderId == null && sibling.senderId != null) meta.senderId = sibling.senderId;
        if (linkedinUrl) meta.linkedinUrl = linkedinUrl;
        filled = true;
      }
    }
  }

  if (!heyreachSendReady(meta, linkedinUrl)) {
    const apiKey = client?.heyreach_api_key;
    if (!apiKey) {
      throw new Error('HeyReach API key is missing, so the conversation could not be looked up. Nothing was sent.');
    }
    let found = null;
    try {
      found = await findConversation(apiKey, {
        conversationId: nonEmpty(meta.conversationId),
        leadId: reply.lead_id,
        linkedinUrl,
        leadName: reply.lead_name,
        allowNameSearch: true,
        maxPages: 15,
        limit: 100,
      });
    } catch (err) {
      const raw = redactSecret(err.message, apiKey);
      if (/nothing was sent/i.test(raw)) throw new Error(slackFailure(raw));
      const status = err.status ? ` (${err.status})` : '';
      throw new Error(slackFailure(
        `HeyReach inbox lookup failed${status}. Nothing was sent. ${raw}`
      ));
    }
    if (!found) {
      const who = reply.lead_name || 'this lead';
      const where = linkedinUrl ? ` (${linkedinUrl})` : '';
      throw new Error(slackFailure(
        `HeyReach conversation not found for ${who}${where}. Nothing was sent.`
      ));
    }
    const conversationId = heyreach.extractHeyreachConversationId(found);
    const linkedInAccountId = heyreach.extractHeyreachLinkedInAccountId(found);
    const foundUrl = heyreach.extractHeyreachLinkedinUrl(found);
    if (!conversationId || !linkedInAccountId) {
      throw new Error(slackFailure(
        'HeyReach inbox lookup found a conversation but it had no conversationId and linkedInAccountId. Nothing was sent.'
      ));
    }
    if (linkedinUrl && foundUrl && !heyreach.linkedinUrlsMatch(linkedinUrl, foundUrl)) {
      throw new Error(slackFailure(
        `HeyReach inbox lookup found a different LinkedIn profile than the one stored for ${reply.lead_name || 'this lead'}. Nothing was sent.`
      ));
    }
    meta.conversationId = conversationId;
    meta.linkedinAccountId = linkedInAccountId;
    if (foundUrl && (!linkedinUrl || heyreach.linkedinUrlsMatch(linkedinUrl, foundUrl))) {
      linkedinUrl = foundUrl;
    }
    if (linkedinUrl) meta.linkedinUrl = linkedinUrl;
    const foundList = found.listId || found.list_id || found.list?.id || null;
    if (meta.listId == null && foundList != null) meta.listId = foundList;
    filled = true;
  }

  if (!heyreachSendReady(meta, linkedinUrl)) {
    throw new Error(slackFailure(
      'HeyReach send is missing conversationId and linkedInAccountId. Nothing was sent.'
    ));
  }

  const conversationId = nonEmpty(meta.conversationId);
  if (conversationId && await heyreachConversationAlreadySent(reply, conversationId, query)) {
    console.warn('[ReplySend] Skipping HeyReach send — this inbound was already sent', {
      replyId: reply.id, conversationId,
    });
    return { skippedDuplicate: true, reason: 'same_heyreach_conversation' };
  }

  if (filled) {
    try {
      await persistHeyreachIdentifiers(reply, {
        conversationId: meta.conversationId || null,
        linkedinAccountId: meta.linkedinAccountId ?? meta.linkedInAccountId ?? null,
        linkedinUrl: linkedinUrl || meta.linkedinUrl || null,
        listId: meta.listId ?? null,
        senderId: meta.senderId ?? null,
        campaignName: meta.campaignName || null,
      }, query);
    } catch (err) {
      console.warn('[ReplySend] Could not persist HeyReach identifiers', {
        replyId: reply.id, err: err.message,
      });
    }
  }

  // LinkedIn sends have no email CC field. Client addresses stay off this payload.
  await sendMessage(client.heyreach_api_key, {
    conversationId: meta.conversationId || null,
    linkedInAccountId: meta.linkedinAccountId ?? meta.linkedInAccountId ?? null,
    senderId: meta.senderId || null,
    listId: meta.listId || null,
    linkedinUrl: meta.linkedinUrl || linkedinUrl || reply.linkedin_url || null,
    message: replyText,
  });
}

async function sendReplyToPlatform(client, reply, replyText, opts = {}) {
  if (reply?.id && !reply._sendTracked) {
    return trackSend(reply.id, sendReplyToPlatform(
      client,
      { ...reply, _sendTracked: true },
      replyText,
      opts,
    ));
  }
  const { ccClientOnProspect = false, referralCc = null } = opts;
  if (isSlackTestFixtureReply(reply)) {
    console.log('[ReplySend] Skipping outbound API — Slack test fixture', { replyId: reply.id, platform: reply.platform });
    return;
  }

  // Portal takeover: do not send if the client already claimed this lead.
  await clientClaimed.assertNotClaimedOrThrow(reply);

  // Claim the person before any provider call. Two approvals of the same
  // follow-up (overlapping replicas, or a reworded second card) both used to
  // pass the sent-text check below — the first row was not `sent` yet, and
  // Jeff Miller's two drafts diverged in the opening line.
  const sendClaim = await claimOutboundSend({ replyId: reply.id, replyText });
  if (!sendClaim.ok) {
    console.warn('[ReplySend] Skipping outbound — duplicate or already handled', {
      replyId: reply.id, lead: reply.lead_name, reason: sendClaim.reason,
    });
    return { skippedDuplicate: true, reason: sendClaim.reason };
  }

  // Two Slack cards for one inbound (webhook + poller race) can both be
  // approved. Do not deliver the same outbound twice (Casey Buckstaff).
  if (await alreadySentSameOutbound({
    clientId: reply.client_id,
    platform: reply.platform,
    leadId: reply.lead_id,
    leadEmail: reply.lead_email,
    replyText,
    exceptReplyId: reply.id,
  })) {
    console.warn('[ReplySend] Skipping outbound — same text already sent to this person', {
      replyId: reply.id, lead: reply.lead_name, platform: reply.platform,
    });
    return { skippedDuplicate: true };
  }

  const referralListEarly = Array.isArray(referralCc) ? referralCc.filter(Boolean) : [];
  if (referralListEarly.length && reply.platform !== 'smartlead') {
    throw new Error(`Cannot CC ${referralListEarly.join(', ')} on this channel. Nothing was sent.`);
  }

  if (reply.platform === 'smartlead') {
    // Primary: the stats_id captured at webhook ingestion.
    // Fallback: resolve live from message-history (for older rows that predate the column).
    let emailStatsId = reply.smartlead_email_stats_id || null;
    const leadId = reply.lead_id;
    const leadIdNumeric = leadId != null && /^\d+$/.test(String(leadId).trim());
    if (!emailStatsId && leadIdNumeric) {
      console.log('[ReplySend] SmartLead stats_id missing on row — resolving live', {
        replyId: reply.id, campaignId: reply.campaign_id, leadId: reply.lead_id,
      });
      emailStatsId = await smartlead.resolveEmailStatsId(client.smartlead_api_key, reply.campaign_id, leadId);
      if (emailStatsId) {
        await db.query('UPDATE pending_replies SET smartlead_email_stats_id = $1 WHERE id = $2', [emailStatsId, reply.id]);
      }
    } else if (!emailStatsId && !leadIdNumeric) {
      console.warn('[ReplySend] SmartLead stats_id missing and lead_id is not numeric — cannot resolve from history', {
        replyId: reply.id, campaignId: reply.campaign_id, leadId: reply.lead_id,
      });
    }

    // Prospect reply has no client CC unless Josh hits "Approve & Send + CC client"
    // or ticks the Edit modal checkbox. That choice uses notify_emails only.
    // cc_emails, cc_email, and contact_email never ride on the send.
    // Instant mode (PROSPECT_REPLY_NOTIFY_MODE=instant) is the old per-send
    // Gmail, and it goes to notify_emails — not the portal CC list. Default
    // is the 4:00pm CT roll-up. 'off' sends none.
    const hasForwardConfig = notifyEmails(client).length > 0;
    let forwardEmails = '';
    let ccMeta = null;
    const notifyMode = clientDigest.clientNotifyMode();
    if (hasForwardConfig && notifyMode === 'instant') {
      forwardEmails = formatEmailList(notifyEmails(client));
    }

    let clientCcWarning = '';
    let clientCcMode = '';
    let enrichment = null;
    let prospectCc = '';
    const sendOpts = { replyText, emailStatsId };

    let threadForReplyAll = reply.thread_context;
    if (leadIdNumeric && client.smartlead_api_key) {
      try {
        threadForReplyAll = await smartlead.getThreadHistory(
          client.smartlead_api_key,
          reply.campaign_id,
          reply.lead_id,
        ) || threadForReplyAll;
      } catch (err) {
        console.warn('[ReplySend] Thread fetch for reply-all failed — using stored context', {
          replyId: reply.id, err: err.message,
        });
      }
    }
    let accountEmails = [];
    try {
      accountEmails = await smartlead.listEmailAccounts(client.smartlead_api_key);
    } catch (err) {
      console.warn('[ReplySend] listEmailAccounts failed', { replyId: reply.id, err: err.message });
    }
    const replyAll = buildReplyAll({
      history: threadForReplyAll,
      accountEmails,
      originalLeadEmail: reply.lead_email,
      fallbackName: reply.lead_name,
    });
    if (replyAll.recipient) sendOpts.toEmail = replyAll.recipient;
    if (replyAll.senderFirstName) sendOpts.toFirstName = replyAll.senderFirstName;
    if (replyAll.replyMessageId) sendOpts.replyMessageId = replyAll.replyMessageId;
    if (replyAll.replyEmailTime) sendOpts.replyEmailTime = replyAll.replyEmailTime;
    if (replyAll.replyEmailBody) sendOpts.replyEmailBody = replyAll.replyEmailBody;

    if (ccClientOnProspect) {
      // Manual choice only. notify_emails, minus Josh/Cayden/our domains, the lead, the sending inbox.
      const sendingInboxes = [...emailsFromValue(accountEmails), ...ourIdentitiesFromThread(threadForReplyAll)];
      prospectCc = alwaysForwardEmailsForProspectCc(client, {
        leadEmail: reply.lead_email,
        exclude: [replyAll.recipient, ...sendingInboxes],
        excludeDomains: sendingInboxes.map((e) => e.split('@')[1]).filter(Boolean),
      });
      if (!prospectCc) {
        console.warn('[ReplySend] Send + CC client requested but notify_emails is empty', {
          replyId: reply.id,
        });
      }
      if (prospectCc) sendOpts.cc = prospectCc;
    }
    // Reply-all: CC other humans on the inbound. The manual client CC is merged
    // after client addresses are stripped, so a plain Approve cannot keep a
    // client who was already on the thread. A referred-contact CC is explicit.
    // A referral CC the prospect or Josh typed is explicit, but our own addresses are never a referral.
    const referralList = filterOwnAddresses(Array.isArray(referralCc) ? referralCc.filter(Boolean) : []);
    let ccMerged = stripClientSendAddresses(mergeCcLists(replyAll.cc, referralList), client);
    if (prospectCc) ccMerged = mergeCcLists(ccMerged, prospectCc);
    if (ccMerged.length) sendOpts.cc = ccMerged.join(', ');
    if (referralList.length) {
      const ccLower = String(sendOpts.cc || '').toLowerCase();
      const missing = referralList.filter((email) => !ccLower.includes(String(email).toLowerCase()));
      if (reply.platform !== 'smartlead' || missing.length || !sendOpts.cc) {
        throw new Error(
          `Cannot CC ${referralList.join(', ')} on this thread. Nothing was sent.`
        );
      }
      sendOpts.requireCc = true;
      sendOpts.requiredCc = referralList;
      console.log('[ReplySend] Referral CC', { replyId: reply.id, cc: referralList.join(', ') });
    }

    await smartlead.sendReply(
      client.smartlead_api_key,
      reply.campaign_id,
      reply.lead_id,
      sendOpts
    );

    // "We just CC'd you" notice (CC_NOTICE_EMAIL_ENABLED, default off): the reply above went out with
    // the client's always-CC addresses on it, so tell those contacts to check spam and which inbox it
    // came from. One email per send, from Josh's inbox. Never throws, never blocks the card.
    let ccNotice = null;
    if (ccClientOnProspect && prospectCc) {
      ccNotice = await sendCcNotice({
        replyId: reply.id,
        leadName: reply.lead_name,
        company: reply.lead_company,
        leadEmail: reply.lead_email,
        ccEmails: prospectCc,
        history: threadForReplyAll,
        emailStatsId,
        accountEmails,
      });
      if (ccNotice.sent) {
        console.log('[ReplySend] CC notice sent from primary Gmail', {
          replyId: reply.id, recipients: ccNotice.to.length,
        });
      }
    }

    let clientNotifyError = null;
    if (forwardEmails) {
    try {
      const { threadContext, extraMessages } = await resolveClientNotifyThread(client, reply);
      const notifySkip = deepRootsClientNotifySkipReason({
        clientName: client.name,
        inboundMessage: reply.inbound_message,
        threadContext,
        extraMessages,
        classification: reply.classification,
      });
      if (notifySkip) {
        console.log('[ReplySend] Deep Roots client notify skipped', {
          replyId: reply.id, lead: reply.lead_name, reason: notifySkip,
        });
        return {
          clientNotifySkipped: true,
          clientNotifySkipReason: notifySkip,
          prospectCcEmails: prospectCc || undefined,
        };
      }

      try {
        if (reply.phone_enrichment_status === 'found' ||
            reply.phone_enrichment_status === 'not_found') {
          enrichment = {
            email: reply.lead_email || null,
            phone: reply.lead_phone || null,
            linkedinUrl: reply.linkedin_url || null,
            website: reply.lead_website || null,
            sources: {
              email: reply.lead_email ? 'reply' : null,
              phone: reply.lead_phone_provider || null,
            },
          };
        } else {
          enrichment = await enrichProspect({
            email: reply.lead_email,
            linkedinUrl: reply.linkedin_url,
            leadName: reply.lead_name,
          });
        }
      } catch (err) {
        console.warn('[ReplySend] Prospect enrichment failed (notifying without full enrich)', {
          replyId: reply.id, err: err.message,
        });
        enrichment = {
          email: reply.lead_email || null,
          phone: null,
          linkedinUrl: reply.linkedin_url || null,
          website: null,
          sources: {},
        };
      }

      const notify = buildClientNotifyEmail({
        leadName: reply.lead_name,
        leadEmail: reply.lead_email,
        clientName: client.name,
        campaignName: reply.campaign_name || reply.campaign_id,
        enrichment,
        threadContext,
        extraMessages,
        inboundMessage: reply.inbound_message,
        sentText: replyText,
      });

      try {
        if (!gmail.isConfigured()) {
          throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured');
        }
        const account = await gmail.getAccount();
        if (!account) {
          throw new Error(`Primary Gmail not connected — open /auth/gmail/connect (login as ${gmail.expectedFromEmail()})`);
        }

        await gmail.sendMail({
          to: forwardEmails,
          cc: fyiCcEmails(),
          replyTo: fyiReplyTo(),
          subject: notify.subject,
          htmlBody: notify.htmlBody,
          textBody: notify.textBody,
        });
        clientCcMode = 'gmail';
        console.log('[ReplySend] Client notify sent from primary Gmail', {
          replyId: reply.id,
          to: forwardEmails,
          from: account.email,
          always: ccMeta?.always,
          roundRobin: ccMeta?.roundRobin,
          cellPhone: enrichment?.phone || null,
          linkedin: enrichment?.linkedinUrl || null,
          sources: enrichment?.sources || null,
        });
      } catch (mailErr) {
        // Fallback: SmartLead forward so the client still gets a copy.
        console.warn('[ReplySend] Primary Gmail notify failed — falling back to SmartLead forward', {
          replyId: reply.id, err: mailErr.message,
        });
        try {
          await smartlead.forwardThreadToClient(
            client.smartlead_api_key,
            reply.campaign_id,
            reply.lead_id,
            {
              toEmail: mergeEmailLists(forwardEmails, fyiCcEmails()).join(', '),
              leadName: reply.lead_name,
              leadEmail: enrichment?.email || reply.lead_email,
              sentText: replyText,
              cellPhone: enrichment?.phone || null,
              phoneProvider: enrichment?.sources?.phone || null,
            }
          );
          clientCcMode = 'forward';
          clientCcWarning = `Primary Gmail failed (${mailErr.message}); used SmartLead forward instead`;
        } catch (fwdErr) {
          console.error('[ReplySend] Client copy failed (reply still sent)', {
            replyId: reply.id, gmailErr: mailErr.message, fwdErr: fwdErr.message,
          });
          clientCcWarning = `Client copy could not be sent: ${mailErr.message}`;
        }
      }
    } catch (notifyErr) {
      // The prospect reply already went out. A failed notify copy must never
      // turn a sent reply into a failed card.
      clientNotifyError = notifyErr.message;
      console.warn('[ReplySend] Client notify copy failed after send', { replyId: reply.id, err: notifyErr.message });
    }
    }

    // Roll-up: the reply is answered (the Smartlead send above succeeded). Queue it for the client's
    // 4:00pm CT email when it is a positive reply, the client has a notify list, and the Deep Roots
    // gate would not have skipped it. The queue is a flag on the row; nothing is emailed here.
    let digestQueued = false;
    if (notifyMode === 'rollup' && hasForwardConfig && !isSlackTestFixtureReply(reply)
        && clientDigest.isDigestEligible(reply)) {
      let skip = null;
      if (/deep\s*roots/i.test(String(client.name || ''))) {
        try {
          const { threadContext, extraMessages } = await resolveClientNotifyThread(client, reply);
          skip = deepRootsClientNotifySkipReason({
            clientName: client.name,
            inboundMessage: reply.inbound_message,
            threadContext,
            extraMessages,
            classification: reply.classification,
          });
        } catch (err) {
          console.warn('[ReplySend] Deep Roots gate check failed, queuing anyway', { replyId: reply.id, err: err.message });
        }
      }
      if (skip) {
        console.log('[ReplySend] Deep Roots client notify skipped', { replyId: reply.id, reason: skip });
      } else {
        digestQueued = await clientDigest.queueForDigest(reply.id);
      }
    }

    if (referralList.length) {
      try {
        await db.query(
          `UPDATE pending_replies SET referral_cc = $1, updated_at = now() WHERE id = $2`,
          [referralList.join(', '), reply.id]
        );
      } catch (err) {
        console.warn('[ReplySend] referral_cc not stored', {
          replyId: reply.id, cc: referralList.join(', '), err: err.message,
        });
      }
    }

    return {
      clientNotifyError: clientNotifyError || undefined,
      clientCcWarning: clientCcWarning || undefined,
      clientCcMode: clientCcMode || undefined,
      clientCcEmails: forwardEmails || undefined,
      clientNotifyMode: notifyMode,
      clientDigestQueued: digestQueued || undefined,
      clientCcRoundRobin: ccMeta?.roundRobin || undefined,
      prospectCcEmails: prospectCc || undefined,
      ccNoticeSent: ccNotice?.sent || undefined,
      ccNoticeSkipped: ccNotice && !ccNotice.sent ? (ccNotice.skipped || ccNotice.error) : undefined,
      referralCcEmails: referralList.length ? referralList.join(', ') : undefined,
      leadCellPhone: enrichment?.phone || undefined,
      leadCellPhoneProvider: enrichment?.sources?.phone || undefined,
      leadLinkedinUrl: enrichment?.linkedinUrl || undefined,
      leadWebsite: enrichment?.website || undefined,
    };
  }

  if (reply.platform === 'heyreach') {
    return sendHeyreachReply(client, reply, replyText);
  }

  throw new Error(`Unknown platform: ${reply.platform}`);
}

/**
 * After a human-approved message is sent, optionally book calendar for MEETING_PROPOSED.
 */
async function maybeBookMeetingAfterSend(reply, client) {
  if (isSlackTestFixtureReply(reply)) return '';
  if (reply.classification !== 'MEETING_PROPOSED') return '';

  const { rows: [meeting] } = await db.query('SELECT * FROM meetings WHERE pending_reply_id = $1', [reply.id]);
  if (!meeting || !meeting.proposed_time) return '';

  const attendeeEmail = reply.lead_email || meeting.lead_email;
  if (!attendeeEmail) {
    return '\n⚠️ No email for this prospect — calendar invite not sent. Book manually.';
  }

  try {
    const result = await calendar.bookMeeting(reply.client_id, {
      summary: `Call with ${reply.lead_name}`,
      description: `Booked via SalesGlider AI Reply Handler (${reply.platform})`,
      startTime: parseProposedTime(meeting.proposed_time),
      durationMinutes: 30,
      attendeeEmail,
      attendeeName: reply.lead_name || 'Prospect',
    });

    await db.query(
      `UPDATE meetings SET status = 'booked', confirmed_time = $1, calendar_event_id = $2,
       calendar_provider = $3, meeting_link = $4, updated_at = now() WHERE id = $5`,
      [parseProposedTime(meeting.proposed_time), result.eventId, result.provider, result.meetingLink, meeting.id]
    );

    const linkMsg = result.meetingLink ? ` Meeting link: ${result.meetingLink}` : '';
    console.log('[ReplySend] Meeting booked', { meetingId: meeting.id, provider: result.provider, eventId: result.eventId });
    return `\n📅 Meeting booked on ${result.provider} calendar.${linkMsg}`;
  } catch (bookErr) {
    console.error('[ReplySend] Calendar booking failed (reply still sent)', { err: bookErr.message });
    return `\n⚠️ Calendar booking failed: ${bookErr.message}. Please book manually.`;
  }
}

module.exports = {
  sendReplyToPlatform,
  sendHeyreachReply,
  lookupStoredHeyreachIdentifiers,
  maybeBookMeetingAfterSend,
  isSlackTestFixtureReply,
  resolveClientNotifyThread,
};
