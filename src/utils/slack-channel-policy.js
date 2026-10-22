/**
 * What is allowed into the AI-reply Slack channels.
 *
 * Josh: only interested / bookable positives — no OOO noise, no not-interested
 * declines. Soft questions and meeting proposes still post.
 *
 * Cold inbound pitches (no campaign, they wrote first) are hidden when Jev's
 * pitch_to_us_prob is at or above the threshold. Campaign threads where we
 * sent first are never hidden by the pitch filter.
 */

const { slackSuppressionReason: textSuppressionReason } = require('./smartlead-webhook-helpers');

/** Classifications that may post a Slack card (draft or alert). */
const SLACK_CHANNEL_CLASSIFICATIONS = new Set([
  'INTERESTED',
  'MEETING_PROPOSED',
  'QUESTION',
]);

const PITCH_INBOUND_THRESHOLD = 0.8;
const PITCH_INBOUND_REASON = 'pitch_inbound';

function envFlag(name, defaultValue = true) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function suppressPitchesEnabled() {
  return envFlag('SUPPRESS_PITCHES', true);
}

/**
 * @returns {string|null} reason to keep this reply out of Slack, else null
 */
function classificationSlackSuppressionReason(classification) {
  const c = String(classification || '').toUpperCase();
  if (!c) return null;
  if (SLACK_CHANNEL_CLASSIFICATIONS.has(c)) return null;
  if (c === 'OOO' || c === 'OUT_OF_OFFICE') return 'ooo';
  if (c === 'AUTOMATED_NOTICE') return 'automated_notice';
  if (c === 'NOT_INTERESTED') return 'not_interested';
  if (c === 'REMOVE_ME') return 'unsubscribe';
  if (c === 'WRONG_PERSON') return 'wrong_person';
  if (c === 'COMPETITOR') return 'competitor';
  if (c === 'FOLLOW_UP') return null; // cadence cards are intentional
  // OTHER / OBJECTION / unknown — channel noise; interested-only policy
  return 'not_interested_channel';
}

function pitchInboundSuppressionReason({ isColdInbound, pitchToUsProb } = {}) {
  if (!suppressPitchesEnabled()) return null;
  if (!isColdInbound) return null;
  const p = Number(pitchToUsProb);
  if (!Number.isFinite(p) || p < PITCH_INBOUND_THRESHOLD) return null;
  return PITCH_INBOUND_REASON;
}

/**
 * Final gate used after classification (and for text-only early checks).
 * @returns {string|null}
 */
function slackChannelSuppressionReason({
  classification, inboundMessage, isColdInbound, pitchToUsProb,
} = {}) {
  const byPitch = pitchInboundSuppressionReason({ isColdInbound, pitchToUsProb });
  if (byPitch) return byPitch;
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
  PITCH_INBOUND_THRESHOLD,
  PITCH_INBOUND_REASON,
  classificationSlackSuppressionReason,
  pitchInboundSuppressionReason,
  slackChannelSuppressionReason,
  shouldPostToSlackChannel,
  suppressPitchesEnabled,
};
