/**
 * Turn an existing HeyReach alert card into a real approval card, in place.
 *
 *   POST /admin/heyreach/upgrade-alert-card  { reply_id, draft }
 *
 * The polling backstop can post a LinkedIn reply as an alert with no draft
 * (status alert_only). POST /admin/heyreach/approval-card refuses that row
 * (card_already_posted) and /admin/post-approval-card inserts a new Smartlead
 * email row, which is the wrong path. This writes the draft onto the SAME
 * pending_replies row, sets it to the normal approval status ('pending'), and
 * chat.update's the SAME Slack message (row channel + ts) with the normal
 * HeyReach draft-approval blocks.
 *
 * Never posts a new Slack message, never inserts a row, never sends to
 * HeyReach / LinkedIn. Approve is only rendered once the conversation id and
 * LinkedIn account id are on the row (looked up through the client's HeyReach
 * key via prepareHeyreachDraftCard when missing). If they cannot be resolved
 * the row and the Slack message are left exactly as they were.
 */

const db = require('../db');
const slack = require('./slack');
const { prepareHeyreachDraftCard } = require('./heyreach-card-gate');
const { loadLatestCard, rememberCard } = require('./slack-reply-post');
const { isPostedSlackTs } = require('./reply-dedupe');
const { formatCampaignDisplay } = require('../utils/campaign-display');

const DRAFT_CLASSIFICATIONS = new Set(['INTERESTED', 'MEETING_PROPOSED', 'QUESTION']);
const SENT_STATUSES = new Set(['sent', 'sending', 'approved']);
const UPGRADE_MARKER = 'upgradedFromAlertAt';

function fail(status, error, extra = {}) {
  return { status, body: { ok: false, error, ...extra } };
}

