/**
 * HeyReach draft cards only show Approve when we can actually send.
 * A derived thread key, a missing conversation id, a missing LinkedIn
 * account id, or a client with no HeyReach API key means the card offers
 * DQ, Meeting booked, and a Reply on LinkedIn link instead.
 */

const DERIVED_ID = /^hr-derived:/i;

function redactSecret(message, secret) {
  const text = String(message || '');
  if (!secret) return text;
  return text.split(String(secret)).join('[redacted]');
}

function parseThread(raw) {
  if (!raw) return {};
  let ctx = raw;
  if (typeof ctx === 'string') {
    try { ctx = JSON.parse(ctx); } catch { return {}; }
  }
  if (Array.isArray(ctx)) return { messages: ctx, heyreach: {} };
  if (!ctx || typeof ctx !== 'object') return {};
  return { ...ctx, heyreach: { ...(ctx.heyreach || {}) } };
}

function nonEmpty(value) {
  const s = String(value ?? '').trim();
  return s || null;
}

function isDerivedId(value) {
  return DERIVED_ID.test(String(value || '').trim());
}

/**
 * Approve is rendered only when every send prerequisite is present.
 * `hasApiKey` is a boolean — never pass the key itself onto a card.
 */
function heyreachCanApprove({
  replyId,
  leadId,
  conversationId,
  linkedInAccountId,
  hasApiKey,
} = {}) {
  if (isDerivedId(replyId) || isDerivedId(leadId)) return false;
  if (!nonEmpty(conversationId)) return false;
  if (linkedInAccountId == null || String(linkedInAccountId).trim() === '') return false;
  if (!hasApiKey) return false;
  return true;
}

function idsFromRow(row) {
  const ctx = parseThread(row?.thread_context);
  const meta = ctx.heyreach || {};
  return {
    ctx,
    meta,
    conversationId: nonEmpty(meta.conversationId),
    linkedInAccountId: meta.linkedinAccountId ?? meta.linkedInAccountId ?? null,
    linkedinUrl: nonEmpty(row?.linkedin_url) || nonEmpty(meta.linkedinUrl),
  };
}

function applySibling(current, sibling) {
  if (!sibling) return current;
  const next = { ...current };
  if (!next.linkedinUrl && sibling.linkedinUrl) next.linkedinUrl = sibling.linkedinUrl;
  if (!next.conversationId && sibling.conversationId) next.conversationId = sibling.conversationId;
  if ((next.linkedInAccountId == null || String(next.linkedInAccountId).trim() === '')
    && sibling.linkedinAccountId != null) {
    next.linkedInAccountId = sibling.linkedinAccountId;
  }
  return next;
}

async function persistIds(dbClient, row, ids) {
  const ctx = parseThread(row.thread_context);
  const meta = { ...(ctx.heyreach || {}) };
  if (ids.conversationId) meta.conversationId = ids.conversationId;
  if (ids.linkedInAccountId != null && String(ids.linkedInAccountId).trim() !== '') {
    meta.linkedinAccountId = ids.linkedInAccountId;
  }
  if (ids.linkedinUrl) meta.linkedinUrl = ids.linkedinUrl;
  ctx.heyreach = meta;
  await dbClient.query(
    `UPDATE pending_replies
        SET thread_context = $1::jsonb,
            linkedin_url = COALESCE(NULLIF(linkedin_url, ''), $2),
            updated_at = now()
      WHERE id = $3`,
    [JSON.stringify(ctx), ids.linkedinUrl || null, row.id]
  );
}

/**
 * Fill conversationId + linkedInAccountId on a HeyReach draft before the
 * Slack card is posted. Lookup failure still posts the card; Approve stays off.
 * Never logs the API key.
 */
