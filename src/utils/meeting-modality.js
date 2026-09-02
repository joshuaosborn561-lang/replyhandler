/**
 * How a client prefers to meet after a positive reply.
 *
 * Driven by voice_prompt so one client (e.g. Vasco / Carlos) can offer
 * in-person stop-bys without changing the global times-first + booking-link
 * default used by everyone else.
 */

function prefersInPersonMeeting(voicePrompt) {
  const s = String(voicePrompt || '').toLowerCase();
  if (!s.trim()) return false;
  if (/\bin[-\s]?person\b/.test(s)) return true;
  if (/\bstop by\b/.test(s)) return true;
  if (/\bmeet (them |prospects )?(at|on) (the )?dealership\b/.test(s)) return true;
  if (/\bnever suggest (a )?(zoom|phone|quick call)\b/.test(s)) return true;
  return false;
}

/**
 * Plain-language CTA lines for first-touch / fallback drafts.
 * @returns {{ modality: 'in_person'|'call', suggestLine: string, neitherLine: string, timeRule: string }}
 */
function meetingCta({ voicePrompt, day1, day2 } = {}) {
  const d1 = day1 || 'Tuesday';
  const d2 = day2 || 'Wednesday';
  if (prefersInPersonMeeting(voicePrompt)) {
    return {
      modality: 'in_person',
      suggestLine:
        `Does ${d1} mid-morning or ${d2} early afternoon work for me to stop by in person?`,
      neitherLine: 'Happy to work around your schedule if neither works.',
      timeRule:
        `IN-PERSON RULE: Suggest two concrete options in the next few business days ` +
        `(e.g. ${d1} mid-morning or ${d2} early afternoon) for stopping by / meeting in person. ` +
        `Do NOT suggest Zoom, phone, "quick call", "call with our CEO", Calendly, or any booking URL.`,
    };
  }
  return {
    modality: 'call',
    suggestLine: null,
    neitherLine: null,
    timeRule: null,
  };
}

module.exports = {
  prefersInPersonMeeting,
  meetingCta,
};
