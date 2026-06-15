const { firstNameFromLead, nextBusinessDayLabel } = require('./classifier');

function fallbackReattempt({ leadName, platform, bookingLink, digestTimezone }) {
  const name = firstNameFromLead(leadName);
  const day = nextBusinessDayLabel(digestTimezone);
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  if (link) {
    return `Hey ${name}, thanks for getting back to me. Here's our CEO's booking link — would ${day} work? ${link}`;
  }
  return `Hey ${name}, thanks for getting back to me. Would ${day} work for a quick call with our CEO?`;
}

/**
 * Draft a short, warm follow-up that re-attempts to book a meeting.
 * Never throws; always returns plain text usable in Slack.
 */
async function draftReattemptToBook({
  leadName,
  platform,
  voicePrompt,
  bookingLink,
  lastInboundMessage,
  lastOutboundMessage,
  digestTimezone,
}) {
  // Intentionally deterministic: users want a consistent, simple re-attempt.
  // (No LLM call; avoids delays/costs and keeps copy tight.)
  return fallbackReattempt({ leadName, platform, bookingLink, digestTimezone });
}

module.exports = { draftReattemptToBook, fallbackReattempt };
