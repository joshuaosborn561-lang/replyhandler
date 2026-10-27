/**
 * Why a reply card has no phone.
 *
 * Josh (Oct 27 2026): "just say when you can't find a phone number from FE so
 * i know if its that or no credits". The card shows one short line that
 * separates "FullEnrich searched and found nothing" from "FullEnrich is out of
 * credits", a timed-out lookup, and a lookup that errored or never ran.
 *
 * The outcome is computed where the waterfall result lands
 * (reply-phone-enrichment.js), stored on enrichment_receipt.phoneLookup, and
 * rendered by slack.js. Nothing here touches a lead row or a key.
 */

const OUTCOMES = new Set([
  'no_match', 'out_of_credits', 'timeout', 'error', 'not_run', 'unknown',
]);

/** Why FullEnrich was not run, when the waterfall reports not_run. */
const NOT_RUN_REASONS = new Set(['not_hot_reply', 'spend_cap', 'unavailable']);

function isTimeoutError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const msg = String(err.message || err || '');
  return name === 'TimeoutError'
    || name === 'AbortError'
    || /aborted due to timeout|operation was aborted|timed? ?out|ETIMEDOUT/i.test(msg);
}

function isCreditsError(err) {
  const msg = String(err?.message || err || '');
  return /\b402\b|credits?[ _.-]*(insufficient|exhausted|depleted)|out of credits|not enough credits|payment required/i.test(msg);
}

/** A lookup that threw (network, abort, waterfall 4xx/5xx). */
function phoneLookupFromError(err) {
  if (isTimeoutError(err)) return { outcome: 'timeout' };
  if (isCreditsError(err)) return { outcome: 'out_of_credits' };
  return { outcome: 'error' };
}

/**
 * @param {{
 *   fullenrich?: {mobile?: string, creditsExhausted?: boolean, enabled?: boolean}|null,
 *   skipped?: string|null,       // 'ceiling' when the budget blocked the phone step
 *   fullenrichAllowed?: boolean, // reply type + budget allowed the FullEnrich mobile tier
 * }} args
 * Only call when no phone was found. Returns null when there is nothing to say.
 */
function phoneLookupFromHit({ fullenrich = null, skipped = null, fullenrichAllowed = true } = {}) {
  if (skipped === 'ceiling') return { outcome: 'not_run', reason: 'spend_cap' };
  if (!fullenrich) {
    // Older waterfall build: it said nothing about FullEnrich, so do not guess.
    return fullenrichAllowed
      ? { outcome: 'unknown' }
      : { outcome: 'not_run', reason: 'not_hot_reply' };
  }
  const mobile = String(fullenrich.mobile || '');
  if (fullenrich.creditsExhausted && mobile !== 'found') {
    return { outcome: 'out_of_credits' };
  }
  switch (mobile) {
    case 'no_match': return { outcome: 'no_match' };
    case 'out_of_credits': return { outcome: 'out_of_credits' };
    case 'timeout': return { outcome: 'timeout' };
    case 'error': return { outcome: 'error' };
    case 'not_run':
      if (!fullenrichAllowed) return { outcome: 'not_run', reason: 'not_hot_reply' };
      if (fullenrich.enabled === false) return { outcome: 'not_run', reason: 'unavailable' };
      return { outcome: 'not_run' };
    default:
      return { outcome: 'unknown' };
  }
}

/**
 * Slack mrkdwn line (no leading newline). Empty string = say nothing.
 * `status` is pending_replies.phone_enrichment_status, used only to cover rows
 * that failed before a receipt could be stored.
 */
function phoneMissingText(lookup, status) {
  const outcome = lookup && OUTCOMES.has(lookup.outcome)
    ? lookup.outcome
    : (String(status || '') === 'failed' ? 'error' : null);
  switch (outcome) {
    case 'no_match':
      return '📵 No phone: FullEnrich searched and found none';
    case 'out_of_credits':
      return '📵 No phone: FullEnrich is out of credits';
    case 'timeout':
      return '📵 No phone: lookup timed out';
    case 'error':
      return '📵 No phone: lookup errored';
    case 'not_run': {
      const why = lookup && NOT_RUN_REASONS.has(lookup.reason) ? lookup.reason : null;
      const tail = why === 'not_hot_reply' ? ' (only runs for interested replies)'
        : why === 'spend_cap' ? ' (spend cap)'
          : why === 'unavailable' ? ' (not configured)'
            : '';
      return `📵 No phone: FullEnrich not run${tail}`;
    }
    case 'unknown':
      return '📵 No phone: none found (FullEnrich result not reported)';
    default:
      return '';
  }
}

module.exports = {
  phoneLookupFromHit,
  phoneLookupFromError,
  phoneMissingText,
  isTimeoutError,
  isCreditsError,
  OUTCOMES,
};
