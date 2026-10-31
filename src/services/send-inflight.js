/**
 * In-flight platform sends. SIGTERM waits for these before the process exits
 * so a reply is not left approved/sending with the provider call half-done.
 */

const inflight = new Map();

function trackSend(replyId, promise) {
  const key = replyId == null ? null : String(replyId);
  const tracked = Promise.resolve(promise).finally(() => {
    if (key && inflight.get(key) === tracked) inflight.delete(key);
  });
  if (key) inflight.set(key, tracked);
  return tracked;
}

function isSendInFlight(replyId) {
  return replyId != null && inflight.has(String(replyId));
}

function inFlightCount() {
  return inflight.size;
}

/**
 * @param {number} [timeoutMs]
 * @returns {Promise<{ drained: number, timedOut: boolean }>}
 */
function drainInFlightSends(timeoutMs = 25000) {
  const pending = [...inflight.values()];
  if (!pending.length) return Promise.resolve({ drained: 0, timedOut: false });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ drained: pending.length, timedOut: true }), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([
    Promise.allSettled(pending).then(() => {
      clearTimeout(timer);
      return { drained: pending.length, timedOut: false };
    }),
    timeout,
  ]);
}

module.exports = {
  trackSend,
  isSendInFlight,
  inFlightCount,
  drainInFlightSends,
};
