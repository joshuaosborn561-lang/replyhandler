const { firstNameFromLead, nextBusinessDayLabel } = require('./classifier');

function fallbackReattempt({ leadName, platform, bookingLink, digestTimezone }) {
  const name = firstNameFromLead(leadName);
  // nextBusinessDayLabel already falls back when TZ is null/invalid
  const day = nextBusinessDayLabel(digestTimezone);
  // Times-first: suggest a day, offer to send booking link later — do not dump Calendly.
  void bookingLink;
  void platform;
  return (
    `Hey ${name}, thanks for getting back to me. Would ${day} mid-morning or early afternoon work ` +
    `for a quick call with our CEO? If neither works I can send a booking link.`
  );
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
