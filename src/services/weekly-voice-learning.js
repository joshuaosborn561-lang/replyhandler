/**
 * Weekly voice learning — the Friday routine.
 *
 * Every Friday (see cron.js) this sweeps the week's replies that Josh actually
 * sent and turns them into two things:
 *
 *   1. Retrieval examples (`reply_examples` in Supabase) so RAG keeps pulling
 *      his real, recent replies — including HeyReach and replies typed straight
 *      into SmartLead / HeyReach that never touched Slack.
 *   2. A synthesized voice profile (`voice_profiles` in Postgres): one global
 *      "how Josh writes" profile and one per client that also carries
 *      client-specific facts (offer, who takes the meeting, modality, names).
 *      `voice-profile.js` injects the latest profiles into every draft prompt.
 *
 * Sources, in order of signal strength:
 *   - Slack EDITED sends: the AI draft vs what Josh actually sent. Strongest.
 *   - Slack APPROVED sends: he accepted the draft as-is — confirms the voice.
 *   - Manual SmartLead replies: SENT messages that directly follow a prospect
 *     REPLY in message-history and are not something we sent from Slack.
 *   - Manual HeyReach replies: our message directly after a prospect message.
 *
 * Hard rules carried over from the rest of the pipeline:
 *   - This is a bulk job. Claude is never called here — Gemini only.
 *   - FOLLOW_UP bumps and placeholder inbounds are never learned.
 *   - Every external failure is logged and skipped; the job never throws out.
 */
const db = require('../db');
const smartlead = require('./smartlead');
const heyreach = require('./heyreach');
const replyExamples = require('./reply-examples');
const { fetchInboxReplies } = require('./smartlead-poller');
const { isFollowUpPlaceholder } = require('../utils/reply-ordinal');
const {
  stripHtmlToText,
  stripEmailQuotePrefix,
  cleanInboundReply,
} = require('../utils/smartlead-webhook-helpers');
const voiceProfile = require('./voice-profile');

const DEFAULT_LOOKBACK_HOURS = 8 * 24; // a week plus a day of overlap; upserts are idempotent
const DEDUPE_SLICE = 120;
const CONTEXT_MESSAGES = 6;
const PROFILE_MODEL = process.env.VOICE_LEARNING_MODEL || 'gemini-2.5-flash';

function numberEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupeKey(s) {
  return normText(s).slice(0, DEDUPE_SLICE);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Outbound cleaning ───────────────────────────────────────────────────

const SIGNATURE_LINE = /(\+?\d[\d\s().-]{8,}\d)|(https?:\/\/|www\.)|(\S+@\S+\.\S+)|(\s\|\s)|^(ceo|founder|co-founder|president|owner|director|manager|vp|chief|head of)\b/i;
const CLOSING_LINE = /^(best|best regards|kind regards|warm regards|regards|thanks|thanks again|thank you|cheers|talk soon|speak soon|sincerely|all the best|appreciate it|looking forward)[,!.]?\s*(\w+)?$/i;
const NAME_LINE = /^[A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.&-]*){0,2}$/u;

/**
 * Manual SmartLead replies carry the mailbox signature and often a closing
 * line. Drafts never include either (the mailbox appends the signature on
 * send), so strip them before the text becomes a voice example.
 */
