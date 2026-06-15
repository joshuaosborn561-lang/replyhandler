const db = require('../db');
const slack = require('./slack');
const { lastOutboundBodyFromSmartleadHistory } = require('../utils/smartlead-webhook-helpers');

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

async function findSlackThreadRootTs(clientId, platform, campaignId, leadId) {
  const { rows } = await db.query(
    `SELECT slack_message_ts
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND COALESCE(campaign_id, '') = COALESCE($3::text, '')
        AND COALESCE(lead_id, '') = COALESCE($4::text, '')
        AND slack_message_ts IS NOT NULL
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

/**
 * Post a prospect reply card to Slack, threaded under the first card for this lead when one exists.
 * Always enriches context with your last outbound (or previous thread message).
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
}) {
  const threadTs = await findSlackThreadRootTs(clientId, platform, campaignId, leadId);
  const contextMessage = resolveSlackContextMessage({
    platform,
    threadContext,
    lastOutboundMessage: card.lastOutboundMessage,
    inboundMessage: card.inboundMessage,
  });

  const payload = {
    ...card,
    lastOutboundMessage: contextMessage.body || undefined,
    contextLabel: contextMessage.label,
    threadTs: threadTs || undefined,
    inThread: !!threadTs,
  };

  const result = isDraft
    ? await slack.postDraftApproval(token, channelId, payload)
    : await slack.postAlert(token, channelId, payload);

  if (replyId) {
    await db.query(
      'UPDATE pending_replies SET slack_message_ts = $1, updated_at = now() WHERE id = $2',
      [result.ts, replyId]
    );
  }

  return { ...result, threadRootTs: threadTs || result.ts };
}

module.exports = {
  postProspectSlackCard,
  findSlackThreadRootTs,
  resolveLastOutboundForSlack,
  resolveSlackContextMessage,
};
