const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

// User requirement: draft a reply for everything except out-of-office.
const DRAFT_CLASSIFICATIONS = CLASSIFICATIONS.filter((c) => c !== 'OUT_OF_OFFICE');

function extractFirstJsonObject(text) {
  if (!text) return null;
  const s = String(text);
  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * When Gemini hits max tokens mid-"draft", JSON is invalid and balanced-brace extraction returns null.
 * Pull classification + partial draft from the raw text so Slack still gets something to edit.
 */
function salvageClassifierFields(text) {
  const s = String(text || '');
  const classificationMatch = s.match(/"classification"\s*:\s*"([^"]+)"/);
  const classification = classificationMatch ? classificationMatch[1] : null;

  let draft = null;
  const key = '"draft"';
  const idx = s.indexOf(key);
  if (idx !== -1) {
    const afterKey = s.slice(idx + key.length);
    const colonQuote = afterKey.match(/^\s*:\s*"/);
    if (colonQuote) {
      const start = idx + key.length + colonQuote[0].length;
      let out = '';
      let escape = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (escape) {
          if (ch === 'n') out += '\n';
          else if (ch === 'r') out += '\r';
          else if (ch === 't') out += '\t';
          else out += ch;
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') break;
        out += ch;
      }
      draft = out.trim() || null;
    } else {
      const nullDraft = afterKey.match(/^\s*:\s*null\b/);
      if (nullDraft) draft = null;
    }
  }

  let proposed_time = null;
  const pt = s.match(/"proposed_time"\s*:\s*(null|"([^"]*)")/);
  if (pt) {
    proposed_time = pt[1] === 'null' ? null : (pt[2] !== undefined ? pt[2] : null);
  }

  let reasoning = null;
  const r1 = s.match(/"reasoning"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (r1) reasoning = r1[1].replace(/\\"/g, '"');
  else {
    const r2 = s.match(/"reasoning"\s*:\s*"([\s\S]*)$/);
    if (r2) reasoning = r2[1].replace(/\\"/g, '"');
  }

  if (!classification && !draft) return null;

  return {
    classification: classification || 'OTHER',
    draft,
    proposed_time: proposed_time !== undefined ? proposed_time : null,
    reasoning: reasoning || 'Partial parse (Gemini output was truncated).',
  };
}

function tryParseClassifierResult(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const extracted = extractFirstJsonObject(text);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch {
      /* fall through */
    }
  }
  const salvaged = salvageClassifierFields(text);
  if (salvaged && (salvaged.draft != null || salvaged.classification)) {
    return salvaged;
  }
  return null;
}

function makeFallbackDraft({ inboundMessage, bookingLink }) {
  const booking = bookingLink || '';
  const msg = String(inboundMessage || '').trim();
  const short = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
  return [
    `Thanks for getting back to me — appreciate it.`,
    short ? `On your note: “${short}”` : null,
    `Happy to share details and answer anything specific — what’s the main thing you’re trying to confirm?`,
    booking ? `If it’s easier, feel free to grab a quick time here: ${booking}` : null,
  ].filter(Boolean).join(' ');
}

function sanitizeForLogs(value, limit = 1200) {
  const s = String(value ?? '');
  const cleaned = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

function buildModel(genAI, systemInstruction, maxOutputTokens) {
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction,
    generationConfig: {
      maxOutputTokens,
      responseMimeType: 'application/json',
    },
  });
}

async function classifyAndDraft(threadContext, inboundMessage, voicePrompt, bookingLink, schedulingPromptBlock) {
  const booking = bookingLink || '[no booking link configured — say you will send a scheduling link shortly]';
  const scheduleCtx = schedulingPromptBlock || 'No verified availability was loaded.';

  const systemPrompt = `You are an expert B2B sales reply classifier and ghostwriter.

Your job:
1. Classify the prospect's latest reply into exactly one category.
2. If the classification warrants a draft reply, write one in the client's voice.

CLASSIFICATION CATEGORIES (pick exactly one):
${CLASSIFICATIONS.map(c => `- ${c}`).join('\n')}

RULES FOR DRAFTING:
- Draft a reply for ALL classifications except OUT_OF_OFFICE
- For OUT_OF_OFFICE: set "draft" to null
- Never start with "Great question" or similar filler
- Never use exclamation marks excessively
- Keep replies friendly, warm, and concise — 2-4 short sentences max (fewer is better)
- End INTERESTED/QUESTION replies with a soft ask for a call
- End OBJECTION replies by acknowledging their concern and pivoting
- Sound like a real human, not a bot
- For INTERESTED, QUESTION, OBJECTION: do NOT paste verified scheduling times from the block below unless the prospect explicitly asked for times to meet.

VERIFIED AVAILABILITY (from the client's scheduling system when configured — e.g. Calendly API with token — and/or their connected Google/Outlook busy times — not invented):
${scheduleCtx}

MEETING_PROPOSED + SCHEDULING (client may use Calendly, Cal.com, SavvyCal, HubSpot meetings, etc. — the booking URL is generic):
- If the block lists TWO verified open times, your draft MUST offer exactly those two (use the human-readable labels). Then include the booking link once so they can book or pick another slot: ${booking}
- If the block lists only ONE verified time, mention that time and the booking link once; do not invent a second wall-clock time.
- If the block says no verified slots, do not invent specific times; invite them to choose via the booking link once: ${booking}
- If the prospect proposed a specific time, confirm it warmly, still include the booking link once for them to confirm, and use verified slots only as extras if the block lists them and they do not conflict.
- Work the booking link naturally (full URL). Never label the tool as "Calendly" unless the URL is calendly.com.
- Set "proposed_time" to the prospect's stated time if any; else the first verified slot's ISO from the block if present; else null.

CLIENT VOICE INSTRUCTIONS:
${voicePrompt || 'Professional, direct, practitioner-level tone. No fluff.'}

Respond in this exact JSON format (no markdown, no code fences):
{
  "classification": "CATEGORY",
  "draft": "Reply text here or null if no draft needed",
  "proposed_time": "Extracted or suggested time string, or null if not MEETING_PROPOSED",
  "reasoning": "One sentence explaining your classification"
}`;

  const strictRepairPrompt = `${systemPrompt}

CRITICAL OUTPUT RULES:
- Output MUST be valid JSON (parsable by JSON.parse).
- Output MUST contain exactly one JSON object and nothing else.
- Keep "draft" under 500 characters so it never gets cut off mid-string.
- If classification is OUT_OF_OFFICE, set "draft": null.
`;

  const userMessage = `Here is the full email/message thread for context:

${typeof threadContext === 'string' ? threadContext : JSON.stringify(threadContext, null, 2)}

---

The prospect's latest reply:
${inboundMessage}

Classify this reply and draft a response if appropriate.`;

  const attempts = [
    { prompt: systemPrompt, maxTokens: 1536 },
    { prompt: strictRepairPrompt, maxTokens: 1024 },
  ];

  let lastText = null;

  try {
    for (const a of attempts) {
      const model = buildModel(genAI, a.prompt, a.maxTokens);
      const result = await model.generateContent(userMessage);
      const text = result.response.text().trim();
      lastText = text;

      const parsed = tryParseClassifierResult(text);
      if (parsed) {
        if (parsed.classification === 'OUT_OF_OFFICE') {
          return { ...parsed, draft: null };
        }
        if (
          parsed.classification === 'MEETING_PROPOSED' &&
          parsed.draft &&
          bookingLink &&
          String(bookingLink).trim().startsWith('http') &&
          !String(parsed.draft).includes(String(bookingLink).trim())
        ) {
          parsed.draft = `${String(parsed.draft).trim()}\n\n${String(bookingLink).trim()}`;
        }
        return parsed;
      }
    }
  } catch (err) {
    console.error('[Classifier] Gemini request failed', { err: err.message });
  }

  console.error('[Classifier] Unparsable Gemini JSON; using fallback draft', {
    raw: sanitizeForLogs(lastText, 1200),
  });
  return {
    classification: 'OTHER',
    draft: makeFallbackDraft({ inboundMessage, bookingLink }),
    proposed_time: null,
    reasoning: 'Fallback draft generated (Gemini returned unparsable or truncated JSON).',
  };
}

module.exports = { classifyAndDraft, CLASSIFICATIONS, DRAFT_CLASSIFICATIONS };