function stripTrailingSignature(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');

  const sep = lines.findIndex((l) => /^--\s*$/.test(l.trim()));
  if (sep > 0) lines.splice(sep);

  const popBlank = () => { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); };

  popBlank();
  let poppedSig = 0;
  while (lines.length > 1 && SIGNATURE_LINE.test(lines[lines.length - 1].trim())) {
    lines.pop();
    poppedSig += 1;
    popBlank();
  }
  // Up to three bare name/company lines directly above the signature details.
  for (let i = 0; i < 3 && poppedSig > 0 && lines.length > 1; i += 1) {
    const last = lines[lines.length - 1].trim();
    if (last.length <= 40 && NAME_LINE.test(last)) { lines.pop(); popBlank(); continue; }
    break;
  }
  popBlank();
  // Closing line ("Thanks," / "Best, Josh") and a bare name under it.
  for (let guard = 0; guard < 3 && lines.length > 1; guard += 1) {
    const last = lines[lines.length - 1].trim();
    if (CLOSING_LINE.test(last)) { lines.pop(); popBlank(); continue; }
    if (/^[-–—]\s*[A-Z][\p{L}'’.-]*$/u.test(last)) { lines.pop(); popBlank(); continue; }
    if (lines.length > 1 && last.length <= 40 && NAME_LINE.test(last) && last.split(/\s+/).length <= 2) {
      lines.pop(); popBlank(); continue;
    }
    break;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanOutboundReply(raw) {
  let t = stripHtmlToText(raw) || String(raw || '');
  t = stripEmailQuotePrefix(t);
  t = t.replace(/\[cid:[^\]]+\]/gi, ' ');
  t = stripTrailingSignature(t);
  return t.trim();
}

// ─── SmartLead pairing ───────────────────────────────────────────────────

function historyRows(historyResponse) {
  const list = Array.isArray(historyResponse?.history)
    ? historyResponse.history
    : Array.isArray(historyResponse?.messages)
      ? historyResponse.messages
      : Array.isArray(historyResponse) ? historyResponse : [];
  const rows = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || m.direction || '').toUpperCase();
    const kind = type === 'SENT' || type === 'OUTBOUND' ? 'SENT'
      : type === 'REPLY' || type === 'INBOUND' ? 'REPLY' : null;
    if (!kind) continue;
    const timeRaw = m.time || m.sent_at || m.received_at || m.created_at || '';
    const time = Date.parse(timeRaw);
    rows.push({
      kind,
      time: Number.isFinite(time) ? time : 0,
      body: m.email_body || m.body || m.text || '',
      id: m.stats_id || m.email_stats_id || m.message_id || m.id || null,
      seq: m.email_seq_number ?? m.seq_number ?? m.sequence_number ?? null,
    });
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

/**
 * Manual reply = a SENT message whose immediately preceding message in the
 * thread is a prospect REPLY. Scheduled sequence steps follow our own SENT
 * messages (or nothing), so they never pair. Structural, not phrase-based.
 */
function smartleadManualPairs(historyResponse, { sinceMs = 0, untilMs = Infinity } = {}) {
  const rows = historyRows(historyResponse);
  const pairs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cur = rows[i];
    const prev = rows[i - 1];
    if (cur.kind !== 'SENT' || prev.kind !== 'REPLY') continue;
    if (cur.time && (cur.time < sinceMs || cur.time > untilMs)) continue;

    const inbound = cleanInboundReply(prev.body);
    const outbound = cleanOutboundReply(cur.body);
    if (!inbound || !outbound || outbound.length < 8) continue;
    if (isFollowUpPlaceholder(inbound)) continue;

    const context = rows.slice(Math.max(0, i - CONTEXT_MESSAGES), i).map((r) => ({
      direction: r.kind === 'SENT' ? 'outbound' : 'inbound',
      body: (r.kind === 'SENT' ? cleanOutboundReply(r.body) : cleanInboundReply(r.body)).slice(0, 1500),
    }));

    pairs.push({
      sourceId: cur.id ? `smartlead:${cur.id}` : null,
      inbound,
      outbound,
      context,
      sentAt: cur.time ? new Date(cur.time).toISOString() : null,
    });
  }
  return pairs;
}

// ─── HeyReach pairing ────────────────────────────────────────────────────

function hrText(m) {
  if (!m || typeof m !== 'object') return '';
  return String(m.message || m.body || m.text || m.content || '').trim();
}

function hrTime(m) {
  const raw = m?.createdAt || m?.creation_time || m?.created_at || m?.time || m?.timestamp || '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

function hrIsOutbound(m) {
  if (!m || typeof m !== 'object') return false;
  const sender = String(m.sender || m.from || m.role || '').toUpperCase();
  if (sender === 'ME' || sender === 'US' || sender === 'USER') return true;
  if (m.is_reply === false || m.isReply === false) return true;
  return false;
}

function hrIsInbound(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.is_reply === true || m.isReply === true) return true;
  const sender = String(m.sender || m.from || m.role || '').toUpperCase();
  return Boolean(sender) && !hrIsOutbound(m);
}

function heyreachConversationMessages(conv) {
  for (const c of [conv?.messages, conv?.recent_messages, conv?.recentMessages, conv?.conversationHistory, conv?.thread]) {
    if (Array.isArray(c)) return [...c].sort((a, b) => hrTime(a) - hrTime(b));
  }
  return [];
}

function heyreachManualPairs(messages, { sinceMs = 0, untilMs = Infinity, conversationId = null } = {}) {
  const pairs = [];
  for (let i = 1; i < messages.length; i += 1) {
    const cur = messages[i];
    const prev = messages[i - 1];
    if (!hrIsOutbound(cur) || !hrIsInbound(prev)) continue;
    const t = hrTime(cur);
    if (t && (t < sinceMs || t > untilMs)) continue;
    const inbound = hrText(prev);
    const outbound = hrText(cur);
    if (!inbound || !outbound || outbound.length < 4) continue;
    if (isFollowUpPlaceholder(inbound)) continue;

    const context = messages.slice(Math.max(0, i - CONTEXT_MESSAGES), i).map((m) => ({
      direction: hrIsOutbound(m) ? 'outbound' : 'inbound',
      body: hrText(m).slice(0, 1500),
    }));
    const msgId = cur.id || cur.messageId || cur.message_id || (t ? String(t) : null);
    pairs.push({
      sourceId: msgId ? `heyreach:${conversationId || 'conv'}:${msgId}` : null,
      inbound,
      outbound,
      context,
      sentAt: t ? new Date(t).toISOString() : null,
    });
  }
  return pairs;
}

// ─── Filters shared by both manual sources ───────────────────────────────

/**
 * Same outbound text, allowing for the two renderings to differ in the tail
 * (mailbox signature, name line, HTML→text). Mirrors reply-dedupe: shared
 * leading slice with prefix containment either way; short texts need equality.
 */
function sameOutbound(a, b) {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = shorter === na ? nb : na;
  if (shorter.length < 40) return false;
  return longer.startsWith(shorter.slice(0, DEDUPE_SLICE));
}

/** Already learned via Slack: the same text we sent from an approval card. */
function excludeSlackSent(pairs, slackSentTexts) {
  if (!slackSentTexts || !slackSentTexts.size) return pairs;
  const sent = [...slackSentTexts];
  return pairs.filter((p) => !sent.some((s) => sameOutbound(s, p.outbound)));
}

/**
 * The same outbound text in two or more different threads is a template or a
 * sequence step that slipped past the structural rule, not a hand-typed reply.
 */
function dropRepeatedOutbounds(pairs) {
  const threadsPerText = new Map();
  for (const p of pairs) {
    const k = dedupeKey(p.outbound);
    if (!threadsPerText.has(k)) threadsPerText.set(k, new Set());
    threadsPerText.get(k).add(p.threadKey || p.sourceId || Math.random());
  }
  return pairs.filter((p) => threadsPerText.get(dedupeKey(p.outbound)).size <= 1);
}

// ─── Data access ─────────────────────────────────────────────────────────

async function hasColumn(table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

async function hasTable(table) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows.length > 0;
}

async function loadClients() {
  const { rows } = await db.query(
    `SELECT id, name, voice_prompt, smartlead_api_key, heyreach_api_key
       FROM clients
      WHERE active IS DISTINCT FROM false
      ORDER BY name`
  );
  return rows;
}

/** Slack-approved / edited sends in the window, both platforms. */
async function loadSlackSentRows({ sinceIso, withOriginalDraft }) {
  const originalCol = withOriginalDraft ? 'original_draft' : 'NULL::text AS original_draft';
  const { rows } = await db.query(
    `SELECT id, client_id, platform, campaign_id, lead_id, lead_email, lead_name,
            inbound_message, thread_context, classification, sent_reply, draft_reply,
            ${originalCol}, updated_at
       FROM pending_replies
      WHERE status = 'sent'
        AND sent_reply IS NOT NULL
        AND trim(sent_reply) <> ''
        AND updated_at >= $1
        AND COALESCE(campaign_id, '') <> 'test-campaign'
      ORDER BY updated_at ASC`,
    [sinceIso]
  );
  return rows;
}

/** Classification lookup for manual pairs: normalized inbound slice → label. */
async function loadClassificationIndex(clientId, { sinceIso }) {
  const { rows } = await db.query(
    `SELECT platform, lead_id, inbound_message, classification
       FROM pending_replies
      WHERE client_id = $1
        AND created_at >= $2::timestamptz - interval '30 days'`,
    [clientId, sinceIso]
  );
  const byText = new Map();
  const byLead = new Map();
  for (const r of rows) {
    const k = dedupeKey(r.inbound_message);
    if (k && !byText.has(k)) byText.set(k, r.classification);
    if (r.lead_id) byLead.set(`${r.platform}:${r.lead_id}`, r.classification);
  }
  return {
    lookup(platform, leadId, inbound) {
      return byText.get(dedupeKey(inbound))
        || (leadId ? byLead.get(`${platform}:${leadId}`) : null)
        || null;
    },
  };
}

// ─── Learning into RAG ───────────────────────────────────────────────────

function serializeContext(ctx) {
  if (!ctx) return null;
  if (typeof ctx === 'string') return ctx.slice(0, 20000);
  try { return JSON.stringify(ctx).slice(0, 20000); } catch { return null; }
}

async function upsertExample(pair, { client, platform, dryRun }) {
  if (!replyExamples.isConfigured()) return { skipped: 'not_configured' };
  if (String(pair.classification || '').toUpperCase() === 'FOLLOW_UP') return { skipped: 'follow_up' };
  if (isFollowUpPlaceholder(pair.inbound)) return { skipped: 'placeholder_inbound' };
  if (dryRun) return { inserted: false, dryRun: true };
  return replyExamples.insertReplyExample({
    sourceMessageId: pair.sourceId || undefined,
    pendingReplyId: pair.pendingReplyId || undefined,
    leadMessage: pair.inbound,
    myReply: pair.outbound,
    threadContext: serializeContext(pair.context),
    category: pair.classification || null,
    clientName: client?.name || null,
    vertical: null,
    platform,
    sequenceNumber: null,
  });
}

// ─── Profile synthesis (Gemini only — this is a bulk job) ────────────────

function describePair(p, index) {
  const parts = [
    `[${index + 1}] source=${p.source} platform=${p.platform}${p.classification ? ` classification=${p.classification}` : ''}`,
    `Prospect: ${String(p.inbound).slice(0, 1200)}`,
  ];
  if (p.source === 'slack_edited' && p.originalDraft) {
    parts.push(`AI draft before Josh edited it: ${String(p.originalDraft).slice(0, 1200)}`);
  }
  parts.push(`Josh sent: ${String(p.outbound).slice(0, 1200)}`);
  return parts.join('\n');
}

function buildProfilePrompt({ scope, client, pairs, previousProfile }) {
  const header = scope === 'global'
    ? 'Scope: GLOBAL — how Josh writes across every client. Do not output client_notes (leave it an empty array).'
    : `Scope: CLIENT — ${client.name}. Configured voice prompt for this client: ${String(client.voice_prompt || '').trim() || '(none)'}`;

  return [
    'You maintain a compact style profile of Josh, who sends short B2B outbound replies. Below are replies he ACTUALLY SENT this week, with the prospect message each one answered. Some were edited from an AI draft — the difference between the AI draft and what Josh sent is the strongest evidence of his voice; weight it heavily.',
    '',
    header,
    '',
    'PREVIOUS PROFILE (refine it; keep what still holds, drop what this week contradicts, add what is new):',
    previousProfile ? JSON.stringify(previousProfile) : '(none yet)',
    '',
    `THIS WEEK'S REPLIES (${pairs.length}):`,
    ...pairs.map(describePair),
    '',
    'Return STRICT JSON with exactly these keys:',
    '{"voice_rules": string[], "client_notes": string[], "signature_phrases": string[], "avoid": string[]}',
    '',
    'Rules:',
    '- voice_rules: at most 10, each under 160 characters, concrete and observable (openers, typical length, humor, how he handles objections and questions, how he closes, punctuation habits like "..." instead of dashes). Prioritize what Josh changed in edits.',
    '- client_notes: at most 10 facts specific to this client that recur in Josh\'s own sent replies — the offer, who takes the meeting, meeting modality (call vs in person), named teammates, pricing stance, what he declines to do. Only facts that appear in his sent text. Never guess. For GLOBAL scope return [].',
    '- signature_phrases: at most 8 short phrases he uses verbatim.',
    '- avoid: at most 6 things the AI drafts did that Josh removed, or that he never does.',
    '- Never include URLs, email addresses, or phone numbers in any item.',
    '- Do not contradict these fixed rules: acknowledge what the prospect said before any CTA; no sign-off or signature in drafts; booking link only when the prospect asks for it.',
    '- Output JSON only. No markdown, no commentary.',
  ].join('\n');
}

function parseProfileJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callGeminiJson(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: PROFILE_MODEL,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    },
  });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await model.generateContent(prompt);
      return res.response.text();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (!/503|502|504|429|timeout|unavailable|overloaded/i.test(msg) || attempt === 2) throw err;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

