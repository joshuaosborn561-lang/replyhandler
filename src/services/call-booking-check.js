const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../db');
const allo = require('./allo');
const drive = require('./google-drive');
const { looksLikeAlreadyBooked, looksLikeProposedTime } = require('../utils/booking-signals');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * "Did a call with this prospect end with a meeting on the books?"
 *
 * Two sources, both feeding the same judgement:
 *   - Allo transcribes its own calls, so /calls returns transcript + summary.
 *   - Cube ACR drops raw audio in Drive, so those are transcribed with Gemini.
 */

/** Deterministic fallback — also the guard when Gemini is unavailable. */
function keywordSaysBooked(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return looksLikeAlreadyBooked(s) || looksLikeProposedTime(s);
}

/**
 * Ask Gemini whether the call ended with a scheduled meeting. Returns null on
 * any failure so the caller can fall back rather than guess.
 */
async function geminiSaysBooked(transcript) {
  if (!process.env.GEMINI_API_KEY) return null;
  const text = String(transcript || '').trim();
  if (!text) return null;

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction:
        'You read a sales call transcript and decide one thing: did the call end with a ' +
        'meeting, demo or call actually scheduled with the prospect — a specific agreed ' +
        'time, or a confirmed booking?\n' +
        'Answer BOOKED only if a time was agreed or the prospect confirmed they booked.\n' +
        'Answer NOT_BOOKED for interest without a time, "send me something", voicemail, ' +
        'no answer, or a callback promised but not scheduled.\n' +
        'Reply with exactly one word: BOOKED or NOT_BOOKED.',
    });
    const res = await model.generateContent(text.slice(0, 30000));
    const out = String(res?.response?.text() || '').trim().toUpperCase();
    if (out.includes('NOT_BOOKED')) return false;
    if (out.includes('BOOKED')) return true;
    return null;
  } catch (err) {
    console.warn('[CallBooking] Gemini judgement failed', { err: err.message });
    return null;
  }
}

/** Combined judgement over one transcript. */
async function transcriptSaysBooked(transcript) {
  const verdict = await geminiSaysBooked(transcript);
  if (verdict !== null) return verdict;
  return keywordSaysBooked(transcript);
}

/** Transcribe a call recording. Returns '' when unavailable — never throws. */
async function transcribeAudio(buffer, mimeType) {
  if (!process.env.GEMINI_API_KEY) return '';
  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction:
        'Transcribe this sales phone call. Label each turn "Us:" or "Prospect:". ' +
        'Transcript only, no commentary. If there is no intelligible speech, reply exactly: NO_SPEECH',
    });
    const res = await model.generateContent([
      { inlineData: { data: buffer.toString('base64'), mimeType: mimeType || 'audio/mpeg' } },
      { text: 'Transcribe the call.' },
    ]);
    const text = String(res?.response?.text() || '').trim();
    return /^NO_SPEECH$/i.test(text) ? '' : text;
  } catch (err) {
    console.warn('[CallBooking] Transcription failed', { err: err.message });
    return '';
  }
}

/** Cube ACR recordings in Drive, transcribed then judged. */
async function driveCallSaysBooked(phone, since) {
  if (!drive.isConfigured()) return null;

  let files = [];
  try {
    files = await drive.findRecordingsForPhone(phone, { since });
  } catch (err) {
    console.warn('[CallBooking] Drive lookup failed — treating as not booked', { err: err.message });
    return null;
  }
  if (!files.length) return null;

  for (const file of files.slice(0, 3)) {
    try {
      const dl = await drive.downloadFile(file.id);
      if (!dl) continue;
      const text = await transcribeAudio(dl.buffer, dl.mimeType);
      if (!text.trim()) continue;
      if (await transcriptSaysBooked(text)) {
        console.log('[CallBooking] Cell recording shows a booking', { file: file.name, at: file.modifiedTime });
        return 'call_transcript_booked';
      }
    } catch (err) {
      console.warn('[CallBooking] Recording check failed', { file: file.name, err: err.message });
    }
  }
  return null;
}

/** The prospect's phone as stored by the enrichment waterfall. */
async function prospectPhone(clientId, { leadEmail, leadId, platform }) {
  const email = String(leadEmail || '').trim().toLowerCase();
  const lead = leadId != null ? String(leadId) : '';
  if (!email && !lead) return null;

  const { rows } = await db.query(
    `SELECT lead_phone
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND lead_phone IS NOT NULL
        AND (
          ($3::text <> '' AND lower(COALESCE(lead_email, '')) = $3)
          OR ($4::text <> '' AND COALESCE(lead_id, '') = $4)
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientId, platform, email, lead]
  );
  return rows[0]?.lead_phone || null;
}

/**
 * Did we call this prospect since `since`, and did that call book a meeting?
 * @returns {Promise<string|null>} skip reason, or null
 */
async function callSaysBooked(clientId, { platform, leadEmail, leadId, since }) {
  if (!allo.isConfigured() && !drive.isConfigured()) return null;

  const phone = await prospectPhone(clientId, { leadEmail, leadId, platform });
  if (!phone) return null;

  const fromDrive = await driveCallSaysBooked(phone, since);
  if (fromDrive) return fromDrive;

  if (!allo.isConfigured()) return null;

  let calls = [];
  try {
    calls = await allo.searchCalls(phone);
  } catch (err) {
    // Never let an Allo outage suppress a follow-up.
    console.warn('[CallBooking] Allo lookup failed — treating as not booked', { err: err.message });
    return null;
  }

  const cutoff = since instanceof Date ? since.getTime() : new Date(since || 0).getTime();
  const recent = calls.filter((c) => {
    const t = new Date(c?.start_date || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  if (!recent.length) return null;

  for (const call of recent) {
    const text = allo.transcriptText(call);
    if (!text.trim()) continue;
    if (await transcriptSaysBooked(text)) {
      console.log('[CallBooking] Call transcript shows a booking', {
        clientId, callId: call.id, type: call.type, at: call.start_date,
      });
      return 'call_transcript_booked';
    }
  }
  return null;
}

module.exports = {
  callSaysBooked,
  driveCallSaysBooked,
  transcribeAudio,
  transcriptSaysBooked,
  keywordSaysBooked,
  prospectPhone,
};
