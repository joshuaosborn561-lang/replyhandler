const { firstNameFromLead } = require('./classifier');

function fallbackReattempt({ leadName, bookingLink }) {
  const name = firstNameFromLead(leadName);
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  if (link) {
    return `Hey ${name}, circling back — would love to connect. Grab a time with our CEO here: ${link}`;
  }
  return `Hey ${name}, circling back — would a quick call with our CEO work?`;
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
  return fallbackReattempt({ leadName, bookingLink });
}

module.exports = { draftReattemptToBook, fallbackReattempt };
