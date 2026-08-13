/**
 * What is allowed into the AI-reply Slack channels.
 *
 * Josh: only interested / bookable positives — no OOO noise, no not-interested
 * declines. Soft questions and meeting proposes still post.
 */

const { slackSuppressionReason: textSuppressionReason } = require('./smartlead-webhook-helpers');

/** Classifications that may post a Slack card (draft or alert). */
const SLACK_CHANNEL_CLASSIFICATIONS = new Set([
  'INTERESTED',
  'MEETING_PROPOSED',
  'QUESTION',
]);

/**
 * @returns {string|null} reason to keep this reply out of Slack, else null
 */
function classificationSlackSuppressionReason(classification) {
  const c = String(classification || '').toUpperCase();
  if (!c) return null;
  if (SLACK_CHANNEL_CLASSIFICATIONS.has(c)) return null;
  if (c === 'OOO' || c === 'OUT_OF_OFFICE') return 'ooo';
  if (c === 'NOT_INTERESTED') return 'not_interested';
  if (c === 'REMOVE_ME') return 'unsubscribe';
  if (c === 'WRONG_PERSON') return 'wrong_person';
  if (c === 'COMPETITOR') return 'competitor';
  if (c === 'FOLLOW_UP') return null; // cadence cards are intentional
  // OTHER / OBJECTION / unknown — channel noise; interested-only policy
  return 'not_interested_channel';
}

/**
 * Final gate used after classification (and for text-only early checks).
 * @returns {string|null}
 */
function slackChannelSuppressionReason({ classification, inboundMessage } = {}) {
  const byClass = classificationSlackSuppressionReason(classification);
  if (byClass) return byClass;
  // Text heuristics still catch OOO / unsubscribe / wrong-person that
  // mis-classified as INTERESTED/QUESTION.
  return textSuppressionReason(inboundMessage) || null;
}

function shouldPostToSlackChannel(opts) {
  return !slackChannelSuppressionReason(opts);
}

module.exports = {
  SLACK_CHANNEL_CLASSIFICATIONS,
  classificationSlackSuppressionReason,
  slackChannelSuppressionReason,
  shouldPostToSlackChannel,
};
