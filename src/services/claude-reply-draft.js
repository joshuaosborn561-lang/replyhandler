const replyExamples = require('./reply-examples');

const JOSH_VOICE_STYLE_GUIDE = `JOSH'S VOICE — RULES:
- Near-universal opener when replying to any response: "Hey [Name], thanks for getting back to me" or a close variant. Use it as a default opener.
- Short, warm, conversational. Contractions throughout.
- When you make a mistake or mixed something up, own it lightly with self-deprecating humor: "Oh no, put my foot in my mouth already! Haha" — don't over-apologize, just acknowledge and move on immediately.
- When handing off to a teammate (sales director, CEO), name them directly and give their Calendly link in the same message, framed as "he'd be the right person to talk through what makes sense for you."
- End replies with a direct, low-friction next step or question, not a pitch: "Would Tuesday work?" "Still a good time to meet?" "Can you chat Tuesday or Wednesday if it looks relevant?"
- Light, genuine humor is welcome (self-deprecating, playful) but never forced or gimmicky.
- No corporate filler: never "per my last email," "circle back," "touch base," "I hope this finds you well."
- Sign-off is just a first name, no "Best," "Regards," or formal closings.`;

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY && replyExamples.isConfigured());
}

function messageList(threadContext) {
  if (!threadContext) return [];
  let ctx = threadContext;
  if (typeof ctx === 'string') {
    try { ctx = JSON.parse(ctx); } catch { return []; }
  }
  if (Array.isArray(ctx)) return ctx;
  if (Array.isArray(ctx.messages)) return ctx.messages;
  if (Array.isArray(ctx.history)) return ctx.history;
  return [];
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\r\n/g, '\n')
    .trim();
}

function summarizeThread(threadContext) {
  const rows = messageList(threadContext).slice(-10);
  if (!rows.length) return '(no prior thread available)';
  return rows
    .map((row) => {
      const roleRaw = String(
        row?.type || row?.direction || row?.role || row?.sender || ''
      ).toLowerCase();
      const role = /sent|outbound|us|me|user/.test(roleRaw) ? 'Josh' : 'Prospect';
      const body = htmlToText(
        row?.message || row?.body || row?.text || row?.email_body || row?.content
      );
      return body ? `${role}: ${body}` : null;
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 12000);
}

function formatExamples(examples) {
  if (!examples.length) return '(no close examples found)';
  return examples.map((example, index) => [
    `<example ${index + 1} similarity="${Number(example.similarity || 0).toFixed(3)}">`,
    `Prospect: ${example.lead_message}`,
    `Josh: ${example.my_reply}`,
    example.thread_context ? `Prior context: ${example.thread_context}` : null,
    example.category ? `Category: ${example.category}` : null,
    `</example ${index + 1}>`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function extractText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n')
    .trim();
}

async function generateClaudeReply({
  inboundMessage,
  threadContext,
  classification,
  leadName,
  bookingLink,
  schedulingPromptBlock,
  includeBookingLink,
  platform,
}) {
  if (!isConfigured()) throw new Error('Claude retrieval drafting is not configured');

  const examples = await replyExamples.matchReplies(inboundMessage, 4);
  const link = String(bookingLink || '').trim();
  const bookingPolicy = includeBookingLink
    ? `The prospect asked for or accepted the booking link. Include this exact link once: ${link || '(no link configured)'}.`
    : `This is a times-first reply. Suggest concrete times from the scheduling guidance, and offer to send a booking link if neither works. Do not include any URL in this reply.`;

  const system = [
    'You ghostwrite a B2B sales reply in Josh’s voice.',
    'Output only the finished plain-text reply. No markdown, analysis, labels, or surrounding quotes.',
    '',
    JOSH_VOICE_STYLE_GUIDE,
    '',
    'OPERATIONAL RULES:',
    `- ${bookingPolicy}`,
    '- The operational booking rule overrides any older retrieved example that pasted a link too early.',
    '- Do not invent pricing, proof, names, availability, or offer details.',
    '- Keep every sentence complete and usually stay under 120 words.',
    platform === 'heyreach'
      ? '- This is LinkedIn: keep it especially short and do not add a signature.'
      : '- This is email: a first-name-only sign-off is allowed but not required.',
  ].join('\n');

  const user = [
    `Prospect name: ${leadName || 'Unknown'}`,
    `Classification: ${classification || 'OTHER'}`,
    '',
    '<current_thread>',
    summarizeThread(threadContext),
    '</current_thread>',
    '',
    '<latest_prospect_reply>',
    String(inboundMessage || '').trim(),
    '</latest_prospect_reply>',
    '',
    '<scheduling_guidance>',
    schedulingPromptBlock || '(suggest two reasonable options in the next few business days)',
    '</scheduling_guidance>',
    '',
    '<similar_manual_replies>',
    formatExamples(examples),
    '</similar_manual_replies>',
    '',
    'Write the reply now.',
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_REPLY_MODEL || 'claude-sonnet-5',
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const responseText = await res.text();
  let data;
  try { data = JSON.parse(responseText); } catch { data = {}; }
  if (!res.ok) {
    throw new Error(`Anthropic draft failed (${res.status}): ${responseText.slice(0, 500)}`);
  }
  const text = extractText(data);
  if (!text) throw new Error('Anthropic returned an empty draft');
  return {
    text,
    model: data.model || process.env.ANTHROPIC_REPLY_MODEL || 'claude-sonnet-5',
    examples,
  };
}

module.exports = {
  JOSH_VOICE_STYLE_GUIDE,
  isConfigured,
  generateClaudeReply,
  summarizeThread,
};