function selectPairsForProfile(pairs, cap) {
  const weight = (p) => (p.source === 'slack_edited' ? 0 : p.source.startsWith('manual') ? 1 : 2);
  return [...pairs]
    .sort((a, b) => weight(a) - weight(b) || String(b.sentAt || '').localeCompare(String(a.sentAt || '')))
    .slice(0, cap);
}

async function synthesizeProfile({ scope, client = null, pairs, previousProfile }) {
  const cap = numberEnv('VOICE_LEARNING_PROFILE_MAX_EXAMPLES', scope === 'global' ? 60 : 40);
  const selected = selectPairsForProfile(pairs, cap);
  const prompt = buildProfilePrompt({ scope, client, pairs: selected, previousProfile });
  const raw = await callGeminiJson(prompt);
  const parsed = parseProfileJson(raw);
  if (!parsed) throw new Error('Gemini profile response was not valid JSON');
  const profile = voiceProfile.sanitizeProfile(parsed, { scope });
  if (voiceProfile.profileIsEmpty(profile)) throw new Error('Gemini profile came back empty');
  return { profile, examplesUsed: selected.length };
}

function weekEndingDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function latestProfile(scope, clientId) {
  const { rows } = await db.query(
    `SELECT profile FROM voice_profiles
      WHERE scope = $1 AND (($1 = 'global') OR client_id = $2)
      ORDER BY week_ending DESC, created_at DESC LIMIT 1`,
    [scope, clientId || null]
  );
  return rows[0]?.profile || null;
}

