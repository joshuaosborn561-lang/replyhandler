function fallbackReattempt({ leadName, platform, bookingLink }) {
  const name = (leadName || '').split(' ')[0] || 'there';
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  const base = `Hi ${name} — quick follow-up on my last note.`;
  if (link) {
    return `${base} I have a couple slots today and tomorrow — if easier, grab a time here: ${link}`;
  }
  return `${base} I have a couple slots today and tomorrow — open to a quick chat?`;
}

/**
 * Draft a short, warm follow-up that re-attempts to book a meeting.
 * Never throws; always returns plain text usable in Slack.
 */
async function draftReattemptToBook({ leadName, platform, voicePrompt, bookingLink, lastInboundMessage, lastOutboundMessage }) {
  // Intentionally deterministic: users want a consistent, simple re-attempt.
  // (No LLM call; avoids delays/costs and keeps copy tight.)
  return fallbackReattempt({ leadName, platform, bookingLink });
}

module.exports = { draftReattemptToBook, fallbackReattempt };
