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

const GENERIC_CAPITALIZED_TERMS = new Set([
  'Hey', 'Hi', 'Thanks', 'Thank', 'Fair', 'Good', 'Great', 'Honestly',
  'That', 'This', 'The', 'There', 'Would', 'Could', 'Can', 'Happy',
  'Our', 'Your', 'If', 'It', 'Rather', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday', 'Sunday', 'Josh', 'Joshua', 'CEO',
  'MSP', 'IT', 'AI', 'B2B', 'SDR', 'CRM', 'PTO',
  'Actually', 'Already', 'Appreciate', 'Basically', 'Before', 'Best',
  'Book', 'Chat', 'Check', 'Completely', 'Definitely', 'Details',
  'Easier', 'Easiest', 'Either', 'Email', 'Exactly', 'First', 'Free',
  'Get', 'Give', 'Glad', 'Interested', 'Just', 'Know', 'Let', 'Like',
  'Little', 'Looking', 'Maybe', 'Makes', 'More', 'Most', 'Much', 'Need',
  'Nice', 'No', 'Not', 'Nothing', 'One', 'Open', 'Otherwise', 'Perfect',
  'Please', 'PS', 'Quick', 'Really', 'Right', 'See', 'Send', 'Since',
  'Sorry', 'Sounds', 'Still', 'Sure', 'Talk', 'Totally', 'Want', 'What',
  'When', 'Where', 'Why', 'Work', 'Worth', 'Yes', 'You', 'Zero',
  'For', 'As', 'With', 'Does', 'Some', 'Here', 'Got', 'Be', 'Other', 'AM',
].map((term) => term.toLowerCase()));

function containsWholeTerm(text, term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(String(text || ''));
}

function findExampleOnlyTerms(examples, currentFacts, draft) {
  const exampleText = examples
    .map((example) => `${example.lead_message || ''}\n${example.my_reply || ''}`)
    .join('\n');
  const candidates = exampleText.match(/\b(?:[A-Z]{2,}|[A-Z][a-z]{2,})\b/g) || [];
  const facts = String(currentFacts || '').toLowerCase();
  const output = String(draft || '').toLowerCase();
  return [...new Set(candidates)].filter((term) => {
    if (GENERIC_CAPITALIZED_TERMS.has(term.toLowerCase())) return false;
    const lower = term.toLowerCase();
    return containsWholeTerm(output, lower) && !containsWholeTerm(facts, lower);
  });
}

async function callAnthropic(system, user) {
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
  return data;
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
    '- Retrieved examples are style references only. Never copy their people names, company/product names, URLs, claims, pricing, or offer details.',
    '- Final fact check: every person name, company name, product name, domain, and acronym in your draft must appear in the current thread/latest reply. If it appears only in a retrieved example, remove it.',
    '- Mention a teammate by name only if that name appears in the current thread or scheduling guidance. Otherwise say "our CEO" or "our team."',
    '- Use only facts present in the current thread, latest reply, or scheduling guidance.',
    '- Before writing, silently check every factual claim against the current thread. If it is not explicitly supported there, leave it out.',
    '- If the prospect asks for specifics the thread does not answer, say you do not want to guess over email and offer a short call with the right teammate.',
    '- Never invent lead sources, qualification criteria, locations, pricing structure, service coverage, project types, capabilities, results, or availability.',
    '- Do not call pricing simple or imply a price/fee structure unless the exact relevant fact appears in the current thread.',
    '- For a possible fit mismatch, acknowledge it honestly. Do not expand the service to fit their business unless that capability is explicitly in the current thread.',
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

  let data = await callAnthropic(system, user);
  let text = extractText(data);
  if (!text) throw new Error('Anthropic returned an empty draft');

  const currentFacts = [
    leadName,
    summarizeThread(threadContext),
    inboundMessage,
    schedulingPromptBlock,
  ].filter(Boolean).join('\n');
  let leakedTerms = findExampleOnlyTerms(examples, currentFacts, text);
  if (leakedTerms.length) {
    console.warn('[ClaudeDraft] Regenerating after example-only term leak', {
      terms: leakedTerms,
    });
    data = await callAnthropic(
      system,
      `${user}\n\nFINAL CORRECTION: The prior draft copied these terms from retrieved examples even though they are absent from the current facts: ${leakedTerms.join(', ')}. Write a fresh reply without those terms or any other example-only proper nouns.`
    );
    text = extractText(data);
    if (!text) throw new Error('Anthropic returned an empty corrected draft');
    leakedTerms = findExampleOnlyTerms(examples, currentFacts, text);
    if (leakedTerms.length) {
      throw new Error(`Claude draft retained example-only terms: ${leakedTerms.join(', ')}`);
    }
  }

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