async function storeProfile({ scope, clientId, profile, pairs, examplesUsed, weekEnding }) {
  const edited = pairs.filter((p) => p.source === 'slack_edited').length;
  const manual = pairs.filter((p) => p.source.startsWith('manual')).length;
  await db.query(
    `INSERT INTO voice_profiles (scope, client_id, week_ending, profile, examples_used, edited_used, manual_used, model)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (scope, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), week_ending)
     DO UPDATE SET profile = EXCLUDED.profile,
                   examples_used = EXCLUDED.examples_used,
                   edited_used = EXCLUDED.edited_used,
                   manual_used = EXCLUDED.manual_used,
                   model = EXCLUDED.model,
                   created_at = now()`,
    [scope, clientId || null, weekEnding, JSON.stringify(profile), examplesUsed, edited, manual, PROFILE_MODEL]
  );
}

// ─── Collection per source ───────────────────────────────────────────────

async function collectSlackPairs({ clientsById, sinceIso, withOriginalDraft, summary }) {
  const rows = await loadSlackSentRows({ sinceIso, withOriginalDraft });
  const pairs = [];
  for (const r of rows) {
    const client = clientsById.get(r.client_id);
    if (!client) continue;
    summary.slack.scanned += 1;
    if (String(r.classification || '').toUpperCase() === 'FOLLOW_UP') { summary.slack.skippedFollowUp += 1; continue; }
    if (isFollowUpPlaceholder(r.inbound_message)) { summary.slack.skippedPlaceholder += 1; continue; }
    const edited = Boolean(r.original_draft) && normText(r.original_draft) !== normText(r.sent_reply);
    pairs.push({
      source: edited ? 'slack_edited' : 'slack_approved',
      platform: r.platform,
      clientId: r.client_id,
      pendingReplyId: String(r.id),
      sourceId: null,
      leadId: r.lead_id,
      inbound: r.inbound_message,
      outbound: r.sent_reply,
      originalDraft: edited ? r.original_draft : null,
      context: r.thread_context,
      classification: r.classification || null,
      sentAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      threadKey: `${r.platform}:${r.campaign_id || ''}:${r.lead_id || ''}`,
    });
    if (edited) summary.slack.edited += 1; else summary.slack.approved += 1;
  }
  return pairs;
}

