const { firstNameFromLead } = require('./classifier');

/**
 * FOLLOW_UP bumps.
 *
 * Same-day step 1 stays a short offer-first nudge (they just got times).
 * Next-day step 2+ says those times were taken, offers two new times, and
 * includes the booking link (except in-person / Vasco / Deep Roots callback).
 *
 * Every bump reframes the value prop from the original outbound ("still
 * interested in meeting for X"). Step 3+ never uses dashes — use "..." instead.
 * Never open with "thanks for getting back to me" (they didn't).
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
function bumpForOffer({
  name, offer, step, inPerson = false, callback = false, lastOutboundMessage = '',
} = {}) {
  const n = Number(step) || 1;
  const kind = offer.kind || 'generic';
  const x = valuePropPhrase(offer, lastOutboundMessage);
  const { DEEP_ROOTS_CALLER, DEEP_ROOTS_FROM_NUMBER } = require('../utils/meeting-modality');

  let text;

  if (callback) {
    if (n <= 1) {
      text = `Hey ${name}, still interested in ${x}? What time works best? ${DEEP_ROOTS_CALLER} will give you a call from ${DEEP_ROOTS_FROM_NUMBER}.`;
    } else if (n === 2) {
      text = `Hey ${name}, bumping this...still happy to have ${DEEP_ROOTS_CALLER} call about ${x}. What time works best? He'll call from ${DEEP_ROOTS_FROM_NUMBER}.`;
    } else {
      text = `Hey ${name}, last nudge from me...${DEEP_ROOTS_CALLER} can still call about ${x} whenever works. What time is best? He'll be at ${DEEP_ROOTS_FROM_NUMBER}.`;
    }
  } else if (inPerson) {
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

function slotLabelsFrom(slots, digestTimezone) {
  const labels = (slots || [])
    .map((s) => (s && typeof s === 'object' ? s.label : s))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (labels.length >= 2) return labels.slice(0, 2);
  const { nextTwoBusinessDayLabels } = require('./classifier');
  const [d1, d2] = nextTwoBusinessDayLabels(digestTimezone);
  return [labels[0] || `${d1} mid-morning`, labels[1] || `${d2} early afternoon`];
}

/**
 * Next-day (step 2+) refresh: those times were taken, here are two more,
 * plus the booking link (except in-person).
 */
function timesTakenBump({
  name,
  offer,
  step,
  inPerson = false,
  callback = false,
  lastOutboundMessage = '',
  slots,
  bookingLink,
  digestTimezone,
} = {}) {
  const n = Number(step) || 2;
  const x = valuePropPhrase(offer, lastOutboundMessage);
  if (callback) {
    return bumpForOffer({ name, offer, step: n, callback: true, lastOutboundMessage });
  }
  const [a, b] = slotLabelsFrom(slots, digestTimezone);
  const link = String(bookingLink || '').trim();

  let text;
  if (inPerson) {
    if (n === 2) {
      text = `Hey ${name}, those times got taken...does ${a} or ${b} work for me to stop by in person about ${x}?`;
    } else {
      text = `Hey ${name}, last nudge...those times got taken too. Does ${a} or ${b} work to stop by for ${x}?`;
    }
  } else {
    const linkBit = link ? ` Or grab a time here: ${link}` : '';
    if (n === 2) {
      text = `Hey ${name}, those times got taken...does ${a} or ${b} work instead to chat about ${x}?${linkBit}`;
    } else {
      text = `Hey ${name}, last nudge...those times got taken too. Does ${a} or ${b} work for ${x}?${linkBit}`;
    }
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
  slots,
  clientName,
} = {}) {
  void platform;
  const { prefersInPersonMeeting, prefersCallbackCall } = require('../utils/meeting-modality');
  const name = firstNameFromLead(leadName);
  const offer = detectOffer(lastOutboundMessage);
  const inPerson = prefersInPersonMeeting(voicePrompt);
  const callback = prefersCallbackCall(voicePrompt, clientName);
  const n = Number(step) || 1;
  if (callback) {
    return bumpForOffer({
      name,
      offer,
      step: n,
      callback: true,
      lastOutboundMessage,
    });
  }
  if (n >= 2) {
    return timesTakenBump({
      name,
      offer,
      step: n,
      inPerson,
      lastOutboundMessage,
      slots,
      bookingLink: inPerson ? '' : bookingLink,
      digestTimezone,
    });
  }
  return bumpForOffer({
    name,
    offer,
    step,
    inPerson,
    lastOutboundMessage,
  });
}

/**
 * Draft the next cadence bump. Never throws; always returns plain text
 * usable in Slack.
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
  slots,
  clientName,
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
    slots,
    clientName,
  });
}

module.exports = {
  draftReattemptToBook,
  fallbackReattempt,
  detectOffer,
  bumpForOffer,
  timesTakenBump,
  valuePropPhrase,
  scrubDashes,
};
