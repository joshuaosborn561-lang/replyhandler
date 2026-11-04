'use strict';

/**
 * Follow-up email Josh can send after he logs a voicemail on a call card.
 * The click still only logs the outcome. This modal is extra. Nothing is
 * emailed until he clicks Send. Cancel closes the modal.
 *
 * The sequence module must not import the send path. Send lives here and
 * runs from the Slack view submission.
 */

const db = require('../db');
const replySend = require('./reply-send');
const { withSmartleadKey } = require('./campaign-routing');
const { factSourceText, enforceDraftGrounding } = require('../utils/draft-fact-check');

const VOICEMAIL_MODAL_ID = 'fseq_voicemail_email_modal';
const DRAFT_BLOCK = 'vm_draft_block';
const DRAFT_ACTION = 'vm_draft_input';
const DRAFT_BUDGET_MS = 1200;

function parseJson(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function firstNameOf(name) {
  try {
    return require('../utils/followup-sequence-text').firstNameOf(name);
  } catch {
    const s = String(name || '').trim().split(/\s+/)[0] || '';
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }
}

/** Short fallback. Uses only the lead's first name. */
function voicemailTemplateText(leadName) {
  const first = firstNameOf(leadName) || 'there';
  return `Hey ${first}, just left you a voicemail. Still want to take a peek at this?`;
}

function threadText(threadContext) {
  if (threadContext == null) return '';
  if (typeof threadContext === 'string') return threadContext;
  try { return JSON.stringify(threadContext); } catch { return ''; }
}

function sourceForDraft({ leadName, company, title, clientName, inboundMessage, threadContext }) {
  return factSourceText({
    leadName: [leadName, company, title].filter(Boolean).join(' '),
    clientName,
    inboundMessage,
    threadContext,
    threadSummary: threadText(threadContext),
  });
}

function urlsOutside(text, source) {
  const found = String(text || '').match(/https?:\/\/[^\s)]+/g) || [];
  return found.filter((url) => !String(source || '').includes(url.replace(/[.,)]+$/, '')));
}

function promptFor(ctx, sourceText) {
  const system = [
    'Write a short follow-up email Josh can send after leaving a voicemail.',
    'Two to four lines. The spirit is "just left you a voicemail".',
    'Use only facts in the context. Do not invent a city, company size, offer, price, or name.',
    'No sign-off. No markdown. No booking link unless that exact URL is in the context.',
    'Output JSON only: {"draft":"..."}',
  ].join(' ');
  const user = [
    'CONTEXT:',
    sourceText || '(none)',
    '',
    `Lead: ${ctx.leadName || ''}`,
    `Company: ${ctx.company || ''}`,
    `Title: ${ctx.title || ''}`,
    '',
    'Write the email now.',
  ].join('\n');
  return { system, user };
}

function parseDraftJson(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    return String(parsed.draft || parsed.text || parsed.reply || '').trim();
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return text;
    try {
      const parsed = JSON.parse(match[0]);
      return String(parsed.draft || parsed.text || '').trim();
    } catch {
      return text;
    }
  }
}

