const replyExamples = require('./reply-examples');
const { enforcePrincipalVoice } = require('../utils/principal-draft-guard');
const { FACT_GROUNDING_RULES } = require('../utils/draft-fact-check');

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
  draftMode = 'realtime',
  learnedVoiceBlock = '',
  factCheckRetryClaims = null,
}) {
  if (!isConfigured()) throw new Error('Claude retrieval drafting is not configured');
  if (String(draftMode || '').toLowerCase() === 'bulk') {
    throw new Error('Claude drafting is hard-disabled for bulk/poller/backfill');
  }

  const { speaksAsPrincipal } = require('../utils/principal-voice');
  const asPrincipal = speaksAsPrincipal(voicePrompt);
  const mode = String(replyMode || 'FIRST_TOUCH').toUpperCase() === 'CONTINUATION'
    ? 'CONTINUATION'
    : 'FIRST_TOUCH';

  let examples = [];
  try {
    examples = await replyExamples.matchReplies(inboundMessage, 4, {
      clientName: asPrincipal ? (clientName || 'SalesGlider') : clientName,
      preferAckExamples: true,
    });
  } catch (err) {
    // Embeddings bill to Gemini. A 402 here used to skip Claude entirely and
    // fall through to a Gemini draft that fails the same way.
    console.warn('[ClaudeDraft] RAG match failed — drafting without examples', { err: err.message });
    examples = [];
  }
  const {
    prefersInPersonMeeting, prefersCallbackCall, DEEP_ROOTS_CALLER, DEEP_ROOTS_FROM_NUMBER,
  } = require('../utils/meeting-modality');
  const inPerson = prefersInPersonMeeting(voicePrompt);
  const callback = prefersCallbackCall(voicePrompt, clientName);
  const link = String(bookingLink || '').trim();
  const bookingPolicy = callback
    ? `CALLBACK: Ask what time works best. ${DEEP_ROOTS_CALLER} will call from ${DEEP_ROOTS_FROM_NUMBER}. Do not include any booking URL, two calendar slots, or Zoom.`
    : inPerson
    ? 'IN-PERSON: Suggest two concrete times to stop by. Do not include any booking URL, Zoom, or phone CTA.'
    : includeBookingLink
      ? `Suggest two concrete times from the scheduling guidance, then include this exact booking link once: ${link || '(no link configured)'}.`
      : mode === 'CONTINUATION'
        ? `Continue the thread. Suggest a next step or times only after acknowledging their latest point. Do not include any URL unless they asked for the link.`
        : `This is a times-first reply after acknowledging their point. Suggest concrete times from the scheduling guidance. Do not include any URL in this reply.`;

  const teammateRule = asPrincipal
    ? '- You are the CEO. Never say "our CEO", "our founder", or hand off to a CEO/founder. Suggest a quick call with you ("with me").'
    : '- Mention a teammate by name only if that name appears in the current thread or scheduling guidance. Otherwise say "our CEO" or "our team."';

  const specificsRule = asPrincipal
    ? '- If the prospect asks for specifics the thread does not answer, say you do not want to guess over email and offer a short call with you.'
    : '- If the prospect asks for specifics the thread does not answer, say you do not want to guess over email and offer a short call with the right teammate.';

  const clientVoice = String(voicePrompt || '').trim()
    ? `\nCLIENT VOICE (must follow):\n${String(voicePrompt).trim()}\n`
    : '';
  // Weekly-synthesized profile (voice-profile.js). Sits below the fixed style
  // guide and above the operational rules, which still win on conflict.
  const learnedVoice = String(learnedVoiceBlock || '').trim()
    ? `\n${String(learnedVoiceBlock).trim()}\n`
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
    learnedVoice,
    'OPERATIONAL RULES:',
    `- ${bookingPolicy}`,
    '- The operational booking rule overrides any older retrieved example that withheld the booking link or invented times.',
    '- Retrieved examples are style references only. Never copy their people names, company/product names, URLs, claims, pricing, or offer details.',
    '- Final fact check: every person name, company name, product name, domain, and acronym in your draft must appear in the current thread/latest reply, the scheduling guidance, or the CLIENT NOTES above. If it appears only in a retrieved example, remove it.',
    teammateRule,
    FACT_GROUNDING_RULES,
    '- Never state a seat, section, row, venue, date, or ticket quantity — tickets get worked out after a quick call.',
    '- Never state meeting times that did not come from the scheduling guidance / calendar.',
    '- Before writing, silently check every factual claim against the provided context. If it is not explicitly supported there, leave it out.',
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
    factCheckRetryClaims && factCheckRetryClaims.length
      ? `\n${require('../utils/draft-fact-check').factCheckRetryHint(factCheckRetryClaims)}`
      : '',
  ].filter(Boolean).join('\n');

  let data = await callAnthropic(system, user);
  let text = extractText(data);
  if (!text) throw new Error('Anthropic returned an empty draft');

  // Learned client notes count as facts: they were distilled from this
  // client's own sent replies, so a term from them is not an example leak.
  const currentFacts = [
    leadName,
    summarizeThread(threadContext),
    inboundMessage,
    schedulingPromptBlock,
    learnedVoiceBlock,
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

const FOLLOW_UP_RULES = `FOLLOW-UP MODE (cadence bump after we already sent a reply):
- Write the natural next message on this thread. Continue the conversation the way a human would — not a canned bump.
- Read the FULL thread. If they asked for something, set a condition, asked a question, or named a different need, address THAT first.
- Never repeat an earlier bump almost verbatim. If we already asked "still interested in meeting for X?", do not ask it again.
- Suggest a meeting / times / booking link ONLY where it naturally fits after addressing their point. A reply with no meeting ask is fine.
- Do not invent facts (deck contents, pricing numbers, qualification cutoffs, ticket dates, locations).
- Never state a seat, section, row, venue, date, or ticket quantity — tickets get worked out after a quick call.
- PRICING: say you are happy to walk through pricing on a quick call. needs_client must be false. Never stall.
- Specifics we do not have (minimums, headcount cutoffs, locations): do not guess. Offer a short call. needs_client = false.
- ONE-PAGER / DECK / "email me some info" / "send details" / "send it over" when that means collateral we cannot attach from this inbox: the draft says we are looping in the CLIENT CONTACT FIRST NAME from our side to send it. Copy that first name character-for-character from the CLIENT CONTACT FIRST NAME line — do not respell it, do not substitute a lookalike. Style: "looping in <that exact first name> from our side". Name only — no title. Never say founder. Never invent a name. Set needs_client=true and what_to_send to a short label (one-pager, deck, info). Cayden sends these follow-ups — never stall for Josh.
- Tickets or a specific address they gave us: acknowledge and continue. needs_client=false unless they asked for client-owned collateral.
- A different need than we originally pitched: follow their need. Do not drag them back to the original offer.
- No sign-off. No markdown. No surrounding quotes.
- Output JSON only.`;

function formatFollowUpThread(threadMessages, threadContext) {
  const { formatThreadForPrompt } = require('../utils/follow-up-thread-display');
  if (Array.isArray(threadMessages) && threadMessages.length) {
    return formatThreadForPrompt(threadMessages);
  }
  return summarizeThread(threadContext);
}

function parseFollowUpModelJson(raw) {
  let text = String(raw || '').trim();
  if (!text) return { draft: '', needsClient: false, whatToSend: null };
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { draft: text, needsClient: false, whatToSend: null };
  }
  const draft = String(
    parsed.draft || parsed.text || parsed.reply || parsed.message || ''
  ).trim();
  const needsClient = parsed.needs_client === true || parsed.needsClient === true;
  const what = String(parsed.what_to_send || parsed.whatToSend || '').trim();
  return {
    draft: draft || text,
    needsClient,
    whatToSend: needsClient ? (what || 'info') : null,
  };
}

