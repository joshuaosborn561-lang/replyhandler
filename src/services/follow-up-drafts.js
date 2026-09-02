const { firstNameFromLead } = require('./classifier');

/**
 * Offer-first FOLLOW_UP bumps — mirror the human-edited nudges that actually
 * get approved (Scott / Max / Hilary / Dean), not the first-reply times-first
 * template. Never open with "thanks for getting back to me" (they didn't).
 *
 * Every bump reframes the value prop from the original outbound ("still
 * interested in meeting for X"). Step 3+ never uses dashes — use "..." instead.
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
  if (/\bfree campaign\b/.test(s) || /\b10k\s*leads?\b/.test(s) || (/\bon me\b/.test(s) && /\bcampaign\b/.test(s))) {
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

/**
 * Short "meeting for X" phrase pulled from the outbound value prop.
 * Used in every bump so we reframe what was originally offered.
 */
function valuePropPhrase(offer, lastOutboundMessage) {
  const kind = offer?.kind || 'generic';
  if (kind === 'tickets') {
    return offer.team ? `${offer.team} tickets` : 'the tickets';
  }
  if (kind === 'free_campaign') {
    return 'a free campaign to get you more business clients';
  }
  if (kind === 'video') {
    return 'the video I sent over';
  }
  if (kind === 'case_study') {
    return 'the case study';
  }

  const s = norm(lastOutboundMessage);
  if (!s) return 'this';

  if (/\bmore business clients\b/i.test(s)) return 'getting you more business clients';
  if (/\bwarranty\b/i.test(s)) return 'the warranty program';
  if (/\broof/i.test(s)) return 'roofing work';
  if (/\bstaff(ing)?\b/i.test(s)) return 'staffing help';
  if (/\bleads?\b/i.test(s) && /\b(campaign|outbound|email)\b/i.test(s)) {
    return 'getting you more leads';
  }
  if (/\b(cyber|msp|it support|managed (it|services))\b/i.test(s)) {
    return 'the IT / cyber conversation';
  }
  return 'this';
}

function ticketPhrase(offer) {
  if (offer.team) return `some ${offer.team} tix`;
  return 'some tickets';
}

/** Step 3+ copy: never em/en dashes or spaced hyphen dashes — use "...". */
function scrubDashes(text) {
  return String(text || '')
    .replace(/[—–]/g, '...')
    .replace(/\s+-\s+/g, '...')
    .replace(/\s*\.\.\.\s*/g, '...')
    .replace(/\.{4,}/g, '...')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Short bump copy keyed by offer + cadence step.
 * Step 1 ≈ same-day 3:30pm CT (or next day if inbound after 2pm CT);
 * later steps rotate phrasing so we don't spam the same line.
 * Every step reframes the original value prop.
 */
function bumpForOffer({ name, offer, step, inPerson = false, lastOutboundMessage = '' } = {}) {
  const n = Number(step) || 1;
  const kind = offer.kind || 'generic';
  const x = valuePropPhrase(offer, lastOutboundMessage);

  let text;

  if (inPerson) {
    if (n <= 1) {
      text = `Hey ${name}, still interested in me stopping by in person for ${x}?`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...still happy to stop by in person about ${x}. Any time next week free?`;
    } else {
      text = `Hey ${name}, last nudge from me...still glad to meet in person for ${x} if useful. Want me to swing by?`;
    }
  } else if (kind === 'tickets') {
    const tix = ticketPhrase(offer);
    if (n <= 1) {
      text = `Hey ${name}, still interested in meeting for ${x}? Happy to send you ${tix} just for the convo.`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...${tix} still on me if you want to chat about ${x}. Any time next week work?`;
    } else {
      text = `Hey ${name}, last nudge from me...still interested in meeting for ${x} (${tix} just for the convo). Want me to grab a time?`;
    }
  } else if (kind === 'free_campaign') {
    if (n <= 1) {
      text = `Hey ${name}, still interested in meeting for ${x}? I was offering a free campaign to 10k leads on me....time in the afternoon next week?`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...still interested in meeting for ${x}. Free campaign to 10k leads still on me. Afternoon next week?`;
    } else {
      text = `Hey ${name}, last nudge...still interested in meeting for ${x}. Free campaign to 10k leads still on me. Should I send times?`;
    }
  } else if (kind === 'video') {
    if (n <= 1) {
      text = `Hey ${name}, did that video come through? Still interested in meeting for ${x} if it looks relevant...`;
    } else if (n === 2) {
      text = `Hey ${name}, just checking the video landed...still interested in meeting for ${x}?`;
    } else {
      text = `Hey ${name}, last bump on the video...still interested in meeting for ${x} if useful.`;
    }
  } else if (kind === 'case_study') {
    if (n <= 1) {
      text = `Hey ${name}, still interested in meeting for ${x}? Happy to send the case study either way.`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...case study still handy, or we can meet on ${x}.`;
    } else {
      text = `Hey ${name}, last nudge...still interested in meeting for ${x}. Case study is yours either way.`;
    }
  } else if (n <= 1) {
    text = `Hey ${name}, still interested in meeting for ${x}?`;
  } else if (n === 2) {
    text = `Hey ${name}, bumping this...still interested in meeting for ${x}?`;
  } else {
    text = `Hey ${name}, last nudge from me...still interested in meeting for ${x} if useful.`;
  }

  return n >= 3 ? scrubDashes(text) : text;
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
    lastOutboundMessage,
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
  valuePropPhrase,
  scrubDashes,
};
