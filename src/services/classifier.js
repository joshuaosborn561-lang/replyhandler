const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED',
  'OUT_OF_OFFICE', 'REMOVE_ME', 'WRONG_PERSON', 'COMPETITOR',
  'MEETING_PROPOSED', 'OTHER',
];

const DRAFT_CLASSIFICATIONS = ['INTERESTED', 'QUESTION', 'OBJECTION'];

async function classifyAndDraft(threadContext, inboundMessage, voicePrompt) {
  const systemPrompt = `You are an expert B2B sales reply classifier and ghostwriter.

Your job:
1. Classify the prospect's latest reply into exactly one category.
2. If the classification warrants a draft reply, write one in the client's voice.

CLASSIFICATION CATEGORIES (pick exactly one):
${CLASSIFICATIONS.map(c => `- ${c}`).join('\n')}

RULES FOR DRAFTING:
- Only draft a reply for: INTERESTED, QUESTION, OBJECTION
- For MEETING_PROPOSED: extract the proposed time instead of drafting
- For all other classifications: no draft needed
- Never start with "Great question" or similar filler
- Never use exclamation marks excessively
- Keep replies concise — 2-4 sentences max
- End INTERESTED/QUESTION replies with a soft ask for a call
- End OBJECTION replies by acknowledging their concern and pivoting
- Sound like a real human, not a bot

CLIENT VOICE INSTRUCTIONS:
${voicePrompt || 'Professional, direct, practitioner-level tone. No fluff.'}

Respond in this exact JSON format (no markdown, no code fences):
{
  "classification": "CATEGORY",
  "draft": "Reply text here or null if no draft needed",
  "proposed_time": "Extracted time string or null if not MEETING_PROPOSED",
  "reasoning": "One sentence explaining your classification"
}`;

  const userMessage = `Here is the full email/message thread for context:

${typeof threadContext === 'string' ? threadContext : JSON.stringify(threadContext, null, 2)}

---

The prospect's latest reply:
${inboundMessage}

Classify this reply and draft a response if appropriate.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].text.trim();

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
