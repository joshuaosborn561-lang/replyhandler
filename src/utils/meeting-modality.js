/**
 * How a client prefers to meet after a positive reply.
 *
 * Driven by voice_prompt so one client (e.g. Vasco / Carlos) can offer
 * in-person stop-bys without changing the global default: two calendar
 * times plus the booking link.
 *
 * Deep Roots is a callback client: Tyler calls from 218-469-3457 and
 * we ask what time works — never a booking link or two calendar slots.
 * Pinned by client name so it holds even before voice_prompt is updated.
 */

const DEEP_ROOTS_CALLER = 'Tyler';
const DEEP_ROOTS_FROM_NUMBER = '218-469-3457';

function isDeepRootsClient(clientName) {
  return /deep\s*roots/i.test(String(clientName || ''));
}

function prefersCallbackCall(voicePrompt, clientName) {
  if (isDeepRootsClient(clientName)) return true;
  const s = String(voicePrompt || '').toLowerCase();
  if (!s.trim()) return false;
  if (/218[\s.\-]*469[\s.\-]*3457/.test(s)) return true;
  if (/\btyler will call\b/.test(s)) return true;
  if (/\bask (them )?what time works\b/.test(s) && /\b(call|tyler)\b/.test(s)) return true;
  return false;
}

function prefersInPersonMeeting(voicePrompt) {
  const s = String(voicePrompt || '').toLowerCase();
  if (!s.trim()) return false;
  if (/\bin[-\s]?person\b/.test(s)) return true;
  if (/\bstop by\b/.test(s)) return true;
  if (/\bmeet (them |prospects )?(at|on) (the )?dealership\b/.test(s)) return true;
  if (/\bnever suggest (a )?(zoom|phone|quick call)\b/.test(s)) return true;
  return false;
}

function resolveMeetingModality({ voicePrompt, clientName } = {}) {
  if (prefersCallbackCall(voicePrompt, clientName)) return 'callback';
  if (prefersInPersonMeeting(voicePrompt)) return 'in_person';
  return 'booking';
}

function shouldIncludeBookingLink(voicePrompt, clientName) {
  return resolveMeetingModality({ voicePrompt, clientName }) === 'booking';
}

/**
 * Plain-language CTA lines for first-touch / fallback drafts.
 * @returns {{ modality: 'in_person'|'callback'|'call', suggestLine: string, neitherLine: string, timeRule: string }}
 */
function meetingCta({ voicePrompt, clientName, day1, day2 } = {}) {
  const d1 = day1 || 'Tuesday';
  const d2 = day2 || 'Wednesday';
  const modality = resolveMeetingModality({ voicePrompt, clientName });
  if (modality === 'callback') {
    return {
      modality: 'callback',
      suggestLine:
        `What time works best for you? ${DEEP_ROOTS_CALLER} will give you a call from ${DEEP_ROOTS_FROM_NUMBER}.`,
      neitherLine: '',
      timeRule:
        `CALLBACK RULE: Ask what time works best for them. ${DEEP_ROOTS_CALLER} will call from ${DEEP_ROOTS_FROM_NUMBER}. ` +
        `Do NOT suggest two calendar slots, Zoom, Calendly, or any booking URL.`,
    };
  }
  if (modality === 'in_person') {
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
  DEEP_ROOTS_CALLER,
  DEEP_ROOTS_FROM_NUMBER,
  isDeepRootsClient,
  prefersCallbackCall,
  prefersInPersonMeeting,
  resolveMeetingModality,
  shouldIncludeBookingLink,
  meetingCta,
};
