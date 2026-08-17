const { firstNameFromLead } = require('./classifier');

/**
 * Offer-first FOLLOW_UP bumps — mirror the human-edited nudges that actually
 * get approved (Scott / Max / Hilary / Dean), not the first-reply times-first
 * template. Never open with "thanks for getting back to me" (they didn't).
 */

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** What offer did our last send lean on? */
function detectOffer(lastOutboundMessage) {
  const s = norm(lastOutboundMessage).toLowerCase();
  if (!s) return { kind: 'generic' };

  if (/\b(ticket|tix)\b/.test(s) || /\b(marlins|rangers|astros|yankees|mets|cubs|dodgers|padres|twins|guardians|orioles|rays|royals|tigers|angels|mariners|nationals|phillies|braves|cardinals|brewers|pirates|reds|rockies|diamondbacks|giants|blue jays|white sox|red sox)\b/.test(s)) {
    const team = (s.match(/\b(marlins|rangers|astros|yankees|mets|cubs|dodgers|padres|twins|guardians|orioles|rays|royals|tigers|angels|mariners|nationals|phillies|braves|cardinals|brewers|pirates|reds|rockies|diamondbacks|giants)\b/) || [])[1];
    return { kind: 'tickets', team: team ? team.charAt(0).toUpperCase() + team.slice(1) : null };
  }
  if (/\bfree campaign\b/.test(s) || /\b10k\s*leads?\b/.test(s) || /\bon me\b/.test(s) && /\bcampaign\b/.test(s)) {
    return { kind: 'free_campaign' };
  }
  if (/\b(video|loom)\b/.test(s)) {
    return { kind: 'video' };
  }
  if (/\bcase study\b/.test(s)) {
    return { kind: 'case_study' };
  }
  return { kind: 'generic' };
}

function ticketPhrase(offer) {
  if (offer.team) return `some ${offer.team} tix`;
  return 'some tickets';
}

/**
 * Short bump copy keyed by offer + cadence step.
 * Step 1 ≈ 2h, later steps rotate phrasing so we don't spam the same line.
 */
function bumpForOffer({ name, offer, step, inPerson = false }) {
  const n = Number(step) || 1;
  const kind = offer.kind || 'generic';

  if (inPerson) {
    if (n <= 1) {
      return `Hey ${name}, still interested in me stopping by in person to see if this is relevant?`;
    }
    if (n === 2) {
      return `Hey ${name}, bumping this — happy to stop by whenever works on your end. Any time next week free?`;
    }
    return `Hey ${name}, last nudge from me — still glad to meet in person if useful. Want me to swing by?`;
  }

  if (kind === 'tickets') {
    const tix = ticketPhrase(offer);
    if (n <= 1) {
      return `Hey ${name}, still interested in a meeting or a quick video to see if this is relevant? Happy to send you ${tix} just for the convo.`;
    }
    if (n === 2) {
      return `Hey ${name}, bumping this — ${tix} still on me if you want to chat. Any time next week work?`;
    }
    return `Hey ${name}, last nudge from me — offer still stands (${tix} just for the meeting). Want me to grab a time?`;
  }

  if (kind === 'free_campaign') {
    if (n <= 1) {
      return `Hey ${name}, still wanting to meet on getting you more business clients? I was offering to give you a free campaign to 10k leads on me....time in the afternoon next week?`;
    }
    if (n === 2) {
      return `Hey ${name}, bumping the free campaign offer — still happy to run 10k leads on me if we can grab a quick call. Afternoon next week?`;
    }
    return `Hey ${name}, last nudge — free campaign to 10k leads still on me if you want to meet. Should I send times?`;
  }

  if (kind === 'video') {
    if (n <= 1) {
      return `Hey ${name}, did that video come through? Seeing if this is relevant to you...`;
    }
    if (n === 2) {
      return `Hey ${name}, just checking the video landed — still interested in a quick chat if it looks relevant?`;
    }
    return `Hey ${name}, last bump on the video — happy to jump on a quick call if useful.`;
  }

  if (kind === 'case_study') {
    if (n <= 1) {
      return `Hey ${name}, still interested in a meeting or a quick video to see if this is relevant? Happy to send the case study either way.`;
    }
    return `Hey ${name}, bumping this — case study still handy if useful, or we can jump on a quick call.`;
  }

  // Generic soft bump (no times-first / no "thanks for getting back")
  if (n <= 1) {
    return `Hey ${name}, still interested in a meeting or a quick video to see if this is relevant?`;
  }
  if (n === 2) {
    return `Hey ${name}, bumping this — still want to see if a quick call makes sense?`;
  }
  return `Hey ${name}, last nudge from me — happy to jump on a quick call if useful.`;
}

function fallbackReattempt({
  leadName,
  platform,
  bookingLink,
  digestTimezone,
  voicePrompt,
  lastOutboundMessage,
  step,
}) {
  void platform;
  void bookingLink;
  void digestTimezone;
  const { prefersInPersonMeeting } = require('../utils/meeting-modality');
  const name = firstNameFromLead(leadName);
  const offer = detectOffer(lastOutboundMessage);
  return bumpForOffer({
    name,
    offer,
    step,
    inPerson: prefersInPersonMeeting(voicePrompt),
  });
}

/**
 * Draft a short, offer-first follow-up bump (not a copy of the first reply).
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
  step,
}) {
  void lastInboundMessage;
  return fallbackReattempt({
    leadName,
    platform,
    bookingLink,
    digestTimezone,
    voicePrompt,
    lastOutboundMessage,
    step,
  });
}

module.exports = {
  draftReattemptToBook,
  fallbackReattempt,
  detectOffer,
  bumpForOffer,
};
