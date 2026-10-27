'use strict';

/**
 * Words on the follow-up sequence cards. Pure, no I/O.
 *
 * Call scripts are fixed so the caller never has to guess. Email cards are
 * short, plain, and carry no sign-off. Nothing here claims anything that is
 * not passed in: the offer and proof point arrive already validated against
 * the client's campaign copy.
 */

const OFFER_MISSING = '[offer not found in campaign copy - say what we emailed about in your own words]';

function firstNameOf(name) {
  const s = String(name || '').trim().split(/\s+/)[0] || '';
  const clean = s.replace(/[^\p{L}'-]/gu, '');
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function callerName(env = process.env) {
  return String(env.FOLLOWUP_CALLER_NAME || '').trim() || 'Gabe';
}

function offerText(offerLine) {
  const o = String(offerLine || '').trim();
  return o || OFFER_MISSING;
}

/** The line on every call card. */
function callScript({ firstName, callerName: caller, clientName, offerLine }) {
  const first = firstName || 'there';
  return `Hey ${first}, this is ${caller} with ${clientName}. We emailed you about ${offerText(offerLine)}. Did you still want to take a peek at that in the next couple days?`;
}

const CALL_KINDS = {
  call_day0: { label: 'Day 0 call', voicemail: 'day0' },
  call_day0_late: { label: 'Day 0 call, second try', voicemail: null },
  call_day1: { label: 'Day 1 call', voicemail: null },
  call_day3: { label: 'Day 3 call', voicemail: 'day3' },
  call_day6: { label: 'Day 6 final call', voicemail: 'day6' },
};

/** Voicemail script for a call step, or null when the call leaves none. */
function voicemailScript(kind, { firstName, callerName: caller, clientName, offerLine }) {
  const type = CALL_KINDS[kind]?.voicemail;
  if (!type) return null;
  const first = firstName || 'there';
  const offer = offerText(offerLine);
  if (type === 'day0') {
    return `Hey ${first}, it's ${caller} with ${clientName}, calling about ${offer}. I'll follow up by email with a couple of times that could work.`;
  }
  if (type === 'day3') {
    return `Hey ${first}, it's ${caller} with ${clientName}, calling about ${offer}. I'll send you one more email. If you're still interested, we can get this scheduled.`;
  }
  return `Hey ${first}, it's ${caller} with ${clientName}. I sent you an email about ${offer}. Take a look, and if it's still of interest just reply and we'll get it scheduled.`;
}

function timesSentence(slots, link) {
  const labels = (slots || []).map((s) => s.label).filter(Boolean);
  const linkLine = link ? ` If easier, grab a time here: ${link}` : '';
  if (labels.length >= 2) return `Does ${labels[0]} or ${labels[1]} work for a quick call?${linkLine}`;
  if (labels.length === 1) return `Does ${labels[0]} work for a quick call?${linkLine}`;
  if (link) return `Grab a time that works for a quick call here: ${link}`;
  return null;
}

/**
 * Email card bodies. Returns null when the card cannot be written yet
 * (needs live times and has none; needs a proof point and has none).
 */
function emailBody(kind, { firstName, slots, link, proofPoint, askForTimes = false }) {
  const first = firstName || 'there';
  const times = timesSentence(slots, link);
  const noTimesAsk = 'What time works for a quick call?';
  switch (kind) {
    case 'email_vm': {
      const body = times || (askForTimes ? noTimesAsk : null);
      if (!body) return null;
      return `Hey ${first}, just tried you and left you a voicemail.\n\n${body}`;
    }
    case 'email_day1': {
      if (!times && !askForTimes) return null;
      if (!times) return `Hey ${first}, those times got taken. What time works for a quick call?`;
      const labels = (slots || []).map((s) => s.label).filter(Boolean);
      if (labels.length >= 2) {
        return `Hey ${first}, those times got taken. Here are new times: ${labels[0]} or ${labels[1]}. Does either work?${link ? ` If easier, grab a time here: ${link}` : ''}`;
      }
      return `Hey ${first}, those times got taken. ${times}`;
    }
    case 'email_proof': {
      const p = String(proofPoint || '').trim();
      if (!p) return null;
      return `Hey ${first}, one more thing worth knowing: ${p}\n\nIf that's worth a quick look, just reply here and we'll get a time on the calendar.`;
    }
    case 'email_thoughts':
      return `Hey ${first}, any thoughts?`;
    case 'email_breakup':
      return `Hey ${first}, don't want to keep emailing you. Did you still want to meet about this, or have priorities changed?`;
    default:
      return null;
  }
}

const EMAIL_KINDS = {
  email_vm: 'Voicemail email',
  email_day1: 'Day 1 email: new times',
  email_proof: 'Day 3 email: proof point',
  email_thoughts: 'Day 3 email: any thoughts',
  email_breakup: 'Day 5 breakup email',
};

function stepLabel(kind) {
  return CALL_KINDS[kind]?.label || EMAIL_KINDS[kind] || kind;
}

// Ghosted-meeting steps (src/utils/ghosted-meeting-text.js) share the same card machinery.
const ghostText = require('./ghosted-meeting-text');
Object.assign(CALL_KINDS, ghostText.CALL_KINDS);
Object.assign(EMAIL_KINDS, ghostText.EMAIL_KINDS);

module.exports = {
  OFFER_MISSING,
  CALL_KINDS,
  EMAIL_KINDS,
  firstNameOf,
  callerName,
  callScript,
  voicemailScript,
  emailBody,
  timesSentence,
  stepLabel,
};
