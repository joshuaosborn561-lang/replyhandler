/**
 * FOLLOW_UP structured flags live on thread_context.follow_up_meta so the
 * Slack card can be rebuilt without a new column. extractThreadMessages
 * already ignores unknown keys.
 */

function parseThreadContext(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function wrapThreadContext(raw) {
  const parsed = parseThreadContext(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...parsed };
  if (Array.isArray(parsed)) return { messages: parsed };
  return parsed == null ? {} : { value: parsed };
}

function attachFollowUpMeta(threadContext, meta) {
  const wrapped = wrapThreadContext(threadContext);
  const needsClient = Boolean(meta && meta.needsClient);
  wrapped.follow_up_meta = {
    needs_client: needsClient,
    what_to_send: needsClient ? (String(meta.whatToSend || '').trim() || null) : null,
  };
  return wrapped;
}

function readFollowUpMeta(threadContext) {
  const parsed = parseThreadContext(threadContext);
  const meta = parsed && typeof parsed === 'object' ? parsed.follow_up_meta : null;
  if (!meta || typeof meta !== 'object') {
    return { needsClient: false, whatToSend: null };
  }
  const needsClient = meta.needs_client === true || meta.needsClient === true;
  const what = String(meta.what_to_send || meta.whatToSend || '').trim();
  return {
    needsClient,
    whatToSend: needsClient ? (what || null) : null,
  };
}

module.exports = {
  parseThreadContext,
  attachFollowUpMeta,
  readFollowUpMeta,
};