function followUpSchedulingBlock({
  slots, bookingLink, voicePrompt, clientName, step,
} = {}) {
  const {
    prefersInPersonMeeting, prefersCallbackCall, DEEP_ROOTS_CALLER, DEEP_ROOTS_FROM_NUMBER,
  } = require('../utils/meeting-modality');
  if (prefersCallbackCall(voicePrompt, clientName)) {
    return `CALLBACK: ${DEEP_ROOTS_CALLER} will call from ${DEEP_ROOTS_FROM_NUMBER}. Ask what time works only if a call naturally fits. No booking URL, two calendar slots, or Zoom.`;
  }
  if (prefersInPersonMeeting(voicePrompt)) {
    return 'IN-PERSON: Suggest stop-by times only if a meeting naturally fits. No booking URL, Zoom, or phone CTA.';
  }
  const labels = (slots || [])
    .map((s) => (s && typeof s === 'object' ? s.label : s))
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 2);
  const link = String(bookingLink || '').trim();
  const lines = [
    'TIMES / LINK are available if a meeting naturally fits — they are not required.',
    labels.length
      ? `Verified open times: ${labels.join(' · ')}`
      : 'No verified open times were fetched.',
    link ? `Booking link (include only if useful): ${link}` : 'No booking link configured.',
    `Cadence step ${Number(step) || 1}.`,
  ];
  return lines.join('\n');
}

