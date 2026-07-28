const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// HeyReach only — SmartLead uses its own native reply category instead of Gemini
// (see services/smartlead-category.js).
const HEYREACH_CLASSIFICATIONS = ['INTERESTED', 'REMOVE_ME', 'OUT_OF_OFFICE', 'UNSURE'];
const HEYREACH_DRAFT_CLASSIFICATIONS = ['INTERESTED', 'UNSURE'];

/**
 * Classify + draft for HeyReach (LinkedIn) replies only.
 */
async function classifyAndDraft(threadContext, inboundMessage, voicePrompt, bookingLink) {
  const booking = bookingLink || '[no booking link configured — say you will send a scheduling link shortly]';

  const systemPrompt = `You are an expert B2B sales reply classifier and ghostwriter for LinkedIn outreach.

Your job:
1. Classify the prospect's latest reply into exactly one category.
2. If the classification warrants a draft reply, write one in the client's voice.

CLASSIFICATION CATEGORIES (pick exactly one):
${HEYREACH_CLASSIFICATIONS.map(c => `- ${c}`).join('\n')}

- INTERESTED: any engaged, curious, positive reply — including questions, pushback/objections
  they're still willing to discuss, and meeting or time proposals. If they're still talking, it's INTERESTED.
- REMOVE_ME: an explicit, unambiguous opt-out / stop-messaging request. Only use when it's obvious.
- OUT_OF_OFFICE: a clearly automated away message. Only use when it's obviously automated.
- UNSURE: anything that doesn't clearly fit the three above — vague, ambiguous, hard to read,
  or genuinely could go either way.

CLASSIFICATION BIAS — READ CAREFULLY:
Missing a real interested reply is far worse than occasionally drafting one that wasn't
strictly needed. Only pick REMOVE_ME or OUT_OF_OFFICE when it is clearly and unambiguously
that. If there is any doubt at all, choose UNSURE (or INTERESTED if they're engaging in any
way) — never guess REMOVE_ME or OUT_OF_OFFICE.

RULES FOR DRAFTING:
- Draft a reply for: INTERESTED, UNSURE
- For REMOVE_ME, OUT_OF_OFFICE: no draft needed
- Never start with "Great question" or similar filler
- Never use exclamation marks excessively
- Keep replies friendly, warm, and concise — 2-4 short sentences max (fewer is better)
- Acknowledge what they said, answer briefly, end with a soft ask for a call
- If they proposed a time or seem ready to meet, naturally include the booking link once (full URL): ${booking}
- Sound like a real human, not a bot

CLIENT VOICE INSTRUCTIONS:
${voicePrompt || 'Professional, direct, practitioner-level tone. No fluff.'}

Respond in this exact JSON format (no markdown, no code fences):
{
  "classification": "CATEGORY",
  "draft": "Reply text here or null if no draft needed",
  "reasoning": "One sentence explaining your classification"
}`;

  const userMessage = `Here is the full LinkedIn conversation thread for context:

${typeof threadContext === 'string' ? threadContext : JSON.stringify(threadContext, null, 2)}

---

The prospect's latest reply:
${inboundMessage}

Classify this reply and draft a response if appropriate.`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: systemPrompt,
    generationConfig: {
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  });

  const result = await model.generateContent(userMessage);
  const text = result.response.text().trim();

  try {
    return JSON.parse(text);
  } catch (err) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse classifier response: ${text}`);
  }
}

/**
 * Draft-only for SmartLead (email) replies. Classification comes from
 * SmartLead's own native reply category (services/smartlead-category.js),
 * not Gemini — this function only writes the reply text.
 */
async function draftSmartleadReply(threadContext, inboundMessage, voicePrompt, bookingLink, schedulingPromptBlock, { isMeetingRequest } = {}) {
  const booking = bookingLink || '[no booking link configured — say you will send a scheduling link shortly]';
  const scheduleCtx = schedulingPromptBlock || 'No verified availability was loaded.';

  const meetingInstructions = isMeetingRequest ? `

SCHEDULING (SmartLead flagged this as a meeting request; client may use Calendly, Cal.com, SavvyCal, HubSpot meetings, etc. — the booking URL is generic):
- If the block below lists TWO verified open times, your draft MUST offer exactly those two (use the human-readable labels). Then include the booking link once so they can book or pick another slot: ${booking}
- If the block lists only ONE verified time, mention that time and the booking link once; do not invent a second wall-clock time.
- If the block says no verified slots, do not invent specific times; invite them to choose via the booking link once: ${booking}
- If the prospect proposed a specific time, confirm it warmly, still include the booking link once for them to confirm, and use verified slots only as extras if the block lists them and they do not conflict.
- Work the booking link naturally (full URL). Never label the tool as "Calendly" unless the URL is calendly.com.
- Set "proposed_time" to the prospect's stated time if any; else the first verified slot's ISO from the block if present; else null.

VERIFIED AVAILABILITY (from the client's scheduling system when configured — e.g. Calendly API with token — and/or their connected Google/Outlook busy times — not invented):
${scheduleCtx}` : '';

  const systemPrompt = `You are an expert B2B sales ghostwriter. SmartLead has already determined this reply
is worth a response — your only job is to write that reply in the client's voice.

RULES FOR DRAFTING:
- Never start with "Great question" or similar filler
- Never use exclamation marks excessively
- Keep replies friendly, warm, and concise — 2-4 short sentences max (fewer is better)
- Acknowledge what the prospect said, answer briefly, end with a soft ask for a call
- Sound like a real human, not a bot${meetingInstructions}

CLIENT VOICE INSTRUCTIONS:
${voicePrompt || 'Professional, direct, practitioner-level tone. No fluff.'}

Respond in this exact JSON format (no markdown, no code fences):
{
  "draft": "Reply text here",
  "proposed_time": "Extracted or suggested time string, or null"
}`;

  const userMessage = `Here is the full email thread for context:

${typeof threadContext === 'string' ? threadContext : JSON.stringify(threadContext, null, 2)}

---

The prospect's latest reply:
${inboundMessage}

Draft a response.`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: systemPrompt,
    generationConfig: {
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  });

  const result = await model.generateContent(userMessage);
  const text = result.response.text().trim();

  try {
    return JSON.parse(text);
  } catch (err) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse draft response: ${text}`);
  }
}

module.exports = {
  classifyAndDraft,
  draftSmartleadReply,
  HEYREACH_CLASSIFICATIONS,
  HEYREACH_DRAFT_CLASSIFICATIONS,
};
