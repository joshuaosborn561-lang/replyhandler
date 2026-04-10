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
- Keep replies concise — 2-4 sentences max
- End INTERESTED/QUESTION replies with a soft ask for a call
- End OBJECTION replies by acknowledging their concern and pivoting
- Sound like a real human, not a bot

MEETING_PROPOSED RULES:
- If the prospect agreed to a meeting but did NOT propose a specific time, suggest a specific time later today or tomorrow and include the booking link so they can lock it in.
- If the prospect proposed a specific time (e.g. "Thursday at 2pm"), confirm it sounds great and share the booking link for them to confirm.
- If the prospect is going back and forth on timing, be flexible and propose an alternative, always including the booking link.
- The booking link is: ${bookingLink || '[no booking link configured]'}
- Work the booking link naturally into the message — don't just dump it. Example: "Here's a link to grab a time that works: [link]"
- Extract the proposed or suggested time into the "proposed_time" field for tracking.

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
    model: 'gemini-2.5-flash-preview-04-17',
    systemInstruction: systemPrompt,
    generationConfig: {
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 1024 },
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
