/**
 * HeyReach Unibox deep link.
 *
 * The signed-in app (app.heyreach.io, bundle checked Nov 2026) mounts
 * INBOX_ROUTES at /app/inbox with a child route :account_id/:conversation_id.
 * Those two ids are the same pair GetChatroom uses
 * (GET /inbox/GetChatroom/{accountId}/{conversationId}) and the pair we
 * already store on pending_replies.thread_context.heyreach.
 *
 * Workspace query params (ws, t) are not stored on the reply, so the link
 * opens in whatever workspace the clicker is signed into. When either id
 * is missing the link is the Unibox itself, not the LinkedIn profile.
 */

const INBOX_URL = 'https://app.heyreach.io/app/inbox';

function heyreachConversationUrl({ conversationId, linkedInAccountId, linkedinAccountId } = {}) {
  const account = linkedInAccountId ?? linkedinAccountId;
  const conv = String(conversationId || '').trim();
  const acct = account == null ? '' : String(account).trim();
  if (!conv || !acct) return INBOX_URL;
  return `${INBOX_URL}/${encodeURIComponent(acct)}/${encodeURIComponent(conv)}`;
}

function isHeyreachAppUrl(url) {
  return /^https:\/\/app\.heyreach\.io\//i.test(String(url || '').trim());
}

function heyreachIdsFromContext(threadContext) {
  let ctx = threadContext;
  if (typeof ctx === 'string') {
    try { ctx = JSON.parse(ctx); } catch { ctx = null; }
  }
  const meta = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? (ctx.heyreach || {}) : {};
  const conversationId = String(meta.conversationId || '').trim() || null;
  const linkedInAccountId = meta.linkedinAccountId ?? meta.linkedInAccountId ?? null;
  return { conversationId, linkedInAccountId };
}

module.exports = {
  HEYREACH_INBOX_URL: INBOX_URL,
  heyreachConversationUrl,
  isHeyreachAppUrl,
  heyreachIdsFromContext,
};
