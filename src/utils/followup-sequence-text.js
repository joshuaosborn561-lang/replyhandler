'use strict';

/**
 * Words on the follow-up sequence cards. Pure, no I/O.
 *
 * Call scripts are fixed so the caller never has to guess. Email cards are
 * short, plain, and carry no sign-off. Nothing here claims anything that is
 * not passed in: the offer and proof point arrive already validated against
 * the client's campaign copy.
 */

// Kept for old imports only. A missing offer is now omitted from the scripts, never shown.
const OFFER_MISSING = '';

function firstNameOf(name) {
  const s = String(name || '').trim().split(/\s+/)[0] || '';
  const clean = s.replace(/[^\p{L}'-]/gu, '');
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function cleanCallerName(name) {
  return String(name || '').replace(/[<>|&*_`~\n\r]/g, '').trim().slice(0, 40);
}

/**
 * Configured callers: FOLLOWUP_CALLERS maps Slack user id to display name, as
 * JSON ({"U1":"Gabe","U2":"Cayden"}) or a list ("U1:Gabe,U2:Cayden"). Without it the
 * legacy single caller (FOLLOWUP_CALLER_NAME / FOLLOWUP_CALLER_SLACK_ID, default
 * Gabe) is used. Returns [{ id, name }].
 */
function parseCallers(env = process.env) {
  const raw = String(env.FOLLOWUP_CALLERS || '').trim();
  const out = [];
  const add = (id, name) => {
    const cleanId = String(id || '').trim();
    const cleanName = cleanCallerName(name);
    if (!cleanName || !/^[UW][A-Z0-9]{2,}$/.test(cleanId)) return;
    if (out.some((c) => c.id === cleanId)) return;
    out.push({ id: cleanId, name: cleanName });
  };
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && !Array.isArray(j)) for (const [id, name] of Object.entries(j)) add(id, name);
    } catch {
      for (const part of raw.split(',')) {
        const i = part.indexOf(':');
        if (i > 0) add(part.slice(0, i), part.slice(i + 1));
      }
    }
    if (out.length) return out;
  }
  const name = cleanCallerName(env.FOLLOWUP_CALLER_NAME) || 'Gabe';
  const id = String(env.FOLLOWUP_CALLER_SLACK_ID || '').trim();
  return [{ id: /^[UW][A-Z0-9]{2,}$/.test(id) ? id : null, name }];
}

/** Scripts say this literally so whoever calls says their own name. */
const CALLER_PLACEHOLDER = '(name)';

function callerName() {
  return CALLER_PLACEHOLDER;
}

function offerText(offerLine) {
  return String(offerLine || '').trim().replace(/[.!\s]+$/, '');
}

/** "We emailed you about X." or, with no known offer, "We emailed you recently." */
function emailedYouSentence(offerLine) {
  const o = offerText(offerLine);
  return o ? `We emailed you about ${o}.` : 'We emailed you recently.';
}

/** The line on every call card. */
function callScript({ firstName, callerName: caller, clientName, offerLine }) {
  const first = firstName || 'there';
  return `Hey ${first}, this is ${caller} with ${clientName}. ${emailedYouSentence(offerLine)} Did you still want to take a peek at that in the next couple days?`;
}

const CALL_KINDS = {
  call_day0: { label: 'Day 0 call', voicemail: 'day0' },
  call_day0_late: { label: 'Day 0 call, second try', voicemail: null },
  call_day1: { label: 'Day 1 call', voicemail: null },
  call_day3: { label: 'Day 3 call', voicemail: 'day3' },
  call_day6: { label: 'Day 6 final call', voicemail: 'day6' },
};

/** Voicemail script for a call step, or null when the call leaves none. */
function voicemailScript(kind, { firstName, callerName: caller, clientName, offerLine, proofPoint }) {
  const type = CALL_KINDS[kind]?.voicemail;
  if (!type) return null;
  const first = firstName || 'there';
  const offer = offerText(offerLine);
  const calling = offer ? `calling about ${offer}` : 'following up on my email';
  if (type === 'day0') {
    return `Hey ${first}, it's ${caller} with ${clientName}, ${calling}. I'll follow up by email with a couple of times that could work.`;
  }
  if (type === 'day3') {
    return `Hey ${first}, it's ${caller} with ${clientName}, ${calling}. I'll send you one more email. If you're still interested, we can get this scheduled.`;
  }
  // Day 6: breakup voicemail. Recaps the offer (when known) and, only when real proof exists, the proof.
  const proof = String(proofPoint || '').trim().replace(/[.!\s]+$/, '');
  const proofSentence = proof ? ` ${proof}.` : '';
  const recap = offer ? ` Quick recap: ${offer}.` : '';
  return `Hey ${first}, ${caller} with ${clientName}. Last call from me.${recap}${proofSentence} If it's still a priority, reply to my email and we'll get it scheduled; if not, no worries.`;
}

/**
 * One merged script for a call card. The call and the voicemail share the same
 * opening line, so it is said once:
 *   opening       both: who is calling and what we emailed about
 *   ifAnswer      only when they pick up
 *   ifVoicemail   what to add when it goes to voicemail (null: no voicemail on this call)
 */
function callCardScript(kind, { firstName, callerName: caller, clientName, offerLine, proofPoint }) {
  const first = firstName || 'there';
  const opening = `Hey ${first}, this is ${caller} with ${clientName}. ${emailedYouSentence(offerLine)}`;
  const type = CALL_KINDS[kind]?.voicemail;
  let ifVoicemail = null;
  if (type === 'day0') {
    ifVoicemail = "I'll follow up by email with a couple of times that could work.";
  } else if (type === 'day3') {
    ifVoicemail = "I'll send you one more email. If you're still interested, we can get this scheduled.";
  } else if (type === 'day6') {
    const proof = String(proofPoint || '').trim().replace(/[.!\s]+$/, '');
    ifVoicemail = `Last call from me.${proof ? ` ${proof}.` : ''} If it's still a priority, reply to my email and we'll get it scheduled; if not, no worries.`;
  }
  return {
    opening,
    ifAnswer: 'Did you still want to take a peek at that in the next couple days?',
    ifVoicemail,
  };
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
      return `Hey ${first}, just tried you, left you a voicemail. Still want to take a peek at this?\n\n${body}`;
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

/** Callback steps are call_callback_1, call_callback_2, ... (one per "call back later"). */
const CALLBACK_PREFIX = 'call_callback_';

function isCallKind(kind) {
  return Object.prototype.hasOwnProperty.call(CALL_KINDS, kind) || String(kind || '').startsWith(CALLBACK_PREFIX);
}

function stepLabel(kind) {
  if (String(kind || '').startsWith(CALLBACK_PREFIX)) return 'Callback call';
  return CALL_KINDS[kind]?.label || EMAIL_KINDS[kind] || kind;
}

// Ghosted-meeting steps (src/utils/ghosted-meeting-text.js) share the same card machinery.
const ghostText = require('./ghosted-meeting-text');
Object.assign(CALL_KINDS, ghostText.CALL_KINDS);
Object.assign(EMAIL_KINDS, ghostText.EMAIL_KINDS);

module.exports = {
  OFFER_MISSING,
  CALL_KINDS,
  CALLBACK_PREFIX,
  isCallKind,
  EMAIL_KINDS,
  firstNameOf,
  callerName,
  parseCallers,
  CALLER_PLACEHOLDER,
  callScript,
  voicemailScript,
  callCardScript,
  emailedYouSentence,
  emailBody,
  timesSentence,
  stepLabel,
};
