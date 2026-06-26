const { firstNameFromLead, composeInboundDraft } = require('./classifier');

function fallbackReattempt({ leadName, bookingLink, lastInboundMessage }) {
  if (lastInboundMessage && String(lastInboundMessage).trim()) {
    return composeInboundDraft({
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
    return `Hey ${name}, thanks for getting back to me. We have a few options here — we want to make sure something works for you and that it's a good fit. If you're open to it, our CEO can walk through what might make sense on a quick call. Here's his calendar: ${link}`;
  }
  return `Hey ${name}, thanks for getting back to me. We have a few options for that — would a quick call with our CEO work?`;
}

async function draftReattemptToBook({
  leadName,
  bookingLink,
  lastInboundMessage,
}) {
  return fallbackReattempt({ leadName, bookingLink, lastInboundMessage });
}

module.exports = { draftReattemptToBook, fallbackReattempt };