async function prepareHeyreachDraftCard({
  replyId,
  card,
  dbClient,
  isDraft = true,
  findConversation = null,
  lookupSibling = null,
} = {}) {
  const linkedFromCard = nonEmpty(card?.leadLinkedinUrl) || nonEmpty(card?.linkedinUrl);
  const empty = {
    canSend: false,
    linkedinUrl: linkedFromCard,
    conversationId: null,
    linkedInAccountId: null,
    hasApiKey: false,
    derived: false,
  };
  if (!replyId || !dbClient) return empty;

  const { rows } = await dbClient.query(
    `SELECT pr.id, pr.lead_id, pr.lead_name, pr.linkedin_url, pr.thread_context, pr.client_id,
            c.heyreach_api_key
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.id = $1`,
    [replyId]
  );
  const row = rows[0];
  if (!row) return empty;

  const apiKey = nonEmpty(row.heyreach_api_key);
  const derived = isDerivedId(row.id) || isDerivedId(row.lead_id);
  let ids = idsFromRow(row);
  if (!ids.linkedinUrl && linkedFromCard) ids.linkedinUrl = linkedFromCard;

  const missing = !ids.conversationId
    || ids.linkedInAccountId == null
    || String(ids.linkedInAccountId).trim() === '';

  if (isDraft && missing && !derived) {
    try {
      const lookup = lookupSibling || ((r) => {
        const { lookupStoredHeyreachIdentifiers } = require('./reply-send');
        return lookupStoredHeyreachIdentifiers(r, (sql, params) => dbClient.query(sql, params));
      });
      const sibling = await lookup(row);
      ids = applySibling(ids, sibling);
    } catch (err) {
      console.warn('[HeyReach] Stored id lookup failed before card post', {
        replyId, err: redactSecret(err.message, apiKey),
      });
    }
  }

  const stillMissing = !ids.conversationId
    || ids.linkedInAccountId == null
    || String(ids.linkedInAccountId).trim() === '';

  if (isDraft && stillMissing && apiKey && !derived) {
    try {
      const find = findConversation || ((key, args) => {
        const heyreach = require('./heyreach');
        return heyreach.findConversation(key, args);
      });
      const found = await find(apiKey, {
        conversationId: ids.conversationId,
        leadId: isDerivedId(row.lead_id) ? null : row.lead_id,
        linkedinUrl: ids.linkedinUrl,
        leadName: row.lead_name,
        allowNameSearch: true,
        maxPages: 15,
        limit: 100,
      });
      if (found) {
        const heyreach = require('./heyreach');
        const conversationId = heyreach.extractHeyreachConversationId(found) || ids.conversationId;
        const linkedInAccountId = heyreach.extractHeyreachLinkedInAccountId(found);
        const linkedinUrl = heyreach.extractHeyreachLinkedinUrl(found) || ids.linkedinUrl;
        ids = {
          ...ids,
          conversationId: nonEmpty(conversationId) || ids.conversationId,
          linkedInAccountId: linkedInAccountId != null ? linkedInAccountId : ids.linkedInAccountId,
          linkedinUrl: nonEmpty(linkedinUrl) || ids.linkedinUrl,
        };
      }
    } catch (err) {
      console.warn('[HeyReach] Inbox lookup failed before card post', {
        replyId, err: redactSecret(err.message, apiKey),
      });
    }
  }

  const changed = ids.conversationId !== idsFromRow(row).conversationId
    || String(ids.linkedInAccountId ?? '') !== String(idsFromRow(row).linkedInAccountId ?? '')
    || (ids.linkedinUrl && ids.linkedinUrl !== idsFromRow(row).linkedinUrl);
  if (changed && (ids.conversationId || ids.linkedInAccountId != null || ids.linkedinUrl)) {
    try {
      await persistIds(dbClient, row, ids);
    } catch (err) {
      console.warn('[HeyReach] Could not store resolved ids', {
        replyId, err: redactSecret(err.message, apiKey),
      });
    }
  }

  return {
    canSend: heyreachCanApprove({
      replyId: row.id,
      leadId: row.lead_id,
      conversationId: ids.conversationId,
      linkedInAccountId: ids.linkedInAccountId,
      hasApiKey: Boolean(apiKey),
    }),
    linkedinUrl: ids.linkedinUrl || linkedFromCard,
    conversationId: ids.conversationId,
    linkedInAccountId: ids.linkedInAccountId,
    hasApiKey: Boolean(apiKey),
    derived,
  };
}

module.exports = {
  heyreachCanApprove,
  isDerivedId,
  prepareHeyreachDraftCard,
  redactSecret,
};