async function defaultClaudeDraft(ctx, sourceText) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Anthropic is not configured');
  const { anthropicModel } = require('./anthropic-model');
  const { system, user } = promptFor(ctx, sourceText);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: anthropicModel(),
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Anthropic draft failed (${res.status})`);
  let data = {};
  try { data = JSON.parse(body); } catch { data = {}; }
  const blocks = Array.isArray(data.content) ? data.content : [];
  const raw = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  const draft = parseDraftJson(raw);
  if (!draft) throw new Error('Anthropic returned an empty voicemail draft');
  return { text: draft };
}

async function defaultGeminiDraft(ctx, sourceText) {
  if (!process.env.GEMINI_API_KEY) throw new Error('Gemini is not configured');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const { geminiModel } = require('./gemini-model');
  const { system, user } = promptFor(ctx, sourceText);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: geminiModel(),
    systemInstruction: system,
    generationConfig: { maxOutputTokens: 400, temperature: 0.4, responseMimeType: 'application/json' },
  });
  const res = await model.generateContent(user);
  const raw = res.response && typeof res.response.text === 'function' ? res.response.text() : '';
  const draft = parseDraftJson(raw);
  if (!draft) throw new Error('Gemini returned an empty voicemail draft');
  return { text: draft };
}

async function acceptDraft(rawText, sourceText) {
  const { stripSignOff } = require('./classifier');
  const cleaned = stripSignOff(String(rawText || '').trim());
  if (!cleaned) throw new Error('empty draft');
  if (urlsOutside(cleaned, sourceText).length) throw new Error('draft included a url that is not in the thread');
  const checked = await enforceDraftGrounding({ draft: cleaned, sourceText });
  if (!checked.text || checked.needsReview || checked.stripped) {
    throw new Error('draft was not grounded in the thread');
  }
  return checked.text;
}

/**
 * Realtime order for this one interactive draft: Claude, then Gemini, then
 * the short template. Pass `claudeGenerate: null` to skip a provider.
 */
async function draftVoicemailFollowUp({
  leadName,
  company,
  title,
  clientName,
  inboundMessage,
  threadContext,
  claudeGenerate,
  geminiGenerate,
} = {}) {
  const ctx = { leadName, company, title, clientName, inboundMessage, threadContext };
  const sourceText = sourceForDraft(ctx);
  const template = voicemailTemplateText(leadName);

  const tryProvider = async (fn, label) => {
    const result = await fn(ctx, sourceText);
    const text = await acceptDraft(result && result.text ? result.text : result, sourceText);
    return { text, source: label };
  };

  const claude = claudeGenerate === undefined ? defaultClaudeDraft : claudeGenerate;
  const gemini = geminiGenerate === undefined ? defaultGeminiDraft : geminiGenerate;
  if (typeof claude === 'function') {
    try { return await tryProvider(claude, 'claude'); } catch (err) {
      console.warn('[VoicemailEmail] Claude draft skipped', { err: err.message });
    }
  }
  if (typeof gemini === 'function') {
    try { return await tryProvider(gemini, 'gemini'); } catch (err) {
      console.warn('[VoicemailEmail] Gemini draft skipped', { err: err.message });
    }
  }

  let text = template;
  try {
    const checked = await enforceDraftGrounding({ draft: template, sourceText });
    if (checked.text && !checked.needsReview) text = checked.text;
  } catch { /* the template is the last resort */ }
  return { text, source: 'template' };
}

function buildVoicemailEmailModal({ stepId, channel, ts, draft }) {
  const body = String(draft || '').trim().slice(0, 2900);
  return {
    type: 'modal',
    callback_id: VOICEMAIL_MODAL_ID,
    private_metadata: JSON.stringify({ stepId, channel: channel || null, ts: ts || null }),
    title: { type: 'plain_text', text: 'Voicemail follow-up' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Nothing is emailed until you click *Send*. Cancel emails nothing. The voicemail is already logged.',
        },
      },
      {
        type: 'input',
        block_id: DRAFT_BLOCK,
        label: { type: 'plain_text', text: 'Follow-up email' },
        element: {
          type: 'plain_text_input',
          action_id: DRAFT_ACTION,
          multiline: true,
          initial_value: body,
        },
      },
    ],
  };
}

function validateVoicemailEmailSubmission(interaction) {
  const value = interaction?.view?.state?.values?.[DRAFT_BLOCK]?.[DRAFT_ACTION]?.value;
  if (!String(value || '').trim()) {
    return { [DRAFT_BLOCK]: 'Write the email before sending. Cancel sends nothing.' };
  }
  return null;
}

function draftFromSubmission(interaction) {
  return String(interaction?.view?.state?.values?.[DRAFT_BLOCK]?.[DRAFT_ACTION]?.value || '').trim();
}

function metaFromSubmission(interaction) {
  try { return JSON.parse(interaction?.view?.private_metadata || '{}'); } catch { return {}; }
}

/**
 * Open the modal. Does not send. Uses the model draft when it returns inside
 * the budget; otherwise the short template is what he sees and can edit.
 */
async function openFromCallClick({
  step,
  seq,
  interaction,
  dbClient = db,
  slackApi,
  draftBudgetMs = DRAFT_BUDGET_MS,
  claudeGenerate,
  geminiGenerate,
} = {}) {
  if (!interaction?.trigger_id || !step || !seq) return { opened: false, sent: false, reason: 'no_trigger' };
  const { rows: [source] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [seq.source_reply_id]);
  const { rows: [client] } = await dbClient.query('SELECT * FROM clients WHERE id = $1', [seq.client_id]);
  if (!source || !client?.slack_bot_token || !slackApi) return { opened: false, sent: false, reason: 'missing_context' };

  const wait = Number.isFinite(Number(draftBudgetMs)) ? Number(draftBudgetMs) : DRAFT_BUDGET_MS;
  const draftPromise = module.exports.draftVoicemailFollowUp({
    leadName: source.lead_full_name || source.lead_name,
    company: source.lead_company,
    title: source.lead_title,
    clientName: client.name,
    inboundMessage: source.inbound_message,
    threadContext: source.thread_context,
    claudeGenerate,
    geminiGenerate,
  }).catch((err) => {
    console.warn('[VoicemailEmail] draft failed', { err: err.message });
    return null;
  });
  const drafted = await Promise.race([
    draftPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), wait)),
  ]);
  const text = (drafted && drafted.text)
    || voicemailTemplateText(source.lead_full_name || source.lead_name);
  const view = buildVoicemailEmailModal({
    stepId: step.id,
    channel: interaction.channel?.id || step.slack_channel,
    ts: interaction.message?.ts || step.slack_ts,
    draft: text,
  });
  await slackApi.getClient(client.slack_bot_token).views.open({
    trigger_id: interaction.trigger_id,
    view,
  });
  return { opened: true, sent: false, draft: text, source: (drafted && drafted.source) || 'template' };
}

async function releaseClaim(query, stepId, token) {
  await query(
    `UPDATE followup_sequence_steps
        SET payload = (COALESCE(payload, '{}'::jsonb) - 'voicemailEmailClaim'),
            updated_at = now()
      WHERE id = $1
        AND payload->>'voicemailEmailClaim' = $2`,
    [stepId, token]
  );
}

async function noteSent(step, client, slackApi) {
  const channel = step.slack_channel;
  const ts = step.slack_ts;
  if (!slackApi || !client?.slack_bot_token || !channel || !ts) return;
  const payload = parseJson(step.payload) || {};
  if (!payload.card) return;
  try {
    const { buildCallCardBlocks } = require('./followup-sequence');
    await slackApi.getClient(client.slack_bot_token).chat.update({
      channel,
      ts,
      text: 'Voicemail follow-up sent',
      blocks: buildCallCardBlocks(payload.card, step.id, {
        outcome: 'no_answer',
        note: 'Follow-up email sent.',
      }),
    });
  } catch (err) {
    console.warn('[VoicemailEmail] card note failed', { stepId: step.id, err: err.message });
  }
}

/**
 * Modal Send. One email in the same thread, through the reply-send path for
 * the card's platform. A second Send does not send again.
 */
async function handleVoicemailEmailSubmit(interaction, { dbClient = db, slackApi } = {}) {
  const meta = metaFromSubmission(interaction);
  const text = draftFromSubmission(interaction);
  const stepId = meta.stepId;
  if (!stepId || !text) return { sent: false, reason: 'empty' };

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows: [step] } = await dbClient.query(
    `UPDATE followup_sequence_steps
        SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('voicemailEmailClaim', $2::text),
            updated_at = now()
      WHERE id = $1
        AND COALESCE(payload->>'voicemailEmailSentAt', '') = ''
        AND COALESCE(payload->>'voicemailEmailClaim', '') = ''
      RETURNING *`,
    [stepId, token]
  );
  if (!step) return { sent: false, reason: 'already_sent' };

  const fail = async (reason, createdId) => {
    try { await releaseClaim(dbClient.query.bind(dbClient), stepId, token); } catch { /* claim expires only if we clear it */ }
    if (createdId) {
      try {
        await dbClient.query(
          `UPDATE pending_replies SET status = 'failed', send_error = $2, updated_at = now() WHERE id = $1`,
          [createdId, String(reason).slice(0, 500)]
        );
      } catch { /* the send already did not happen */ }
    }
    return { sent: false, reason };
  };

  const { rows: [seq] } = await dbClient.query('SELECT * FROM followup_sequences WHERE id = $1', [step.sequence_id]);
  if (!seq) return fail('missing_sequence');
  const { rows: [source] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [seq.source_reply_id]);
  const { rows: [clientRow] } = await dbClient.query('SELECT * FROM clients WHERE id = $1', [seq.client_id]);
  if (!source || !clientRow) return fail('missing_context');
  const client = withSmartleadKey(clientRow);
  const threadContext = parseJson(source.thread_context);

  let created;
  try {
    const inserted = await dbClient.query(
      `INSERT INTO pending_replies
         (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email,
          linkedin_url, inbound_message, thread_context, classification, draft_reply, status,
          smartlead_email_stats_id, follow_up_source_id, lead_company, lead_full_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'FOLLOW_UP', $11, 'approved', $12, $13, $14, $15)
       RETURNING *`,
      [
        client.id,
        source.platform,
        source.campaign_id,
        source.campaign_name || null,
        source.lead_id,
        source.lead_name,
        source.lead_email,
        source.linkedin_url || null,
        '(voicemail follow-up)',
        JSON.stringify(threadContext || {}),
        text,
        source.smartlead_email_stats_id || null,
        source.id,
        source.lead_company || null,
        source.lead_full_name || source.lead_name || null,
      ]
    );
    created = inserted.rows[0];
  } catch (err) {
    console.warn('[VoicemailEmail] could not store the send row', { stepId, err: err.message });
    return fail('store_failed');
  }
  if (!created) return fail('store_failed');

  try {
    const result = await replySend.sendReplyToPlatform(client, created, text) || {};
    if (result.skippedDuplicate) return fail('skipped_duplicate', created.id);
  } catch (err) {
    console.warn('[VoicemailEmail] send failed', { stepId, err: err.message });
    return fail(err.message || 'send_failed', created.id);
  }

  try {
    await dbClient.query(
      `UPDATE pending_replies SET status = 'sent', sent_reply = $2, updated_at = now() WHERE id = $1`,
      [created.id, text]
    );
    await dbClient.query(
      `UPDATE followup_sequence_steps
          SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('voicemailEmailSentAt', $2::text, 'voicemailEmailReplyId', $3::text),
              updated_at = now()
        WHERE id = $1`,
      [stepId, new Date().toISOString(), String(created.id)]
    );
  } catch (err) {
    console.warn('[VoicemailEmail] sent, but the row was not marked', { stepId, err: err.message });
  }
  await noteSent(step, client, slackApi);
  return { sent: true, platform: source.platform, replyId: created.id };
}

module.exports = {
  VOICEMAIL_MODAL_ID,
  DRAFT_BUDGET_MS,
  voicemailTemplateText,
  draftVoicemailFollowUp,
  buildVoicemailEmailModal,
  validateVoicemailEmailSubmission,
  openFromCallClick,
  handleVoicemailEmailSubmit,
};
