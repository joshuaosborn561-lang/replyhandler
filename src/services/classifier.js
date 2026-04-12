const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const DRAFT_CLASSIFICATIONS = ['INTERESTED', 'QUESTION', 'OBJECTION', 'MEETING_PROPOSED'];

async function classifyAndDraft(threadContext, inboundMessage, voicePrompt, bookingLink) {
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

MEETING_PROPOSED + SCHEDULING (Calendly-style link):
- Always include exactly two concrete time suggestions in the draft (e.g. "Tuesday 2:00pm ET or Wednesday 10:30am ET") that fit what the prospect said when possible; if they gave no preference, suggest two slots in the next few business days.
- Always include the client's booking link exactly once so they can self-book: ${bookingLink || '[no booking link configured — say you will send a scheduling link shortly]'}
- Phrase it so they can either reply with a preference OR use the link to lock a slot (Calendly handles actual availability).
- If the prospect proposed a specific time, confirm it sounds great, still offer the two alternatives as backups, and include the booking link for them to confirm.
- If timing is unclear, stay flexible; still give two suggestions plus the booking link.
- Work the booking link naturally — e.g. "If it's easier, you can grab a slot here: [full URL]"
- Extract the primary time they proposed (or your first suggested slot) into "proposed_time" for calendar tracking; use a short human-readable string like "Thursday 2pm" or ISO if given.

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