function buildFollowUpPrompt({
  leadName,
  threadMessages,
  threadContext,
  lastInboundMessage,
  lastOutboundMessage,
  classification,
  bookingLink,
  slots,
  platform,
  voicePrompt,
  clientName,
  loopContact = null,
  step,
  daysSinceLastMessage,
  learnedVoiceBlock = '',
  examples = [],
  asPrincipal = false,
  factCheckRetryClaims = null,
} = {}) {
  const { FACT_GROUNDING_RULES } = require('../utils/draft-fact-check');
  const { clientLoopContact, loopInLine } = require('../utils/client-loop-contact');
  const contact = clientLoopContact({ voicePrompt, clientName, loopContact });
  const exactFirst = contact.firstName;
  const spokenLine = exactFirst ? loopInLine(exactFirst) : null;
  const clientVoice = String(voicePrompt || '').trim()
    ? `\nCLIENT VOICE (must follow):\n${String(voicePrompt).trim()}\n`
    : '';
  const learnedVoice = String(learnedVoiceBlock || '').trim()
    ? `\n${String(learnedVoiceBlock).trim()}\n`
    : '';
  const loopRule = asPrincipal
    ? '- You ARE the client principal. Do not set needs_client — there is no separate client to loop in. For collateral we do not have, offer a short call rather than stalling.'
    : exactFirst
      ? [
        `- CLIENT CONTACT FIRST NAME (copy character-for-character; do not respell): ${exactFirst}`,
        `- When looping in for a deck / one-pager / "send info", the draft MUST contain this exact phrase: ${spokenLine}`,
        '- Name only, no title. Never say founder. Never invent a different person. Never substitute a lookalike spelling.',
      ].join('\n')
      : '- CLIENT CONTACT is not configured. Do not guess a name. Never say founder. Say you will loop in someone from our side to send it, without naming a person.';

  const system = [
    asPrincipal
      ? 'You ghostwrite a B2B follow-up as Josh, founder/CEO, in first person.'
      : 'You ghostwrite a B2B follow-up in Josh’s voice.',
    'Return ONLY a JSON object with keys draft (string), needs_client (boolean), what_to_send (string or null). No markdown fences.',
    '',
    asPrincipal ? JOSH_AS_CEO_STYLE_GUIDE : JOSH_VOICE_STYLE_GUIDE,
    '',
    CONTINUATION_RULES,
    '',
    FOLLOW_UP_RULES,
    loopRule,
    clientVoice,
    learnedVoice,
    'OPERATIONAL RULES:',
    `- ${followUpSchedulingBlock({ slots, bookingLink, voicePrompt, clientName, step })}`,
    '- Retrieved examples are style references only. Never copy their people names, company/product names, URLs, claims, pricing, or offer details.',
    FACT_GROUNDING_RULES,
    '- Keep every sentence complete and usually stay under 120 words.',
    platform === 'heyreach'
      ? '- This is LinkedIn: keep it especially short and do not add a signature.'
      : '- This is email: no sign-off — the mailbox adds the signature.',
  ].join('\n');

  const threadBlock = formatFollowUpThread(threadMessages, threadContext);
  const daysBit = daysSinceLastMessage == null
    ? 'unknown'
    : `${daysSinceLastMessage} day(s)`;

  const user = [
    `Prospect name: ${leadName || 'Unknown'}`,
    exactFirst
      ? `CLIENT CONTACT FIRST NAME (copy character-for-character): ${exactFirst}`
      : null,
    `Classification: ${classification || 'FOLLOW_UP'}`,
    `Follow-up cadence step: ${Number(step) || 1}`,
    `Days since last message: ${daysBit}`,
    '',
    '<current_thread>',
    threadBlock,
    '</current_thread>',
    '',
    '<latest_prospect_message>',
    String(lastInboundMessage || '').trim() || '(no new prospect reply since our last send)',
    '</latest_prospect_message>',
    '',
    '<our_last_send>',
    String(lastOutboundMessage || '').trim() || '(unknown)',
    '</our_last_send>',
    '',
    '<similar_manual_replies>',
    formatExamples(examples),
    '</similar_manual_replies>',
    '',
    'Write the follow-up now as JSON.',
    factCheckRetryClaims && factCheckRetryClaims.length
      ? `\n${require('../utils/draft-fact-check').factCheckRetryHint(factCheckRetryClaims)}`
      : '',
  ].filter(Boolean).join('\n');

  return { system, user, threadBlock };
}

function anthropicKeyConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Claude follow-up draft. Allowed in bulk/poller/cron — follow-ups are low
 * volume. RAG is best-effort; a missing corpus still drafts.
 */
