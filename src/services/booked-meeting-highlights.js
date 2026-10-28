'use strict';

/**
 * Structured highlights for the booked-meeting email: pain points, current setup, objections and
 * next step, read from the call transcript with the same Anthropic setup the rest of ReplyHandler
 * uses (ANTHROPIC_API_KEY, ANTHROPIC_REPLY_MODEL). Returns null on any problem (no key, no
 * transcript, bad JSON, empty result) so the email falls back to Allo's own short summary.
 */

const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_ITEMS = 4;
const MAX_ITEM_CHARS = 240;

const SYSTEM = `You write the notes a cold caller would hand a colleague after booking a meeting. You get a cold-call transcript and Allo's one-line summary. Output JSON only:

{"pain_points": string[], "current_setup": string|null, "objections": string[], "next_step": string|null}

Rules:
- Use only what is said in the transcript. If something was not discussed, use [] or null. Never guess or invent.
- The speaker labels USER and EXTERNAL are sometimes swapped. Decide who is the caller and who is the prospect from the content.
- Plain, professional sentences about the prospect (use their name when it is said). Clean up profanity and filler; keep the meaning.
- pain_points: problems or frustrations the prospect voiced (max 4, one short sentence each).
- current_setup: how they get work or handle this today (one or two sentences), or null.
- objections: hesitations or pushback the prospect raised (max 4), including past bad experiences.
- next_step: the agreed meeting: who, when (day and time as said), by phone or video, plus anything the prospect asked for. Null if nothing was agreed.
- Never include phone numbers or email addresses.
- The client we book meetings for is named in CLIENT. Always call it by that name. Callers sometimes use a different company name on the call line (CALL-LINE NAMES); never write those names, write the CLIENT name instead.`;

async function defaultLlm({ system, user }) {
  const { anthropicModel } = require('./anthropic-model');
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: anthropicModel(),
      max_tokens: 900,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic highlights failed (${res.status})`);
  const data = JSON.parse(text);
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function parseJsonLoose(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function cleanItem(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);
  // Contact details never go in the highlights, whatever the model returns.
  if (/@|\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/.test(s)) return '';
  return s;
}

function cleanList(v) {
  return (Array.isArray(v) ? v : []).map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS);
}

/** Validate model output into the shape the email renders; null when nothing usable. */
function normalizeHighlights(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const out = {
    painPoints: cleanList(parsed.pain_points),
    currentSetup: cleanItem(parsed.current_setup) || null,
    objections: cleanList(parsed.objections),
    nextStep: cleanItem(parsed.next_step) || null,
  };
  const any = out.painPoints.length || out.currentSetup || out.objections.length || out.nextStep;
  return any ? out : null;
}

async function generateHighlights({ transcript, summary, clientName = '', brands = [] }, { llm = defaultLlm } = {}) {
  const t = String(transcript || '').trim().slice(0, MAX_TRANSCRIPT_CHARS);
  if (!t) return null;
  try {
    const out = await llm({
      system: SYSTEM,
      user: `CLIENT: ${clientName || '(unknown)'}\nCALL-LINE NAMES: ${(brands || []).join(', ') || '(none)'}\n\nALLO SUMMARY:\n${String(summary || '(none)').slice(0, 1500)}\n\nTRANSCRIPT:\n"""\n${t}\n"""`,
    });
    return normalizeHighlights(parseJsonLoose(out));
  } catch (err) {
    console.warn('[BookedMeetingHighlights] failed, using the short summary', { err: err.message });
    return null;
  }
}

module.exports = { SYSTEM, normalizeHighlights, generateHighlights };
