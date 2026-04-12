const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const DRAFT_CLASSIFICATIONS = ['INTERESTED', 'QUESTION', 'OBJECTION', 'MEETING_PROPOSED'];

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
- Draft a reply for: INTERESTED, QUESTION, OBJECTION, MEETING_PROPOSED
- For all other classifications: no draft needed
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

  const userMessage = `Here is the full email/message thread for context:

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
    // Try to extract JSON from the response
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`Failed to parse classifier response: ${text}`);
  }
}

module.exports = { classifyAndDraft, CLASSIFICATIONS, DRAFT_CLASSIFICATIONS };