function slackSentKeysByClient(slackPairs) {
  const map = new Map();
  for (const p of slackPairs) {
    if (!map.has(p.clientId)) map.set(p.clientId, new Set());
    map.get(p.clientId).add(normText(p.outbound));
  }
  return map;
}

async function collectSmartleadManualPairs(client, { sinceMs, sinceIso, slackKeys, summary }) {
  if (!client.smartlead_api_key) return [];
  const pageLimit = Math.min(numberEnv('VOICE_LEARNING_SL_PAGE_LIMIT', 20), 20);
  const maxRows = numberEnv('VOICE_LEARNING_SL_MAX_THREADS', 150);
  const delayMs = numberEnv('VOICE_LEARNING_SL_DELAY_MS', 400);
  const classIndex = await loadClassificationIndex(client.id, { sinceIso });

  let candidates = [];
  let scanned = 0;
  for (let offset = 0; scanned < maxRows; offset += pageLimit) {
    let payload;
    try {
      payload = await fetchInboxReplies(client.smartlead_api_key, offset, pageLimit);
    } catch (err) {
      summary.errors.push(`smartlead inbox ${client.name}: ${err.message}`);
      break;
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!rows.length) break;
    let sawOlder = false;
    for (const row of rows) {
      if (scanned >= maxRows) break;
      scanned += 1;
      const lastReply = Date.parse(row?.last_reply_time || row?.lastReplyTime || '');
      if (Number.isFinite(lastReply) && lastReply < sinceMs - 7 * 24 * 3600 * 1000) {
        // Sorted by reply time desc; once we are far past the window, stop paging.
        sawOlder = true;
      }
      const leadId = row?.email_lead_id || row?.emailLeadId || row?.sl_email_lead_id || null;
      const campaignId = row?.email_campaign_id || row?.emailCampaignId || null;
      const hist = { history: Array.isArray(row?.email_history) ? row.email_history : [] };
      const pairs = smartleadManualPairs(hist, { sinceMs });
      for (const p of pairs) {
        candidates.push({
          ...p,
          source: 'manual_smartlead',
          platform: 'smartlead',
          clientId: client.id,
          leadId: leadId != null ? String(leadId) : null,
          threadKey: `smartlead:${campaignId || ''}:${leadId || ''}`,
          classification: classIndex.lookup('smartlead', leadId != null ? String(leadId) : null, p.inbound),
        });
      }
    }
    summary.smartlead.threadsScanned += rows.length;
    if (rows.length < pageLimit || sawOlder) break;
    await sleep(delayMs);
  }

  const before = candidates.length;
  candidates = excludeSlackSent(candidates, slackKeys);
  summary.smartlead.excludedSlackSent += before - candidates.length;
  const beforeRepeat = candidates.length;
  candidates = dropRepeatedOutbounds(candidates);
  summary.smartlead.excludedRepeated += beforeRepeat - candidates.length;
  summary.smartlead.pairs += candidates.length;
  return candidates;
}