function parseThread(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function heyreachMeta(row) {
  const ctx = parseThread(row?.thread_context);
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return {};
  return ctx.heyreach && typeof ctx.heyreach === 'object' ? ctx.heyreach : {};
}

function threadMessages(row) {
  const ctx = parseThread(row?.thread_context);
  if (Array.isArray(ctx)) return ctx;
  return Array.isArray(ctx?.messages) ? ctx.messages : [];
}

function lastOutbound(row) {
  let last = '';
  for (const m of threadMessages(row)) {
    const role = String(m?.role || '').toLowerCase();
    if (role !== 'us' && role !== 'me') continue;
    const text = String(m.message || m.text || m.body || '').trim();
    if (text) last = text;
  }
  return last;
}

function idsEqual(a, b) {
  return String(a ?? '') === String(b ?? '');
}

/** Minimal card when the row has no stored card_payload (pre-payload rows). */
function cardFromRow(row) {
  return {
    replyId: row.id,
    leadName: row.lead_name,
    leadEmail: row.lead_email || undefined,
    leadFullName: row.lead_full_name || undefined,
    leadLinkedinUrl: row.linkedin_url || undefined,
    leadWebsite: row.lead_website || undefined,
    leadPhone: row.lead_phone || undefined,
    leadLocation: row.lead_location || undefined,
    leadTimezone: row.lead_timezone || undefined,
    leadCompany: row.lead_company || undefined,
    leadTitle: row.lead_title || undefined,
    platform: 'heyreach',
    inboundMessage: row.inbound_message,
    campaignDisplay: formatCampaignDisplay(row.campaign_name, row.campaign_id) || undefined,
    lastOutboundMessage: lastOutbound(row) || undefined,
    threadMessages: threadMessages(row),
    repliedAt: row.created_at,
  };
}

function missingIds(prep) {
  const missing = [];
  if (prep.derived) missing.push('real_heyreach_thread (row uses a derived thread key)');
  if (!prep.conversationId) missing.push('conversationId');
  if (prep.linkedInAccountId == null || String(prep.linkedInAccountId).trim() === '') {
    missing.push('linkedInAccountId');
  }
  if (!prep.hasApiKey) missing.push('client heyreach_api_key');
  return missing;
}

/**
 * @returns {Promise<{status:number, body:object}>}
 */
async function upgradeHeyreachAlertCard(input = {}, {
  dbClient = db,
  slackApi = slack,
  prepareFn = prepareHeyreachDraftCard,
  loadCard = (id) => loadLatestCard(id, dbClient),
  saveCard = (id, payload) => rememberCard(id, payload, dbClient),
  now = () => new Date(),
} = {}) {
  const replyId = String(input.reply_id || input.replyId || '').trim();
  if (!replyId) return fail(400, 'reply_id is required');
  if (typeof input.draft !== 'string' || !input.draft.trim()) {
    return fail(400, 'draft is required and must be a non-empty string');
  }
  const draft = input.draft.trim();
  const requested = String(input.classification || '').trim().toUpperCase();
  if (requested && !DRAFT_CLASSIFICATIONS.has(requested)) {
    return fail(400, 'classification must be INTERESTED, MEETING_PROPOSED, or QUESTION');
  }

  const { rows } = await dbClient.query(
    `SELECT pr.*,
            c.name AS client_name,
            c.slack_bot_token,
            c.active AS client_active
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.id = $1`,
    [replyId],
  );
  const row = rows[0];
  if (!row) return fail(404, 'reply not found', { replyId });
  if (String(row.platform || '').toLowerCase() !== 'heyreach') {
    return fail(400, 'not a HeyReach reply; this endpoint only upgrades HeyReach alert cards', {
      replyId, platform: row.platform || null,
    });
  }
  if (SENT_STATUSES.has(row.status) || String(row.sent_reply || '').trim()) {
    return fail(409, 'reply was already sent or is sending; nothing changed', { replyId, status: row.status });
  }

  const meta = heyreachMeta(row);
  const priorUpgrade = row.status === 'pending' && Boolean(meta[UPGRADE_MARKER]);
  if (row.status !== 'alert_only' && !priorUpgrade) {
    return fail(409, `reply status is '${row.status}'; only an alert_only HeyReach card can be upgraded`, {
      replyId, status: row.status,
    });
  }

  const channel = String(row.slack_channel_id || '').trim();
  const ts = String(row.slack_message_ts || '').trim();
  if (!channel || !ts || !isPostedSlackTs(ts)) {
    return fail(409, 'row has no posted Slack message (channel + ts); cannot update a card that was never posted', {
      replyId, slackChannelId: channel || null, slackMessageTs: ts || null,
    });
  }
  if (!row.slack_bot_token) return fail(409, 'client has no Slack bot token', { replyId });
  if (row.client_active === false) return fail(409, 'client is inactive', { replyId });

  const before = { conversationId: meta.conversationId || null, linkedInAccountId: meta.linkedinAccountId ?? meta.linkedInAccountId ?? null };

  // Resolve send ids first. Nothing is written to draft/status/Slack until Approve can work.
  let prep;
  try {
    prep = await prepareFn({
      replyId: row.id,
      card: { leadLinkedinUrl: row.linkedin_url || meta.linkedinUrl || null },
      dbClient,
      isDraft: true,
    });
  } catch (err) {
    console.warn('[Admin] upgrade-alert-card id resolve threw', { replyId, err: err.message });
    prep = { canSend: false, conversationId: before.conversationId, linkedInAccountId: before.linkedInAccountId, hasApiKey: false };
  }
  const idsBackfilled = Boolean(
    (prep.conversationId && !idsEqual(prep.conversationId, before.conversationId))
    || (prep.linkedInAccountId != null && !idsEqual(prep.linkedInAccountId, before.linkedInAccountId)),
  );
  if (!prep.canSend) {
    return fail(409, 'HeyReach send ids could not be resolved; Approve would fail, so the alert card and row were left unchanged', {
      replyId,
      status: row.status,
      missing: missingIds(prep),
      idsBackfilled,
      slackChannelId: channel,
      slackMessageTs: ts,
    });
  }

  const stored = String(row.classification || '').trim().toUpperCase();
  const classification = requested || (DRAFT_CLASSIFICATIONS.has(stored) ? stored : 'INTERESTED');
  const sameDraft = priorUpgrade && String(row.draft_reply || '').trim() === draft
    && String(row.classification || '').toUpperCase() === classification;

  // Re-read thread_context: prepareFn may have just stored the resolved ids on it.
  const { rows: [fresh] } = await dbClient.query(
    'SELECT thread_context FROM pending_replies WHERE id = $1',
    [row.id],
  );
  const ctxRaw = parseThread(fresh?.thread_context ?? row.thread_context);
  const ctx = ctxRaw && typeof ctxRaw === 'object' && !Array.isArray(ctxRaw)
    ? { ...ctxRaw }
    : { messages: Array.isArray(ctxRaw) ? ctxRaw : [] };
  ctx.heyreach = { ...(ctx.heyreach || {}) };
  if (!ctx.heyreach[UPGRADE_MARKER]) ctx.heyreach[UPGRADE_MARKER] = now().toISOString();

  if (!sameDraft) {
    const { rows: updated } = await dbClient.query(
      `UPDATE pending_replies
          SET draft_reply = $1,
              classification = $2,
              status = 'pending',
              thread_context = $3::jsonb,
              updated_at = now()
        WHERE id = $4
          AND platform = 'heyreach'
          AND COALESCE(sent_reply, '') = ''
          AND (status = 'alert_only' OR (status = 'pending' AND $5::boolean))
        RETURNING id, status`,
      [draft, classification, JSON.stringify(ctx), row.id, priorUpgrade],
    );
    if (!updated[0]) {
      return fail(409, 'reply changed while upgrading (sent, actioned, or re-statused); nothing was updated', { replyId });
    }
  }

  const base = (await loadCard(row.id)) || cardFromRow(row);
  const payload = {
    ...base,
    replyId: row.id,
    platform: 'heyreach',
    leadId: row.lead_id || base.leadId,
    classification,
    draft,
    reasoning: 'Upgraded from an alert to an approval card by admin. Nothing was sent.',
    needsReview: false,
    heyreachCanSend: true,
    hasHeyreachApiKey: true,
    conversationId: prep.conversationId,
    linkedInAccountId: prep.linkedInAccountId,
    leadLinkedinUrl: base.leadLinkedinUrl || prep.linkedinUrl || row.linkedin_url || undefined,
  };

  try {
    await slackApi.updateDraftApprovalCard(row.slack_bot_token, channel, ts, payload);
  } catch (err) {
    const slackError = String((err.data && err.data.error) || err.message).slice(0, 120);
    console.warn('[Admin] upgrade-alert-card chat.update failed', { replyId, err: slackError });
    return fail(502, 'Slack chat.update failed; the row has the draft (status pending) but the Slack message still shows the alert. Re-run to repaint.', {
      replyId, slackError, slackChannelId: channel, slackMessageTs: ts, idsBackfilled,
    });
  }
  try { saveCard(row.id, payload); } catch (err) { void err; }

  console.log('[Admin] upgrade-alert-card', {
    replyId, client: row.client_name, idsBackfilled, alreadyUpgraded: priorUpgrade, draftChanged: !sameDraft,
  });
  return {
    status: 200,
    body: {
      ok: true,
      replyId: row.id,
      status: 'pending',
      classification,
      previousStatus: row.status,
      previousClassification: row.classification || null,
      slackChannelId: channel,
      slackMessageTs: ts,
      idsBackfilled,
      conversationId: prep.conversationId,
      linkedInAccountId: prep.linkedInAccountId,
      alreadyUpgraded: priorUpgrade,
      draftChanged: !sameDraft,
      sent: false,
    },
  };
}

module.exports = {
  upgradeHeyreachAlertCard,
  UPGRADE_MARKER,
};
