const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function fallbackReattempt({ leadName, platform, bookingLink }) {
  const name = (leadName || '').split(' ')[0] || 'there';
  const link = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';
  const base = `Hi ${name} — circling back on my last message. Still think 15 minutes could be worth it to see if this is a fit.`;
  if (link) return `${base} Here's a time if easier: ${link}`;
  return `${base} Open to a quick chat?`;
}

/**
 * Draft a short, warm follow-up that re-attempts to book a meeting.
 * Never throws; always returns plain text usable in Slack.
 */
async function draftReattemptToBook({ leadName, platform, voicePrompt, bookingLink, lastInboundMessage, lastOutboundMessage }) {
  const booking = bookingLink && String(bookingLink).trim().startsWith('http')
    ? String(bookingLink).trim()
    : '';

  const system = `You write a short, warm B2B sales follow-up that re-attempts to book a 15–20 minute meeting.
Output PLAIN TEXT only — no JSON, no markdown, no "Follow-up:" prefix. No quotes around the message.
Length: 2-4 short sentences, fewer is better.
Tone: friendly, warm, concise, human, non-pushy.
- Never begin with "Great question" or similar filler.
- Avoid excessive exclamation marks.
- Reference it's a follow-up naturally (not aggressively).
- If a booking URL is supplied, include it once verbatim: ${booking || '(none)'}
- Propose a short call as the ask.

CLIENT VOICE:
${voicePrompt || 'Professional, direct, practitioner-level. No fluff.'}
PLATFORM: ${platform}
`;

  const user =
`Lead name: ${leadName || 'there'}

Last outbound message from us (if any):
${lastOutboundMessage || '(none)'}

Last message from prospect (if any):
${lastInboundMessage || '(none — they never replied)'}

Write the follow-up message.`;

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: system,
      generationConfig: {
        maxOutputTokens: 400,
        temperature: 0.4,
        responseMimeType: 'text/plain',
      },
    });
    const r = await model.generateContent(user);
    let text = (r.response.text() || '').trim();
    text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
    text = text.replace(/^(follow[- ]?up|draft|message|reply)\s*:\s*/i, '').trim();
    if (!text) return fallbackReattempt({ leadName, platform, bookingLink });
    if (booking && !text.includes(booking)) {
      text = `${text.trim()}\n\n${booking}`;
    }
    return text;
  } catch (err) {
    console.error('[FollowUpDraft] Gemini failed', { err: err.message });
    return fallbackReattempt({ leadName, platform, bookingLink });
  }
}

module.exports = { draftReattemptToBook, fallbackReattempt };