async function collectHeyreachManualPairs(client, { sinceMs, sinceIso, slackKeys, summary }) {
  if (!client.heyreach_api_key) return [];
  const limit = 50;
  const maxConversations = numberEnv('VOICE_LEARNING_HR_MAX_CONVERSATIONS', 300);
  const classIndex = await loadClassificationIndex(client.id, { sinceIso });

  let candidates = [];
  let scanned = 0;
  for (let offset = 0; scanned < maxConversations; offset += limit) {
    let payload;
    try {
      payload = await heyreach.getConversations(client.heyreach_api_key, { offset, limit });
    } catch (err) {
      summary.errors.push(`heyreach conversations ${client.name}: ${err.message}`);
      break;
    }
    const items = payload?.items || payload?.data || payload?.conversations || [];
    if (!Array.isArray(items) || !items.length) break;
    for (const conv of items) {
      if (scanned >= maxConversations) break;
      scanned += 1;
      const convId = conv?.id || conv?.conversationId || conv?.conversation_id || null;
      const leadId = conv?.leadId || conv?.lead_id || conv?.lead?.id || conv?.correspondentProfile?.id || null;
      const messages = heyreachConversationMessages(conv);
      const pairs = heyreachManualPairs(messages, { sinceMs, conversationId: convId });
      for (const p of pairs) {
        candidates.push({
          ...p,
          source: 'manual_heyreach',
          platform: 'heyreach',
          clientId: client.id,
          leadId: leadId != null ? String(leadId) : (convId != null ? String(convId) : null),
          threadKey: `heyreach:${convId || leadId || ''}`,
          classification: classIndex.lookup('heyreach', leadId != null ? String(leadId) : (convId != null ? String(convId) : null), p.inbound),
        });
      }
    }
    summary.heyreach.conversationsScanned += items.length;
    if (items.length < limit) break;
  }

  const before = candidates.length;
  candidates = excludeSlackSent(candidates, slackKeys);
  summary.heyreach.excludedSlackSent += before - candidates.length;
  const beforeRepeat = candidates.length;
  candidates = dropRepeatedOutbounds(candidates);
  summary.heyreach.excludedRepeated += beforeRepeat - candidates.length;
  summary.heyreach.pairs += candidates.length;
  return candidates;
}

