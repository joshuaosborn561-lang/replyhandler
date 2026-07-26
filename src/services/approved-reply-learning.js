const replyExamples = require('./reply-examples');

function serializeThread(threadContext) {
  if (!threadContext) return null;
  if (typeof threadContext === 'string') return threadContext.slice(0, 20000);
  try {
    return JSON.stringify(threadContext).slice(0, 20000);
  } catch {
    return null;
  }
}

/**
 * Store the final human-approved version as a retrieval example.
 *
 * A Slack-approved SmartLead send uses the inbox reply endpoint and therefore
 * has sequence_number = NULL by construction. Scheduled sequence sends never
 * pass through this handler and are never learned.
 */
async function learnFromApprovedReply({ reply, client, finalText }) {
  if (!replyExamples.isConfigured()) return { skipped: 'not_configured' };
  if (!reply || reply.platform !== 'smartlead') return { skipped: 'not_smartlead' };
  if (!finalText || !reply.inbound_message) return { skipped: 'missing_pair' };
  if (reply.campaign_id === 'test-campaign') return { skipped: 'test_fixture' };

  try {
    const result = await replyExamples.insertReplyExample({
      pendingReplyId: String(reply.id),
      leadMessage: reply.inbound_message,
      myReply: finalText,
      threadContext: serializeThread(reply.thread_context),
      category: reply.classification || null,
      clientName: client?.name || null,
      vertical: client?.vertical || null,
      platform: reply.platform,
      sequenceNumber: null,
    });
    console.log('[ReplyLearning] Approved manual reply stored', {
      replyId: reply.id,
      client: client?.name,
      inserted: Boolean(result.inserted),
      skipped: result.skipped || null,
    });
    return result;
  } catch (err) {
    // Learning must never make a successfully sent reply look failed.
    console.error('[ReplyLearning] Failed to store approved reply', {
      replyId: reply.id,
      err: err.message,
    });
    return { error: err.message };
  }
}

module.exports = { learnFromApprovedReply };
