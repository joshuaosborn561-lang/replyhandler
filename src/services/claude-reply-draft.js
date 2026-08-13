const replyExamples = require('./reply-examples');
const { enforcePrincipalVoice } = require('../utils/principal-draft-guard');

const JOSH_VOICE_STYLE_GUIDE = `JOSH'S VOICE — RULES:
- ACK FIRST: React to what they actually said before any CTA. If they asked a question, answer it. If they mentioned tickets/offer/catch/location/skepticism, acknowledge that point in the first line.
- Soft yes ("sure", "interested") can use "Hey [Name], thanks for getting back to me" — but never use that opener when they asked something concrete.
- Short, warm, conversational. Contractions throughout.
- When you make a mistake or mixed something up, own it lightly with self-deprecating humor — don't over-apologize, just acknowledge and move on immediately.
- When handing off to a teammate (sales director, CEO), name them directly and give their Calendly link in the same message.
- End replies with a direct, low-friction next step or question, not a pitch.
- Light, genuine humor is welcome. No corporate filler.
- Sign-off is just a first name, no "Best," "Regards," or formal closings.`;

/** Same voice, but Josh is the CEO — never hand off to "our CEO". */
const JOSH_AS_CEO_STYLE_GUIDE = `JOSH'S VOICE (YOU ARE THE CEO) — RULES:
- ACK FIRST: React to what they actually said before any CTA. Mirror their point (tickets, catch, question, payment-on-you, skepticism, location mixup) in the opening beat.
- Soft yes ("sure", "interested") may open with "Hey [Name], thanks for getting back to me" — never when they asked a concrete question.
- Short, warm, conversational. Contractions throughout.
- You are Joshua Osborn, founder/CEO. Speak in first person as yourself.
- NEVER say "our CEO", "our founder", "chat with our CEO", "call with our founder", or hand off to a CEO — you ARE the CEO.
- Suggest a quick call with you: "quick call with me", "jump on a call", "chat with me".
- When you make a mistake, own it lightly with self-deprecating humor — don't over-apologize.
- End with a direct next step: "Would Tuesday work?" "Can you chat Tuesday or Wednesday?"
- Light humor is welcome. No corporate filler.
- No sign-off / formal closing — mailbox adds the signature.`;

const FIRST_TOUCH_RULES = `DRAFT MODE = FIRST_TOUCH (first inbound reply we are answering):
- Acknowledge their message, then offer + soft CTA (times or video when relevant).
- "Hey [Name], thanks for getting back to me" is OK for bare interest ("sure", "I'm interested").
- If they asked a question or raised an objection, answer that first — do not skip to times.`;

const CONTINUATION_RULES = `DRAFT MODE = CONTINUATION (second+ inbound — we already sent them something):
- Do NOT reset to a first-touch opener. No "thanks for getting back to me" unless it still fits naturally.
- Continue the thread: answer their latest point ("Ok great…", "Fair enough…", "Sorry for the mixup…").
- Then propose a next step. Keep it shorter than a first-touch reply.`;

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
  'All', 'At', 'To', 'In', 'Of', 'And', 'Or', 'Is', 'Are', 'We', 'By', 'On', 'But',
].map((term) => term.toLowerCase()));

function containsWholeTerm(text, term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(String(text || ''));
}

function findExampleOnlyTerms(examples, currentFacts, draft) {
  const exampleText = examples
    .map((example) => `${example.lead_message || ''}\n${example.my_reply || ''}`)
    .join('\n');
  const candidates = exampleText.match(/\b(?:[A-Z]{3,}|[A-Z][a-z]{2,})\b/g) || [];
  const facts = String(currentFacts || '').toLowerCase();
  const output = String(draft || '').toLowerCase();
  return [...new Set(candidates)].filter((term) => {
    if (GENERIC_CAPITALIZED_TERMS.has(term.toLowerCase())) return false;
    const lower = term.toLowerCase();
    return containsWholeTerm(output, lower) && !containsWholeTerm(facts, lower);
  });
}

