'use strict';

/**
 * A follow-up card is skipped only when a person clicks Reject on that card.
 * A payload with no user, a bot user, a different message, or a click in the
 * first two seconds after the card was posted does not skip it.
 *
 * @returns {string|null} a block reason, or null when the click may skip
 */
function followUpSkipBlock(interaction, reply) {
  const user = interaction && interaction.user;
  if (!user || !user.id || user.is_bot) return 'no_person';
  if (interaction.type && interaction.type !== 'block_actions') return 'not_a_click';
  const msgTs = interaction.message && interaction.message.ts != null
    ? String(interaction.message.ts) : '';
  const rowTs = reply && reply.slack_message_ts != null ? String(reply.slack_message_ts) : '';
  const posted = /^\d+\.\d+$/.test(rowTs);
  if (posted && msgTs && msgTs !== rowTs) return 'different_message';
  const action = interaction.actions && interaction.actions[0];
  const actionTs = Number(
    action && action.action_ts != null ? action.action_ts : interaction.action_ts,
  );
  const origin = Number(msgTs || (posted ? rowTs : ''));
  if (Number.isFinite(actionTs) && Number.isFinite(origin) && actionTs >= origin && (actionTs - origin) < 2) {
    return 'too_soon';
  }
  return null;
}

module.exports = { followUpSkipBlock };
