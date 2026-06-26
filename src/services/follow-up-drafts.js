const { firstNameFromLead, composeInboundYesDraft } = require('./classifier');

function fallbackReattempt({ leadName, bookingLink, lastInboundMessage }) {
  if (lastInboundMessage && String(lastInboundMessage).trim()) {
    return composeInboundYesDraft({
      leadName,
      inboundMessage: lastInboundMessage,
      bookingLink,
      classification: 'INTERESTED',
    });
  }
  const name = firstNameFromLead(leadName);
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  if (link) {
    return `Hey ${name}, circling back — would love to connect. Here's our CEO's calendar: ${link}`;
  }
  return `Hey ${name}, circling back — would a quick call with our CEO work?`;
}

async function draftReattemptToBook({
  leadName,
  bookingLink,
  lastInboundMessage,
}) {
  return fallbackReattempt({ leadName, bookingLink, lastInboundMessage });
}

module.exports = { draftReattemptToBook, fallbackReattempt };
