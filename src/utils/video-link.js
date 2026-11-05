/**
 * Per-client video offer. The URL lives on clients.video_link (dashboard,
 * same place as the booking link). SalesGlider may also fall back to the
 * Railway env SALESGLIDER_VIDEO_LINK when that column is empty.
 * The classifier never owns the URL.
 */

const {
  looksLikeDeparture,
  looksLikeUnsubscribe,
  looksLikeNotInterested,
} = require('./smartlead-webhook-helpers');

const BLOCKED = new Set([
  'NOT_INTERESTED',
  'UNSUBSCRIBE',
  'REMOVE_ME',
  'WRONG_PERSON',
  'OOO',
  'OUT_OF_OFFICE',
  'AUTOMATED_NOTICE',
  'OBJECTION',
]);

function isSalesGliderClient(name) {
  return /^sales\s*glider\b/i.test(String(name || '').trim());
}

function normalizeVideoLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https:\/\//i.test(s)) return '';
  return s;
}

function resolveClientVideoLink(client, env = process.env) {
  const stored = normalizeVideoLink(client && client.video_link);
  if (stored) return stored;
  if (!isSalesGliderClient(client && client.name)) return '';
  return normalizeVideoLink(env && env.SALESGLIDER_VIDEO_LINK);
}

function mentionsVideo(text) {
  return /\bvideos?\b/i.test(String(text || ''));
}

function refusesVideo(text) {
  const s = String(text || '');
  if (looksLikeDeparture(s) || looksLikeUnsubscribe(s) || looksLikeNotInterested(s)) return true;
  return /\b(no|don'?t|do not|not interested|unsubscribe|remove me)\b/i.test(s)
    && mentionsVideo(s);
}

function explicitVideoAsk(text) {
  const s = String(text || '');
  if (!mentionsVideo(s) || refusesVideo(s)) return false;
  return /\b(send|share|watch|link|see|show|the video|your video|that video)\b/i.test(s);
}

function shortVideoAcceptance(text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 80 || refusesVideo(s)) return false;
  return /^(sure[,.]?(?:\s+send(?:\s+it|\s+the\s+video)?)?|send(?:\s+it|\s+the\s+video|\s+me\s+the\s+video)[.!]?|yes(?:\s+please)?[.!]?|yeah[.!]?|yep[.!]?|please(?:\s+send(?:\s+it|\s+the\s+video)?)?[.!]?)$/i.test(s);
}

function threadMentionsVideo(threadContext) {
  if (!threadContext) return false;
  const raw = typeof threadContext === 'string' ? threadContext : JSON.stringify(threadContext);
  return mentionsVideo(raw);
}

function videoOfferDraft(link) {
  return `Here you go: ${link}. Happy to jump on a quick call after if it's useful.`;
}

/**
 * The short video reply, or '' when this inbound should not get the link.
 * DQ, unsubscribe, and departure never get it. Other clients get it only
 * when their own video_link is set.
 */
function videoOfferDraftForReply({
  client,
  clientName,
  videoLink,
  inboundMessage,
  threadContext,
  classification,
  env = process.env,
} = {}) {
  const row = client || { name: clientName, video_link: videoLink };
  if (clientName && !row.name) row.name = clientName;
  if (videoLink && !row.video_link) row.video_link = videoLink;
  const link = resolveClientVideoLink(row, env);
  if (!link) return '';
  const klass = String(classification || '').toUpperCase();
  if (BLOCKED.has(klass)) return '';
  if (refusesVideo(inboundMessage)) return '';
  if (explicitVideoAsk(inboundMessage)) return videoOfferDraft(link);
  if (shortVideoAcceptance(inboundMessage) && threadMentionsVideo(threadContext)) {
    return videoOfferDraft(link);
  }
  return '';
}

module.exports = {
  isSalesGliderClient,
  normalizeVideoLink,
  resolveClientVideoLink,
  explicitVideoAsk,
  shortVideoAcceptance,
  videoOfferDraft,
  videoOfferDraftForReply,
};