async function callAnthropic(system, user) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
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
      if (res.ok) return data;

      lastError = new Error(
        `Anthropic draft failed (${res.status}): ${responseText.slice(0, 500)}`
      );
      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (!retryable || attempt === 3) break;
    } catch (err) {
      lastError = err;
      if (attempt === 3) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
  }
  throw lastError || new Error('Anthropic draft request failed');
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
  voicePrompt,
  replyMode = 'FIRST_TOUCH',
  replyOrdinal = 1,
  clientName = null,
}) {
  if (!isConfigured()) throw new Error('Claude retrieval drafting is not configured');

  const { speaksAsPrincipal } = require('../utils/principal-voice');
  const asPrincipal = speaksAsPrincipal(voicePrompt);
  const mode = String(replyMode || 'FIRST_TOUCH').toUpperCase() === 'CONTINUATION'
    ? 'CONTINUATION'
    : 'FIRST_TOUCH';

  const examples = await replyExamples.matchReplies(inboundMessage, 4, {
    clientName: asPrincipal ? (clientName || 'SalesGlider') : clientName,
    preferAckExamples: true,
  });
  const link = String(bookingLink || '').trim();
  const bookingPolicy = includeBookingLink
    ? `The prospect asked for or accepted the booking link. Include this exact link once: ${link || '(no link configured)'}.`
    : mode === 'CONTINUATION'
      ? `Continue the thread. Suggest a next step or times only after acknowledging their latest point. Offer to send a booking link if needed. Do not include any URL unless they asked for the link.`
      : `This is a times-first reply after acknowledging their point. Suggest concrete times from the scheduling guidance, and offer to send a booking link if neither works. Do not include any URL in this reply.`;

  const teammateRule = asPrincipal
    ? '- You are the CEO. Never say "our CEO", "our founder", or hand off to a CEO/founder. Suggest a quick call with you ("with me").'
    : '- Mention a teammate by name only if that name appears in the current thread or scheduling guidance. Otherwise say "our CEO" or "our team."';

  const specificsRule = asPrincipal
    ? '- If the prospect asks for specifics the thread does not answer, say you do not want to guess over email and offer a short call with you.'
    : '- If the prospect asks for specifics the thread does not answer, say you do not want to guess over email and offer a short call with the right teammate.';

  const clientVoice = String(voicePrompt || '').trim()
    ? `\nCLIENT VOICE (must follow):\n${String(voicePrompt).trim()}\n`
    : '';

  const system = [
    asPrincipal
      ? 'You ghostwrite a B2B sales reply as Josh, founder/CEO, in first person.'
      : 'You ghostwrite a B2B sales reply in Josh’s voice.',
    'Output only the finished plain-text reply. No markdown, analysis, labels, or surrounding quotes.',
    '',
    asPrincipal ? JOSH_AS_CEO_STYLE_GUIDE : JOSH_VOICE_STYLE_GUIDE,
    '',
    mode === 'CONTINUATION' ? CONTINUATION_RULES : FIRST_TOUCH_RULES,
    clientVoice,
    'OPERATIONAL RULES:',
    `- ${bookingPolicy}`,
    '- The operational booking rule overrides any older retrieved example that pasted a link too early.',
    '- Retrieved examples are style references only. Never copy their people names, company/product names, URLs, claims, pricing, or offer details.',
    '- Final fact check: every person name, company name, product name, domain, and acronym in your draft must appear in the current thread/latest reply. If it appears only in a retrieved example, remove it.',
    teammateRule,
    '- Use only facts present in the current thread, latest reply, or scheduling guidance.',
    '- Before writing, silently check every factual claim against the current thread. If it is not explicitly supported there, leave it out.',
    specificsRule,
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
    `Draft mode: ${mode} (inbound reply #${replyOrdinal || 1} we are answering)`,
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
    'Write the reply now. Acknowledge their latest point before any CTA.',
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

  const guarded = enforcePrincipalVoice(text, { asPrincipal });
  if (guarded.scrubbed) {
    console.warn('[ClaudeDraft] Scrubbed principal handoff leak', { leadName, mode });
    text = guarded.text;
  }

  return {
    text,
    model: data.model || process.env.ANTHROPIC_REPLY_MODEL || 'claude-sonnet-5',
    examples,
    replyMode: mode,
  };
}

module.exports = {
  JOSH_VOICE_STYLE_GUIDE,
  JOSH_AS_CEO_STYLE_GUIDE,
  FIRST_TOUCH_RULES,
  CONTINUATION_RULES,
  isConfigured,
  generateClaudeReply,
  summarizeThread,
};