async function generateFollowUpClaudeDraft({
  inboundMessage,
  lastInboundMessage,
  lastOutboundMessage,
  threadContext,
  threadMessages,
  leadName,
  bookingLink,
  slots,
  platform,
  voicePrompt,
  clientName = null,
  loopContact = null,
  step = 1,
  daysSinceLastMessage = null,
  learnedVoiceBlock = '',
  factCheckRetryClaims = null,
} = {}) {
  if (!anthropicKeyConfigured()) {
    throw new Error('Anthropic is not configured');
  }

  const { speaksAsPrincipal } = require('../utils/principal-voice');
  const asPrincipal = speaksAsPrincipal(voicePrompt);
  let examples = [];
  if (replyExamples.isConfigured()) {
    try {
      const query = String(lastInboundMessage || inboundMessage || lastOutboundMessage || '').trim()
        || formatFollowUpThread(threadMessages, threadContext);
      examples = await replyExamples.matchReplies(query, 4, {
        clientName: asPrincipal ? (clientName || 'SalesGlider') : clientName,
        preferAckExamples: true,
      });
    } catch (err) {
      console.warn('[FollowUp] RAG match failed — drafting without examples', { err: err.message });
    }
  }

  const { system, user } = buildFollowUpPrompt({
    leadName,
    threadMessages,
    threadContext,
    lastInboundMessage: lastInboundMessage || inboundMessage,
    lastOutboundMessage,
    bookingLink,
    slots,
    platform,
    voicePrompt,
    clientName,
    loopContact,
    step,
    daysSinceLastMessage,
    learnedVoiceBlock,
    examples,
    asPrincipal,
    factCheckRetryClaims,
  });

  const data = await callAnthropic(system, user);
  const raw = extractText(data);
  if (!raw) throw new Error('Anthropic returned an empty follow-up draft');
  let parsed = parseFollowUpModelJson(raw);
  if (!parsed.draft) throw new Error('Anthropic follow-up JSON had an empty draft');

  if (asPrincipal) {
    parsed = { ...parsed, needsClient: false, whatToSend: null };
  }

  const currentFacts = [
    leadName,
    clientName,
    require('../utils/client-loop-contact').clientLoopContact({
      voicePrompt, clientName, loopContact,
    }).firstName,
    require('../utils/client-loop-contact').clientLoopContactPhrase({
      voicePrompt, clientName, loopContact,
    }),
    formatFollowUpThread(threadMessages, threadContext),
    lastInboundMessage,
    lastOutboundMessage,
    bookingLink,
    learnedVoiceBlock,
  ].filter(Boolean).join('\n');
  let leakedTerms = findExampleOnlyTerms(examples, currentFacts, parsed.draft);
  if (leakedTerms.length) {
    console.warn('[FollowUp] Regenerating after example-only term leak', { terms: leakedTerms });
    const retry = await callAnthropic(
      system,
      `${user}\n\nFINAL CORRECTION: The prior draft copied these terms from retrieved examples even though they are absent from the current facts: ${leakedTerms.join(', ')}. Write a fresh JSON follow-up without those terms.`
    );
    const retryText = extractText(retry);
    if (!retryText) throw new Error('Anthropic returned an empty corrected follow-up');
    parsed = parseFollowUpModelJson(retryText);
    if (asPrincipal) {
      parsed = { ...parsed, needsClient: false, whatToSend: null };
    }
    leakedTerms = findExampleOnlyTerms(examples, currentFacts, parsed.draft);
    if (leakedTerms.length) {
      throw new Error(`Claude follow-up retained example-only terms: ${leakedTerms.join(', ')}`);
    }
  }

  const guarded = enforcePrincipalVoice(parsed.draft, { asPrincipal });
  if (guarded.scrubbed) {
    console.warn('[FollowUp] Scrubbed principal handoff leak', { leadName });
    parsed.draft = guarded.text;
  }

  return {
    text: parsed.draft,
    needsClient: parsed.needsClient === true,
    whatToSend: parsed.needsClient ? parsed.whatToSend : null,
    model: data.model || process.env.ANTHROPIC_REPLY_MODEL || 'claude-sonnet-5',
    examples,
    usage: data.usage || null,
  };
}

module.exports = {
  JOSH_VOICE_STYLE_GUIDE,
  JOSH_AS_CEO_STYLE_GUIDE,
  FIRST_TOUCH_RULES,
  CONTINUATION_RULES,
  FOLLOW_UP_RULES,
  isConfigured,
  anthropicKeyConfigured,
  generateClaudeReply,
  generateFollowUpClaudeDraft,
  summarizeThread,
  formatFollowUpThread,
  buildFollowUpPrompt,
  parseFollowUpModelJson,
  followUpSchedulingBlock,
};