// ─── Orchestration ───────────────────────────────────────────────────────

function emptySummary(lookbackHours) {
  return {
    lookbackHours,
    clients: 0,
    slack: { scanned: 0, approved: 0, edited: 0, skippedFollowUp: 0, skippedPlaceholder: 0 },
    smartlead: { threadsScanned: 0, pairs: 0, excludedSlackSent: 0, excludedRepeated: 0 },
    heyreach: { conversationsScanned: 0, pairs: 0, excludedSlackSent: 0, excludedRepeated: 0 },
    rag: { upserted: 0, skipped: 0, failed: 0, configured: replyExamples.isConfigured() },
    profiles: { clientsUpdated: [], clientsSkippedTooFew: [], globalUpdated: false, failed: [] },
    errors: [],
    ms: 0,
  };
}

let running = false;

async function runWeeklyVoiceLearning({
  lookbackHours = numberEnv('VOICE_LEARNING_LOOKBACK_HOURS', DEFAULT_LOOKBACK_HOURS),
  dryRun = false,
  trigger = 'cron',
  now = new Date(),
} = {}) {
  if (running) {
    console.log('[VoiceLearning] Previous run still active; skipping');
    return { skipped: 'already_running' };
  }
  running = true;
  const started = Date.now();
  const summary = emptySummary(lookbackHours);
  let runId = null;

  try {
    const tablesReady = await hasTable('voice_profiles');
    if (!tablesReady) {
      summary.errors.push('voice_profiles table missing — run migrations/025_voice_profiles.sql');
    }
    if (tablesReady && await hasTable('voice_learning_runs')) {
      try {
        const { rows } = await db.query(
          `INSERT INTO voice_learning_runs (lookback_hours, trigger, dry_run) VALUES ($1, $2, $3) RETURNING id`,
          [lookbackHours, trigger, dryRun]
        );
        runId = rows[0]?.id || null;
      } catch (err) {
        summary.errors.push(`run log: ${err.message}`);
      }
    }

    const sinceMs = now.getTime() - lookbackHours * 3600 * 1000;
    const sinceIso = new Date(sinceMs).toISOString();
    const withOriginalDraft = await hasColumn('pending_replies', 'original_draft');

    const clients = await loadClients();
    summary.clients = clients.length;
    const clientsById = new Map(clients.map((c) => [c.id, c]));

    // 1. Slack approved + edited (both platforms).
    const slackPairs = await collectSlackPairs({ clientsById, sinceIso, withOriginalDraft, summary });
    const slackKeys = slackSentKeysByClient(slackPairs);

    // 2 + 3. Manual replies typed straight into SmartLead / HeyReach.
    const manualPairs = [];
    for (const client of clients) {
      try {
        manualPairs.push(...await collectSmartleadManualPairs(client, {
          sinceMs, sinceIso, slackKeys: slackKeys.get(client.id), summary,
        }));
      } catch (err) {
        summary.errors.push(`smartlead ${client.name}: ${err.message}`);
      }
      try {
        manualPairs.push(...await collectHeyreachManualPairs(client, {
          sinceMs, sinceIso, slackKeys: slackKeys.get(client.id), summary,
        }));
      } catch (err) {
        summary.errors.push(`heyreach ${client.name}: ${err.message}`);
      }
    }

    const allPairs = [...slackPairs, ...manualPairs];

    // 4. Feed RAG. Idempotent on pending_reply_id / source_message_id.
    for (const pair of allPairs) {
      const client = clientsById.get(pair.clientId);
      try {
        const result = await upsertExample(pair, { client, platform: pair.platform, dryRun });
        if (result?.inserted) summary.rag.upserted += 1;
        else summary.rag.skipped += 1;
      } catch (err) {
        summary.rag.failed += 1;
        if (summary.rag.failed <= 5) summary.errors.push(`rag upsert: ${err.message}`);
      }
    }

    // 5. Synthesize profiles — client first, then global.
    const minClient = numberEnv('VOICE_LEARNING_MIN_EXAMPLES', 3);
    const minGlobal = numberEnv('VOICE_LEARNING_MIN_EXAMPLES_GLOBAL', 5);
    const weekEnding = weekEndingDate(now);

    if (tablesReady && process.env.GEMINI_API_KEY) {
      for (const client of clients) {
        const pairs = allPairs.filter((p) => p.clientId === client.id);
        if (pairs.length < minClient) {
          if (pairs.length) summary.profiles.clientsSkippedTooFew.push(`${client.name} (${pairs.length})`);
          continue;
        }
        try {
          const previous = await latestProfile('client', client.id);
          const { profile, examplesUsed } = await synthesizeProfile({ scope: 'client', client, pairs, previousProfile: previous });
          if (!dryRun) {
            await storeProfile({ scope: 'client', clientId: client.id, profile, pairs, examplesUsed, weekEnding });
          }
          summary.profiles.clientsUpdated.push(client.name);
          if (dryRun) summary.profiles[`preview:${client.name}`] = profile;
        } catch (err) {
          summary.profiles.failed.push(`${client.name}: ${err.message}`);
        }
      }

      if (allPairs.length >= minGlobal) {
        try {
          const previous = await latestProfile('global', null);
          const { profile, examplesUsed } = await synthesizeProfile({ scope: 'global', pairs: allPairs, previousProfile: previous });
          if (!dryRun) {
            await storeProfile({ scope: 'global', clientId: null, profile, pairs: allPairs, examplesUsed, weekEnding });
          }
          summary.profiles.globalUpdated = true;
          if (dryRun) summary.profiles['preview:global'] = profile;
        } catch (err) {
          summary.profiles.failed.push(`global: ${err.message}`);
        }
      } else {
        summary.profiles.globalSkippedTooFew = allPairs.length;
      }
    } else if (!process.env.GEMINI_API_KEY) {
      summary.errors.push('GEMINI_API_KEY not configured — profiles not synthesized');
    }

    if (!dryRun) voiceProfile.clearCache();
  } catch (err) {
    summary.errors.push(`fatal: ${err.message}`);
    console.error('[VoiceLearning] Run failed', { err: err.message, stack: err.stack });
  } finally {
    running = false;
    summary.ms = Date.now() - started;
    if (runId) {
      try {
        await db.query(
          `UPDATE voice_learning_runs SET finished_at = now(), summary = $1::jsonb, error = $2 WHERE id = $3`,
          [JSON.stringify(summary), summary.errors.length ? summary.errors.join(' | ').slice(0, 2000) : null, runId]
        );
      } catch (err) {
        console.warn('[VoiceLearning] Could not record run summary', { err: err.message });
      }
    }
    console.log('[VoiceLearning] Weekly run complete', summary);
  }
  return summary;
}

module.exports = {
  DEFAULT_LOOKBACK_HOURS,
  runWeeklyVoiceLearning,
  // exported for tests
  stripTrailingSignature,
  cleanOutboundReply,
  smartleadManualPairs,
  heyreachManualPairs,
  sameOutbound,
  excludeSlackSent,
  dropRepeatedOutbounds,
  dedupeKey,
  buildProfilePrompt,
  parseProfileJson,
  selectPairsForProfile,
  weekEndingDate,
};
