/**
 * What is allowed into the AI-reply Slack channels.
 *
 * Josh: only interested / bookable positives — no OOO noise, no not-interested
 * declines. Soft questions and meeting proposes still post.
 * Oct 27 2026: no "Unclassified reply" alerts either. A reply that is not a
 * real interest or question is recorded with a suppression reason and never
 * posted. See DECISIONS.md.
 *
 * Oct 30 2026 (Josh): the exception is LinkedIn. Every inbound HeyReach reply
 * for every client posts a card, whatever it was classified as: neutral
 * "thanks for connecting", job seekers, not interested, wrong person, cold
 * pitches. Pass `platform: 'heyreach'` and nothing is suppressed here. Email
 * is unchanged. `HEYREACH_POST_ALL_REPLIES=off` restores the old gate.
 *
 * Cold inbound pitches (no campaign, they wrote first) are hidden when Jev's
 * pitch_to_us_prob is at or above the threshold. Campaign threads where we
 * sent first are never hidden by the pitch filter.
 */

const {
  slackSuppressionReason: textSuppressionReason,
  looksLikeBounceNotice,
} = require('./smartlead-webhook-helpers');

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

/** True when every HeyReach (LinkedIn) reply posts a card. Default on. */
function heyreachPostsAllReplies() {
  return envFlag('HEYREACH_POST_ALL_REPLIES', true);
}

function isHeyreachPlatform(platform) {
  return String(platform || '').toLowerCase() === 'heyreach';
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
  classification, inboundMessage, isColdInbound, pitchToUsProb, platform,
} = {}) {
  // LinkedIn replies are never hidden. Josh wants to see every one.
  if (isHeyreachPlatform(platform) && heyreachPostsAllReplies()) return null;
  const byPitch = pitchInboundSuppressionReason({ isColdInbound, pitchToUsProb });
  if (byPitch) return byPitch;
  // A bounce / NDR / "Message blocked" is never a person, whatever label it got.
  if (looksLikeBounceNotice(inboundMessage)) return 'bounce';
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
  heyreachPostsAllReplies,
};
