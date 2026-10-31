'use strict';

/**
 * Follow-up card sequence for positive replies.
 *
 * OFF by default (FOLLOWUP_SEQUENCE_ENABLED). Every step is a Slack card in the
 * follow-ups channel that a human clicks. Nothing in this file sends to a lead:
 *  - call cards carry the script + phone and one button per possible outcome
 *  - email cards are ordinary FOLLOW_UP approval cards (Approve & Send, Edit)
 *
 * Timing is BUSINESS days; call cards only come due inside the lead's local
 * call hours. Open times always come from resolveVerifiedSchedulingSlots, the
 * same live-availability path the reply drafts use.
 *
 * Any later inbound reply, a booking, an unsubscribe or a DQ stops the
 * sequence and retires its unsent cards.
 */
const db = require('../db');
const slack = require('./slack');
const { phoneForFollowUp, leadKey } = require('./follow-up-call-reminder');
const { postProspectSlackCard } = require('./slack-reply-post');
const { isPostedSlackTs } = require('./reply-dedupe');
const { resolveVerifiedSchedulingSlots } = require('./scheduling-slots');
const { followUpSlackChannelId } = require('./follow-up-runner');
const { resolveOfferAndProof } = require('./followup-sequence-copy');
const cardCtx = require('../utils/followup-card-context');
const { loadFollowupContext } = require('./followup-card-context');
const { inSendWindow, snapDueToSendWindow } = require('./outbound-follow-up');
const { leadSuppressionReason } = require('./lead-suppression');
const { isLeadClaimed } = require('./client-claimed');
const { looksAlreadyBooked } = require('./booking-check');
const { isSlackTestFixtureReply } = require('./reply-send');
const { prospectBookingLink } = require('../utils/public-booking-link');
const { prefersInPersonMeeting, prefersCallbackCall } = require('../utils/meeting-modality');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');
const time = require('../utils/followup-sequence-time');
const text = require('../utils/followup-sequence-text');
const ghost = require('./ghosted-meetings');
const ghostText = require('../utils/ghosted-meeting-text');

const POSITIVE = new Set(['INTERESTED', 'MEETING_PROPOSED']);
const ENROLL_STATUSES = ['pending', 'approved', 'sending', 'sent', 'flagged'];
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function enabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.FOLLOWUP_SEQUENCE_ENABLED || '').trim());
}

function envMinutes(name, fallback, env = process.env) {
  const n = parseFloat(env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseJson(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

// ─── Enrollment ───────────────────────────────────────────────────────────────

/**
 * Start a sequence for every recent positive reply whose card is posted.
 * Only replies newer than FOLLOWUP_SEQUENCE_MAX_AGE_HOURS (default 6) and
 * FOLLOWUP_SEQUENCE_START (optional ISO) enrol, so turning the flag on never
 * back-fills old leads.
 */
async function enrollNewReplies({ now = new Date(), dbClient = db, env = process.env, limit = 50 } = {}) {
  const maxAgeH = envMinutes('FOLLOWUP_SEQUENCE_MAX_AGE_HOURS', 6, env) || 6;
  const since = new Date(now.getTime() - maxAgeH * HOUR);
  const start = env.FOLLOWUP_SEQUENCE_START ? new Date(env.FOLLOWUP_SEQUENCE_START) : null;
  const floor = start && Number.isFinite(start.getTime()) && start > since ? start : since;

  const { rows } = await dbClient.query(
    `SELECT pr.*, c.name AS client_name, c.digest_timezone AS client_tz
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE upper(pr.classification) IN ('INTERESTED', 'MEETING_PROPOSED')
        AND pr.platform IN ('smartlead', 'heyreach')
        AND pr.status = ANY($1::text[])
        AND pr.slack_message_ts IS NOT NULL
        AND pr.created_at >= $2
        AND c.active IS DISTINCT FROM false
        AND NOT EXISTS (SELECT 1 FROM followup_sequences s WHERE s.source_reply_id = pr.id AND s.origin = 'reply')
      ORDER BY pr.created_at ASC
      LIMIT $3`,
    [ENROLL_STATUSES, floor, limit],
  );

  const out = { enrolled: 0, skipped: 0 };
  for (const reply of rows) {
    if (!isPostedSlackTs(reply.slack_message_ts) || isSlackTestFixtureReply(reply)) { out.skipped++; continue; }
    const key = leadKey({
      clientId: reply.client_id, leadEmail: reply.lead_email,
      linkedinUrl: reply.linkedin_url, leadId: reply.lead_id,
    });
    if (!key) { out.skipped++; continue; }
    const blocked = await stopReasonForLead(reply, { dbClient, includeInbound: false });
    if (blocked) {
      // Remember the decision so we do not re-check this reply every tick.
      await createSequence(reply, key, { now, dbClient, env, stoppedReason: blocked });
      out.skipped++;
      continue;
    }
    const ok = await createSequence(reply, key, { now, dbClient, env });
    if (ok) out.enrolled++; else out.skipped++;
  }
  return out;
}

async function createSequence(reply, key, { now, dbClient = db, env = process.env, stoppedReason = null }) {
  const tz = time.resolveTimeZone(reply.lead_timezone, reply.client_tz);
  let seqId;
  try {
    const { rows } = await dbClient.query(
      `INSERT INTO followup_sequences
         (client_id, source_reply_id, platform, campaign_id, lead_key, lead_name, lead_email,
          linkedin_url, lead_timezone, enrolled_at, status, stop_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source_reply_id, origin) DO NOTHING
       RETURNING id`,
      [reply.client_id, reply.id, reply.platform, reply.campaign_id || null, key,
        reply.lead_name || null, reply.lead_email || null, reply.linkedin_url || null,
        reply.lead_timezone || null, now,
        stoppedReason ? 'stopped' : 'active', stoppedReason],
    );
    seqId = rows[0] && rows[0].id;
  } catch (err) {
    if (err && err.code === '23505') return false; // this lead already has a live sequence
    throw err;
  }
  if (!seqId) return false;
  if (stoppedReason) return false;

  const plan = time.planSequence({ enrolledAt: now, timeZone: tz, env });
  const values = [];
  const params = [];
  plan.forEach((s, i) => {
    const o = i * 6;
    values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`);
    params.push(seqId, s.kind, s.order, s.due, s.skip ? 'skipped' : 'pending', s.skip || '');
  });
  await dbClient.query(
    `INSERT INTO followup_sequence_steps (sequence_id, kind, seq_order, due_at, status, skip_reason)
     SELECT v.sequence_id::uuid, v.kind, v.seq_order::int, v.due_at::timestamptz, v.status,
            NULLIF(v.skip_reason, '')
       FROM (VALUES ${values.join(', ')}) AS v(sequence_id, kind, seq_order, due_at, status, skip_reason)`,
    params,
  );
  return true;
}

// ─── Stop rules ───────────────────────────────────────────────────────────────

/**
 * Why this lead should not be in a sequence right now, or null.
 * `includeInbound` is false at enrollment (the source reply itself is inbound).
 */
async function stopReasonForLead(source, { dbClient = db, includeInbound = true, checkBooked = true, sourceRow = source } = {}) {
  const clientId = source.client_id;
  const keys = {
    platform: source.platform,
    campaignId: source.campaign_id,
    leadId: source.lead_id,
    leadEmail: source.lead_email,
    linkedinUrl: source.linkedin_url,
  };
  // Disqualified in any way we record it, or unsubscribed / Do Not Contact in SmartLead.
  const suppressed = await leadSuppressionReason(
    (await loadClient(clientId, dbClient)) || { id: clientId },
    { ...keys, leadEmail: source.lead_email },
  );
  if (suppressed) return suppressed;
  if (await isLeadClaimed({ leadEmail: source.lead_email, campaignId: source.campaign_id })) return 'client_claimed';
  if (checkBooked) {
    const booked = await looksAlreadyBooked(clientId, {
      platform: source.platform,
      leadEmail: source.lead_email,
      leadName: source.lead_name,
      leadId: source.lead_id,
      since: sourceRow.created_at,
    });
    if (booked) return 'booked';
  }

  if (includeInbound) {
    const email = String(source.lead_email || '').trim().toLowerCase();
    const li = String(source.linkedin_url || '').trim();
    const leadId = source.lead_id != null ? String(source.lead_id) : '';
    const { rows } = await dbClient.query(
      `SELECT 1
         FROM pending_replies pr
        WHERE pr.client_id = $1
          AND pr.id <> $2
          AND upper(pr.classification) <> 'FOLLOW_UP'
          AND pr.created_at > $3
          AND md5(coalesce(pr.inbound_message, '')) <> md5($4)
          AND (
            ($5::text <> '' AND lower(coalesce(pr.lead_email, '')) = $5)
            OR ($6::text <> '' AND pr.linkedin_url = $6)
            OR ($7::text <> '' AND pr.platform = $8 AND coalesce(pr.lead_id, '') = $7)
          )
        LIMIT 1`,
      [clientId, source.id, sourceRow.created_at, String(sourceRow.inbound_message || ''),
        email, li, leadId, source.platform],
    );
    if (rows.length) return 'inbound_reply';
  }
  return null;
}

/** Stop a sequence and retire every card of it that no one has acted on. */
async function stopSequence(seqId, reason, { dbClient = db, slackApi = slack, now = new Date() } = {}) {
  const { rows: [seq] } = await dbClient.query(
    `UPDATE followup_sequences
        SET status = 'stopped', stop_reason = $2, updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id, client_id`,
    [seqId, reason],
  );
  if (!seq) return { stopped: false };

  await dbClient.query(
    `UPDATE followup_sequence_steps
        SET status = 'cancelled', skip_reason = $2, updated_at = now()
      WHERE sequence_id = $1 AND status IN ('pending', 'held', 'posting')`,
    [seqId, `sequence_${reason}`],
  );

  let retired = 0;
  try {
    const { rows: [client] } = await dbClient.query(
      'SELECT slack_bot_token FROM clients WHERE id = $1', [seq.client_id]);
    const { rows: posted } = await dbClient.query(
      `SELECT id, kind, pending_reply_id, slack_channel, slack_ts, outcome
         FROM followup_sequence_steps
        WHERE sequence_id = $1 AND status = 'posted' AND slack_ts IS NOT NULL`,
      [seqId],
    );
    for (const step of posted) {
      let retire = false;
      if (step.pending_reply_id) {
        const { rows: [row] } = await dbClient.query(
          'SELECT status FROM pending_replies WHERE id = $1', [step.pending_reply_id]);
        if (row && ['pending', 'flagged'].includes(row.status)) {
          await dbClient.query(
            `UPDATE pending_replies SET status = 'skipped', updated_at = now()
              WHERE id = $1 AND status IN ('pending', 'flagged')`,
            [step.pending_reply_id],
          );
          retire = true;
        } else if (row && ['meeting_booked', 'disqualified', 'skipped'].includes(row.status)) {
          retire = true; // already closed in the database; close the Slack card too
        }
      } else if (!step.outcome) {
        retire = true;
      }
      if (retire && client && client.slack_bot_token) {
        try {
          await slackApi.updateMessage(
            client.slack_bot_token, step.slack_channel, step.slack_ts,
            `Follow-up sequence stopped (${reason.replace(/_/g, ' ')}). This card is closed.`,
          );
          retired++;
        } catch (err) {
          console.warn('[FollowupSeq] could not close card', { stepId: step.id, err: err.message });
        }
      }
    }
  } catch (err) {
    console.warn('[FollowupSeq] card retirement failed', { seqId, err: err.message });
  }
  console.log('[FollowupSeq] Sequence stopped', { seqId, reason, retiredCards: retired });
  return { stopped: true, retired };
}

/** Called by Meeting booked / DQ handlers so the stop is immediate. Never throws. */
async function stopSequencesForLead(reply, reason, { dbClient = db, slackApi = slack } = {}) {
  try {
    if (!reply) return 0;
    const key = leadKey({
      clientId: reply.client_id, leadEmail: reply.lead_email,
      linkedinUrl: reply.linkedin_url, leadId: reply.lead_id,
    });
    const { rows } = await dbClient.query(
      `SELECT id FROM followup_sequences
        WHERE status = 'active' AND (source_reply_id = $1 OR ($2::text <> '' AND lead_key = $2))`,
      [reply.id, key || ''],
    );
    for (const r of rows) await stopSequence(r.id, reason, { dbClient, slackApi });
    return rows.length;
  } catch (err) {
    console.warn('[FollowupSeq] stopSequencesForLead failed', { err: err.message });
    return 0;
  }
}

// ─── Posting ──────────────────────────────────────────────────────────────────

function leadLocalTime(now, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(now);
  } catch { return ''; }
}

/** Clock on the card: "8:08 AM local". */
function leadClock(now, tz) {
  try {
    const t = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Chicago', hour: 'numeric', minute: '2-digit',
    }).format(now);
    return `${t} local`;
  } catch { return ''; }
}

const NEXT_HINT = {
  call_day0: 'Next: follow-up email if no answer',
  call_day0_late: 'Next: follow-up email if no answer',
  email_vm: 'Next: call if no reply',
  call_day1: 'Next: follow-up email',
  email_day1: 'Next: call',
  call_day3: 'Next: proof email',
  email_proof: 'Next: thoughts email',
  email_thoughts: 'Next: breakup email',
  email_breakup: 'Next: last call',
  call_day6: 'Last step',
  ghost_email: 'Next: call if no reply',
  ghost_call: 'Next: follow-up email',
  ghost_email_2: 'Next: breakup email',
};

/**
 * One button per thing that can happen on a call. There is no bare "Connected":
 * if you spoke to them, you pick what they said.
 */
const OUTCOME_BUTTONS = [
  { actionId: 'fseq_booked', outcome: 'booked', text: '📅 Meeting booked', style: 'primary' },
  { actionId: 'fseq_no_answer', outcome: 'no_answer', text: '📵 No answer / left voicemail' },
  { actionId: 'fseq_not_interested', outcome: 'not_interested', text: '🚫 Spoke to them: not interested', style: 'danger' },
  { actionId: 'fseq_call_back', outcome: 'call_back', text: '🔁 Spoke to them: call back later' },
  { actionId: 'fseq_wrong_number', outcome: 'wrong_number', text: '❌ Wrong number' },
];

const OUTCOME_LABELS = {
  booked: '📅 Meeting booked',
  no_answer: '📵 No answer / left voicemail',
  not_interested: '🚫 Spoke to them: not interested (follow-ups stopped)',
  call_back: '🔁 Spoke to them: call back later',
  wrong_number: '❌ Wrong number (no more call cards for this lead)',
};

/** Pure: the Slack blocks for a call card. An outcome closes the outcome buttons. */
function buildCallCardBlocks(card, stepId, state = {}) {
  const layout = require('../utils/followup-card-layout');
  const view = card || {};
  const ctx = view.context || {};
  const stopped = state.stopped || null;
  const outcome = state.outcome || null;
  const statusLine = state.statusLine
    || (stopped ? `Sequence stopped (${String(stopped).replace(/_/g, ' ')})` : '')
    || (outcome ? (OUTCOME_LABELS[outcome] || String(outcome).replace(/_/g, ' ')) : '');
  return layout.buildSequenceCard({
    variant: 'call',
    kind: view.kind,
    stepId,
    sourceReplyId: view.sourceReplyId || null,
    replyId: view.sourceReplyId || null,
    mention: view.mention || null,
    campaign: view.campaignDisplay || view.campaign || ctx.campaign || null,
    leadName: view.leadName,
    title: view.title || (ctx.lead && ctx.lead.title) || null,
    company: view.company || (ctx.lead && ctx.lead.company) || null,
    phone: view.phone,
    email: view.email || (ctx.lead && ctx.lead.email) || null,
    linkedinUrl: view.linkedinUrl || null,
    localTime: view.localTime || null,
    enrichmentReceipt: view.enrichmentReceipt || null,
    icp: view.icp || ctx.icp || null,
    script: view.script,
    voicemail: view.voicemail,
    scriptParts: view.scriptParts || null,
    theirText: view.theirText || ctx.reply || null,
    theirAt: view.theirAt || null,
    tz: view.tz || null,
    why: view.why || null,
    permalink: view.permalink || (ctx.links && ctx.links.replyCard) || null,
    smartleadUrl: view.smartleadUrl || (ctx.links && ctx.links.smartlead) || null,
    platform: view.platform || null,
    claimedBy: view.claimedBy || null,
    nextHint: view.nextHint || (view.kind && NEXT_HINT[view.kind]) || null,
    replaces: view.replaces || null,
    context: ctx,
  }, {
    outcome,
    outcomeBy: state.outcomeBy || null,
    stopped,
    superseded: Boolean(state.superseded),
    supersededPermalink: state.supersededPermalink || null,
    statusLine: statusLine || null,
    note: state.note || null,
  });
}

async function loadClient(clientId, dbClient = db) {
  const { rows: [c] } = await dbClient.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  if (!c) return null;
  try {
    return require('./campaign-routing').withSmartleadKey(c);
  } catch {
    return c;
  }
}

async function setStep(stepId, fields, dbClient = db) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await dbClient.query(
    `UPDATE followup_sequence_steps SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
    [stepId, ...keys.map((k) => (k === 'payload' ? JSON.stringify(fields[k]) : fields[k]))],
  );
}

async function offerFor(client, source, deps = {}) {
  try {
    const r = await (deps.resolveCopy || resolveOfferAndProof)({
      client,
      campaignId: source.campaign_id,
      platform: source.platform,
      threadContext: parseJson(source.thread_context),
    });
    // Config first (manual row, then the client's ICP offer), campaign copy last.
    // No offer anywhere: offerLine stays empty and the line is left out of the card.
    const picked = cardCtx.pickOffer({
      manualOffer: r.source === 'manual' ? r.offerLine : null,
      icpProfile: client.icp_profile,
      copyOffer: r.offerLine,
    });
    return { ...r, offerLine: picked.text || null, offerSource: picked.source };
  } catch (err) {
    console.warn('[FollowupSeq] offer lookup failed', { err: err.message });
    return { offerLine: null, proofPoint: null, source: 'error' };
  }
}

/** @returns {'posted'|'skipped'|'wait'} */
async function postCallStep({ step, seq, client, source, now, tz, dbClient = db, slackApi = slack, env = process.env, deps = {} }) {
  if (!time.inCallWindow(now, tz, env)) {
    await setStep(step.id, { due_at: time.nextCallWindowStart(now, tz, env), status: 'pending' }, dbClient);
    return 'wait';
  }
  const found = await phoneForFollowUp(dbClient, {
    clientId: client.id, sourceReplyId: source.id,
    leadEmail: source.lead_email, linkedinUrl: source.linkedin_url,
  });
  if (!found.phone) {
    const enriching = !source.phone_enrichment_status || source.phone_enrichment_status === 'processing';
    const ageMin = (now.getTime() - new Date(source.created_at).getTime()) / MIN;
    if (step.kind === 'call_day0' && enriching && ageMin < envMinutes('FOLLOWUP_PHONE_WAIT_MINUTES', 10, env)) {
      await setStep(step.id, { due_at: new Date(now.getTime() + 2 * MIN), status: 'pending' }, dbClient);
      return 'wait';
    }
    await setStep(step.id, { status: 'skipped', skip_reason: 'no_phone' }, dbClient);
    return 'skipped';
  }

  const { offerLine, proofPoint } = await offerFor(client, source, deps);
  const first = text.firstNameOf(source.lead_full_name || source.lead_name);
  // The caller who claimed this lead (first to click an outcome) owns later cards.
  const { rows: [fresh] } = await dbClient.query(
    'SELECT claimed_by_slack_id, claimed_by_name FROM followup_sequences WHERE id = $1', [seq.id]);
  const claimed = fresh && fresh.claimed_by_slack_id
    ? { id: fresh.claimed_by_slack_id, name: fresh.claimed_by_name }
    : null;
  const callers = text.parseCallers(env);
  const caller = text.callerName();
  const args = { firstName: first, callerName: caller, clientName: client.name, offerLine, proofPoint };
  const isGhost = ghostText.isGhostKind(step.kind);
  const script = isGhost ? ghostText.ghostCallScript(args) : text.callScript(args);
  const voicemail = isGhost ? ghostText.ghostVoicemail(args) : text.voicemailScript(step.kind, args);
  // The card shows one merged block (shared opening, then answer / voicemail); the two
  // full strings above stay on the card for old rows and the plain-text notification.
  const scriptParts = isGhost ? ghostText.ghostCallCardScript(args) : text.callCardScript(step.kind, args);
  let permalink = null;
  try {
    permalink = await slackApi.getPermalink(client.slack_bot_token, client.slack_channel_id, source.slack_message_ts);
  } catch { /* link is optional */ }
  const mentionIds = claimed ? [claimed.id] : callers.map((c) => c.id).filter(Boolean);
  const stepPayload = parseJson(step.payload) || {};
  let context = null;
  try {
    context = await (deps.loadContext || loadFollowupContext)({
      client, source, phone: found.phone, offer: offerLine || '', permalink,
      ghost: isGhost ? stepPayload.ghost || null : null, env,
    });
  } catch (err) {
    console.warn('[FollowupSeq] card context failed, posting without it', { err: err.message });
  }
  const card = {
    label: text.stepLabel(step.kind),
    kind: step.kind,
    leadName: source.lead_full_name || source.lead_name,
    phone: found.phone,
    email: source.lead_email || null,
    title: context && context.lead ? context.lead.title : null,
    company: context && context.lead ? context.lead.company : null,
    clientName: client.name,
    localTime: leadClock(now, tz),
    tz,
    campaignDisplay: formatCampaignDisplay(campaignNameFromReply(source), source.campaign_id) || null,
    linkedinUrl: source.linkedin_url || null,
    permalink,
    script,
    voicemail,
    scriptParts,
    context,
    icp: context && context.icp,
    enrichmentReceipt: parseJson(source.enrichment_receipt) || (source.enrichment_receipt && typeof source.enrichment_receipt === 'object' ? source.enrichment_receipt : null),
    theirText: context && context.reply,
    theirAt: source.created_at || null,
    sourceReplyId: source.id,
    platform: source.platform,
    smartleadUrl: context && context.links ? context.links.smartlead : null,
    nextHint: NEXT_HINT[step.kind] || null,
    mention: mentionIds.length ? mentionIds.map((id) => `<@${id}>`).join(' ') : null,
    claimedBy: claimed ? claimed.name : null,
  };
  const channel = followUpSlackChannelId();
  const blocks = buildCallCardBlocks(card, step.id);
  const res = await slackApi.getClient(client.slack_bot_token).chat.postMessage({
    channel,
    text: `Call ${card.leadName || 'lead'} at ${found.phone} (${card.label})`,
    blocks,
  });
  await setStep(step.id, {
    status: 'posted', slack_channel: channel, slack_ts: res.ts, posted_at: now,
    outcome: null, outcome_by: null, outcome_at: null,
    payload: { ...(parseJson(step.payload) || {}), card, repost: false },
  }, dbClient);
  await rememberCardPosted({
    step, seq, client, source, dbClient, slackUserId: null, actionId: null, outcome: null,
  });
  await supersedeEarlierLeadCards({
    keepStepId: step.id, keepReplyId: null, seq, client, source,
    channel, ts: res.ts, dbClient, slackApi,
  });
  return 'posted';
}

async function resolveTimes({ client, seq, count = 2, deps = {} }) {
  const inPerson = prefersInPersonMeeting(client.voice_prompt);
  const callback = prefersCallbackCall(client.voice_prompt, client.name);
  const link = (inPerson || callback)
    ? ''
    : prospectBookingLink({ clientName: client.name, bookingLink: client.booking_link });
  const offered = parseJson(seq.offered_starts);
  let slots = [];
  try {
    const r = await (deps.resolveSlots || resolveVerifiedSchedulingSlots)(client, {
      count,
      excludeStarts: Array.isArray(offered) ? offered : [],
    });
    slots = (r && r.slots) || [];
  } catch (err) {
    console.warn('[FollowupSeq] scheduling slots failed', { err: err.message });
  }
  return { slots, link, askForTimes: inPerson || callback };
}

async function postEmailStep({ step, seq, client, source, now, dbClient = db, slackApi = slack, env = process.env, deps = {} }) {
  const payload = parseJson(step.payload) || {};
  const first = text.firstNameOf(source.lead_full_name || source.lead_name);
  const origDue = payload.originalDue ? new Date(payload.originalDue) : new Date(step.due_at);

  let slots = [];
  let link = '';
  let askForTimes = false;
  let proofPoint = null;
  let body = null;

  if (step.kind === 'email_vm' || step.kind === 'email_day1') {
    ({ slots, link, askForTimes } = await resolveTimes({ client, seq, deps }));
    const heldFor = now.getTime() - origDue.getTime();
    const giveUpMs = (step.kind === 'email_vm' ? 60 : 180) * MIN;
    if (!slots.length && !link && !askForTimes) {
      if (step.kind === 'email_vm' && heldFor >= giveUpMs) {
        askForTimes = true; // voicemail note still goes out, flagged on the card
        payload.noLiveTimes = true;
      } else if (heldFor >= giveUpMs) {
        await setStep(step.id, { status: 'skipped', skip_reason: 'no_live_times' }, dbClient);
        return 'skipped';
      } else {
        await setStep(step.id, {
          status: 'held', skip_reason: 'no_live_times', payload: { ...payload, originalDue: origDue.toISOString() },
          due_at: new Date(now.getTime() + 5 * MIN),
        }, dbClient);
        return 'wait';
      }
    }
    body = text.emailBody(step.kind, { firstName: first, slots, link, askForTimes });
  } else if (ghostText.isGhostKind(step.kind)) {
    if (step.kind === 'ghost_breakup') {
      body = ghostText.emailBody(step.kind, { firstName: first });
    } else {
      ({ slots, link, askForTimes } = await resolveTimes({ client, seq, deps }));
      const heldFor = now.getTime() - origDue.getTime();
      if (!slots.length && !link && !askForTimes) {
        if (heldFor >= 180 * MIN) {
          await setStep(step.id, { status: 'skipped', skip_reason: 'no_live_times' }, dbClient);
          return 'skipped';
        }
        await setStep(step.id, {
          status: 'held', skip_reason: 'no_live_times', payload: { ...payload, originalDue: origDue.toISOString() },
          due_at: new Date(now.getTime() + 5 * MIN),
        }, dbClient);
        return 'wait';
      }
      body = ghostText.emailBody(step.kind, { firstName: first, slots, link, askForTimes });
    }
  } else if (step.kind === 'email_proof') {
    ({ proofPoint } = await offerFor(client, source, deps));
    body = text.emailBody('email_proof', { firstName: first, proofPoint });
    if (!body) {
      // Hold, never invent. A manual offer/proof row (admin endpoint) releases it.
      if (now.getTime() - origDue.getTime() > 72 * HOUR) {
        await setStep(step.id, { status: 'skipped', skip_reason: 'no_proof' }, dbClient);
        return 'skipped';
      }
      await setStep(step.id, {
        status: 'held', skip_reason: 'no_proof', payload: { ...payload, originalDue: origDue.toISOString() },
        due_at: new Date(now.getTime() + 12 * HOUR),
      }, dbClient);
      return 'wait';
    }
  } else {
    body = text.emailBody(step.kind, { firstName: first });
  }
  if (!body) {
    await setStep(step.id, { status: 'skipped', skip_reason: 'no_body' }, dbClient);
    return 'skipped';
  }

  // Reuse the card row if an earlier attempt already created it.
  let reply = null;
  if (step.pending_reply_id) {
    const { rows: [r] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [step.pending_reply_id]);
    reply = r || null;
    // A snooze clears the Slack ts and sets payload.repost so this same row
    // can post again. A ts that is still posted is the original card.
    if (reply && isPostedSlackTs(reply.slack_message_ts) && !payload.repost) {
      await setStep(step.id, { status: 'posted', skip_reason: null, slack_ts: reply.slack_message_ts, posted_at: now }, dbClient);
      return 'posted';
    }
  }
  const threadContext = parseJson(source.thread_context);
  if (!reply) {
    const { rows } = await dbClient.query(
      `INSERT INTO pending_replies
         (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_email, linkedin_url,
          inbound_message, thread_context, classification, draft_reply, status, smartlead_email_stats_id,
          follow_up_source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'FOLLOW_UP', $11, 'pending', $12, $13)
       RETURNING *`,
      [client.id, source.platform, source.campaign_id, campaignNameFromReply(source) || null,
        source.lead_id, source.lead_name, source.lead_email, source.linkedin_url,
        source.inbound_message || '(no new reply from prospect)', JSON.stringify(threadContext),
        body, source.smartlead_email_stats_id, source.id],
    );
    reply = rows[0];
    await setStep(step.id, { pending_reply_id: reply.id }, dbClient);
  } else {
    await dbClient.query('UPDATE pending_replies SET draft_reply = $2, updated_at = now() WHERE id = $1', [reply.id, body]);
  }

  const found = await phoneForFollowUp(dbClient, {
    clientId: client.id, sourceReplyId: source.id,
    leadEmail: source.lead_email, linkedinUrl: source.linkedin_url,
  });
  const notes = [`Sequence · ${text.stepLabel(step.kind)}`];
  if (ghostText.isGhostKind(step.kind)) {
    notes.push(`Missed meeting (${payload.ghost && payload.ghost.reason ? String(payload.ghost.reason).replace(/_/g, ' ') : 'no show'}). Nothing sends until you approve this card.`);
  }
  if (payload.noLiveTimes) {
    notes.push('⚠️ No live times were available, so this asks them for a time.');
  }
  if (['pending', 'flagged'].includes(source.status) && step.kind === 'email_vm') {
    notes.push('⚠️ The first reply on the client card is still unsent. Send only one of the two.');
  }
  let permalink = null;
  try {
    permalink = await slackApi.getPermalink(client.slack_bot_token, client.slack_channel_id, source.slack_message_ts);
  } catch { /* optional */ }

  let followupContext = null;
  try {
    const { offerLine: ctxOffer } = await offerFor(client, source, deps);
    followupContext = await (deps.loadContext || loadFollowupContext)({
      client, source, phone: found.phone || '', offer: ctxOffer || '', permalink,
      ghost: ghostText.isGhostKind(step.kind) ? payload.ghost || null : null, env,
    });
  } catch (err) {
    console.warn('[FollowupSeq] card context failed, posting without it', { err: err.message });
  }
  const emailTz = time.resolveTimeZone(source.lead_timezone, seq.lead_timezone, client.digest_timezone);
  if (followupContext) {
    followupContext.sequence = {
      kind: step.kind,
      stepId: step.id,
      sourceReplyId: source.id,
      tz: emailTz,
      localTime: leadClock(now, emailTz),
      theirAt: source.created_at || null,
      nextHint: NEXT_HINT[step.kind] || null,
      replaces: payload.repost ? 'Replaces the previous card' : null,
    };
    followupContext.localTime = followupContext.sequence.localTime;
  }

  const channel = followUpSlackChannelId();
  const posted = await (deps.postCard || postProspectSlackCard)({
    token: client.slack_bot_token,
    channelId: channel,
    clientId: client.id,
    platform: source.platform,
    campaignId: source.campaign_id,
    leadId: source.lead_id,
    threadContext,
    isDraft: true,
    replyId: reply.id,
    postInThread: false,
    card: {
      replyId: reply.id,
      leadName: source.lead_name,
      leadEmail: source.lead_email,
      linkedinUrl: source.linkedin_url || undefined,
      leadWebsite: source.lead_website || undefined,
      platform: source.platform,
      classification: 'FOLLOW_UP',
      draft: body,
      enrichmentReceipt: parseJson(source.enrichment_receipt) || undefined,
      leadTimezone: emailTz,
      leadPhone: found.phone || undefined,
      phoneProvider: found.provider || undefined,
      reasoning: notes.join(' · '),
      needsClient: false,
      ccEmails: client.notify_emails || undefined,
      inboundMessage: source.inbound_message || '(no new reply from prospect)',
      campaignDisplay: formatCampaignDisplay(campaignNameFromReply(source), source.campaign_id) || undefined,
      lastOutboundMessage: source.sent_reply || undefined,
      contextLabel: 'You sent',
      threadPermalink: permalink || undefined,
      mention: ghostText.isGhostKind(step.kind) ? (ghostText.mentionLine(env) || undefined) : undefined,
      followupContext: followupContext || undefined,
    },
  });
  if (!posted || !isPostedSlackTs(posted.ts)) {
    // Dedupe claim lost or Slack skipped: leave the step to retry.
    await setStep(step.id, { status: 'pending', due_at: new Date(now.getTime() + 2 * MIN) }, dbClient);
    return 'wait';
  }

  if (slots.length) {
    const prev = parseJson(seq.offered_starts);
    const merged = [...(Array.isArray(prev) ? prev : []), ...slots.map((s) => s.start)];
    await dbClient.query(
      'UPDATE followup_sequences SET offered_starts = $2::jsonb, updated_at = now() WHERE id = $1',
      [seq.id, JSON.stringify(merged)],
    );
  }
  await setStep(step.id, {
    status: 'posted', skip_reason: null, slack_channel: channel, slack_ts: posted.ts, posted_at: now,
    outcome: null, outcome_by: null, outcome_at: null,
    payload: { ...payload, repost: false },
  }, dbClient);
  await rememberCardPosted({
    step, seq, client, source, pendingReplyId: reply.id, dbClient,
  });
  await supersedeEarlierLeadCards({
    keepStepId: step.id, keepReplyId: reply.id, seq, client, source,
    channel, ts: posted.ts, dbClient, slackApi,
  });
  return 'posted';
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

let tickActive = false;

async function releaseStalePosting(dbClient = db) {
  await dbClient.query(
    `UPDATE followup_sequence_steps SET status = 'pending', updated_at = now()
      WHERE status = 'posting' AND updated_at < now() - interval '15 minutes'`,
  );
}

/** Stop sequences whose lead replied, booked, was DQ'd or claimed. */
async function applyStopRules({ dbClient = db, slackApi = slack, limit = 200, onlyGhost = false, deps = {} } = {}) {
  const { rows } = await dbClient.query(
    `SELECT s.id AS seq_id, s.origin AS seq_origin, s.enrolled_at AS seq_enrolled_at,
            s.client_id AS seq_client_id, s.lead_email AS seq_lead_email,
            (SELECT c.active FROM clients c WHERE c.id = s.client_id) AS seq_client_active, pr.*
       FROM followup_sequences s
       JOIN pending_replies pr ON pr.id = s.source_reply_id
      WHERE s.status = 'active'
        AND ($2::boolean = false OR s.origin = 'ghosted_meeting')
      ORDER BY s.created_at ASC
      LIMIT $1`,
    [limit, onlyGhost],
  );
  let stopped = 0;
  for (const row of rows) {
    const {
      seq_id: seqId, seq_origin: seqOrigin, seq_enrolled_at: seqEnrolledAt,
      seq_client_id: seqClientId, seq_lead_email: seqLeadEmail, seq_client_active: seqClientActive, ...source
    } = row;
    let reason = null;
    if (seqClientActive === false) reason = 'client_inactive';
    else if (seqOrigin === ghost.ORIGIN) {
      // The source reply is already booked (the meeting was ghosted), so only the ghost rules apply.
      reason = await ghost.stopReason({ id: seqId, client_id: seqClientId, lead_email: seqLeadEmail, enrolled_at: seqEnrolledAt }, source, { dbClient, deps });
    } else if (['meeting_booked'].includes(source.status)) reason = 'booked';
    else if (source.status === 'disqualified') reason = 'disqualified';
    else if (source.status === 'rejected' || !POSITIVE.has(String(source.classification || '').toUpperCase())) reason = 'source_closed';
    else reason = await stopReasonForLead(source, { dbClient, checkBooked: false });
    if (reason) {
      const r = await stopSequence(seqId, reason, { dbClient, slackApi });
      if (r.stopped) stopped++;
    }
  }
  return stopped;
}

async function completeFinishedSequences(dbClient = db) {
  await dbClient.query(
    `UPDATE followup_sequences s
        SET status = 'completed', updated_at = now()
      WHERE s.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM followup_sequence_steps st
           WHERE st.sequence_id = s.id AND st.status IN ('pending', 'held', 'posting')
        )`,
  );
}

async function runSequenceTick({ now = new Date(), dbClient = db, slackApi = slack, env = process.env, limit = 25, deps = {} } = {}) {
  const totals = { enrolled: 0, stopped: 0, posted: 0, skipped: 0, waited: 0, failed: 0 };
  const regularOn = enabled(env);
  const ghostOn = ghost.enabled(env);
  if (!regularOn && !ghostOn) return { ...totals, disabled: true };
  if (tickActive) return { ...totals, overlap: true };
  tickActive = true;
  try {
    await releaseStalePosting(dbClient);
    totals.stopped = await applyStopRules({ dbClient, slackApi, onlyGhost: !regularOn, deps });
    if (regularOn) {
      const e = await enrollNewReplies({ now, dbClient, env });
      totals.enrolled = e.enrolled;
    }

    // Anything more than a day late is stale. Never catch up in a burst.
    await dbClient.query(
      `UPDATE followup_sequence_steps
          SET status = 'skipped', skip_reason = 'stale', updated_at = now()
        WHERE status IN ('pending', 'held') AND due_at < $1
          AND sequence_id IN (SELECT id FROM followup_sequences WHERE status = 'active')`,
      [new Date(now.getTime() - 24 * HOUR)],
    );

    const { rows: due } = await dbClient.query(
      `SELECT st.*
         FROM followup_sequence_steps st
         JOIN followup_sequences s ON s.id = st.sequence_id
        WHERE s.status = 'active' AND st.status IN ('pending', 'held') AND st.due_at <= $1
          AND ($3::boolean OR s.origin = 'ghosted_meeting')
        ORDER BY st.due_at ASC, st.seq_order ASC
        LIMIT $2`,
      [now, limit, regularOn],
    );

    for (const step of due) {
      try {
        const { rows: [claimed] } = await dbClient.query(
          `UPDATE followup_sequence_steps SET status = 'posting', updated_at = now()
            WHERE id = $1 AND status IN ('pending', 'held') RETURNING *`,
          [step.id],
        );
        if (!claimed) continue;
        const { rows: [seq] } = await dbClient.query('SELECT * FROM followup_sequences WHERE id = $1', [step.sequence_id]);
        const { rows: [source] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [seq.source_reply_id]);
        const client = await loadClient(seq.client_id, dbClient);
        if (!seq || !source || !client || !client.slack_bot_token) {
          await setStep(step.id, { status: 'skipped', skip_reason: 'missing_context' }, dbClient);
          totals.skipped++;
          continue;
        }
        // Deleted or deactivated client (Deep Roots, Oct 29 2026): no more cards. Nothing is deleted.
        if (client.active === false) {
          await stopSequence(seq.id, 'client_inactive', { dbClient, slackApi });
          totals.stopped++;
          continue;
        }
        const reason = seq.origin === ghost.ORIGIN
          ? await ghost.stopReason(seq, source, { dbClient, env, deps })
          : await stopReasonForLead(source, { dbClient });
        if (reason) {
          await stopSequence(seq.id, reason, { dbClient, slackApi });
          totals.stopped++;
          continue;
        }
        const tz = time.resolveTimeZone(source.lead_timezone, seq.lead_timezone, client.digest_timezone);
        const isCall = text.isCallKind(claimed.kind);
        let result;
        if (isCall) {
          result = await postCallStep({ step: claimed, seq, client, source, now, tz, dbClient, slackApi, env, deps });
        } else {
          const holiday = time.isHoliday(time.zonedParts(now, time.DEFAULT_TZ));
          if (claimed.kind !== 'email_vm' && (holiday || !inSendWindow(now))) {
            const next = holiday ? time.nextCallWindowStart(now, time.DEFAULT_TZ, env) : snapDueToSendWindow(now);
            await setStep(step.id, { status: 'pending', due_at: next }, dbClient);
            totals.waited++;
            continue;
          }
          result = await postEmailStep({ step: claimed, seq, client, source, now, dbClient, slackApi, env, deps });
        }
        if (result === 'posted' && seq.origin === ghost.ORIGIN) {
          const { rows: [after] } = await dbClient.query('SELECT slack_ts, payload FROM followup_sequence_steps WHERE id = $1', [step.id]);
          await ghost.recordStepPosted(seq, { ...claimed, payload: (after && after.payload) || claimed.payload }, { dbClient, ts: after && after.slack_ts });
        }
        if (result === 'posted') totals.posted++;
        else if (result === 'skipped') totals.skipped++;
        else totals.waited++;
      } catch (err) {
        totals.failed++;
        console.error('[FollowupSeq] step failed', { stepId: step.id, kind: step.kind, err: err.message });
        const attempts = (parseJson(step.payload) || {}).attempts || 0;
        if (attempts >= 4) {
          await setStep(step.id, { status: 'skipped', skip_reason: 'error' }, dbClient).catch(() => {});
        } else {
          await setStep(step.id, {
            status: 'pending', due_at: new Date(now.getTime() + 3 * MIN),
            payload: { ...(parseJson(step.payload) || {}), attempts: attempts + 1 },
          }, dbClient).catch(() => {});
        }
      }
    }
    await completeFinishedSequences(dbClient);
    return totals;
  } finally {
    tickActive = false;
  }
}

// ─── Call card buttons ────────────────────────────────────────────────────────

const OUTCOME_BY_ACTION = {
  ...Object.fromEntries(OUTCOME_BUTTONS.map((b) => [b.actionId, b.outcome])),
  fseq_dq: 'dq',
};

/**
 * Record what happened on a call.
 *  - Meeting booked: marks the meeting booked, stops the sequence, closes unsent cards.
 *  - Not interested: stops the sequence and closes unsent cards.
 *  - No answer / voicemail: logged; on the Day 0 call it queues the voicemail email 5 min out.
 *  - Call back later: logged, sequence continues.
 *  - Wrong number: no more call cards for this lead; email steps continue.
 */
/**
 * The first configured caller to click an outcome on a lead claims it. Later
 * cards for that lead use their name and @-mention them. A click by someone who
 * is not a configured caller is still applied but is logged and never claims.
 * Returns { claimed, nonCaller, caller }.
 */
async function claimLead({ seqId, slackUserId, dbClient = db, env = process.env }) {
  if (!slackUserId) return { claimed: false, nonCaller: false, caller: null };
  const caller = text.parseCallers(env).find((c) => c.id === slackUserId) || null;
  if (!caller) {
    console.warn('[FollowupSeq] outcome clicked by a user who is not a configured caller', { seqId, slackUserId });
    return { claimed: false, nonCaller: true, caller: null };
  }
  const { rows } = await dbClient.query(
    `UPDATE followup_sequences
        SET claimed_by_slack_id = $2, claimed_by_name = $3, claimed_at = now(), updated_at = now()
      WHERE id = $1 AND claimed_by_slack_id IS NULL
      RETURNING id`,
    [seqId, caller.id, caller.name],
  );
  return { claimed: rows.length > 0, nonCaller: false, caller };
}

/** Card line about who now owns the lead, or a log note for a non-caller click. */
function claimNote(claim) {
  if (!claim) return null;
  if (claim.claimed && claim.caller) {
    return `🙋 *${claim.caller.name} claimed this lead.* Later calls for them show ${claim.caller.name}'s name and @-mention ${claim.caller.name}.`;
  }
  if (claim.nonCaller) return '📝 Clicked by someone who is not on the caller list. Logged, and the lead stays unclaimed.';
  return null;
}

async function applyCallOutcome({ stepId, outcome, slackUserId = null, now = new Date(), dbClient = db, slackApi = slack, env = process.env }) {
  const { rows: [step] } = await dbClient.query(
    `UPDATE followup_sequence_steps
        SET outcome = $2, outcome_by = $3, outcome_at = $4, updated_at = now()
      WHERE id = $1 AND outcome IS NULL AND status = 'posted'
      RETURNING *`,
    [stepId, outcome, slackUserId, now],
  );
  if (!step) return { applied: false };
  const { rows: [seq] } = await dbClient.query('SELECT * FROM followup_sequences WHERE id = $1', [step.sequence_id]);
  if (!seq) return { applied: true, step };

  const claim = await claimLead({ seqId: seq.id, slackUserId, dbClient, env });
  if (claim.nonCaller) {
    await dbClient.query(
      `UPDATE followup_sequence_steps SET payload = COALESCE(payload, '{}'::jsonb) || '{"nonCaller": true}'::jsonb WHERE id = $1`,
      [step.id]);
  }

  if (outcome === 'booked') {
    try {
      const { rows: [source] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [seq.source_reply_id]);
      if (source) {
        await require('./meeting-booked').markMeetingBooked({
          clientId: seq.client_id, reply: source, slackUserId,
        });
      }
    } catch (err) {
      console.warn('[FollowupSeq] markMeetingBooked failed', { stepId, err: err.message });
    }
    await stopSequence(seq.id, 'booked', { dbClient, slackApi, now });
  } else if (outcome === 'not_interested') {
    await stopSequence(seq.id, 'not_interested', { dbClient, slackApi, now });
  } else if (outcome === 'dq') {
    try {
      const { rows: [source] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [seq.source_reply_id]);
      if (source) {
        await require('./disqualified-prospects').markDisqualified({
          clientId: seq.client_id, reply: source, reason: 'slack_dq', slackUserId,
        });
      }
    } catch (err) {
      console.warn('[FollowupSeq] DQ record failed', { stepId, err: err.message });
    }
    await stopSequence(seq.id, 'disqualified', { dbClient, slackApi, now });
  } else if (outcome === 'wrong_number') {
    const callKinds = Object.keys(text.CALL_KINDS);
    await dbClient.query(
      `UPDATE followup_sequence_steps
          SET status = 'cancelled', skip_reason = 'wrong_number', updated_at = now()
        WHERE sequence_id = $1 AND status IN ('pending', 'held')
          AND (kind = ANY($2::text[]) OR kind LIKE 'call\\_callback\\_%')`,
      [seq.id, callKinds],
    );
  } else if (outcome === 'no_answer' && step.kind === 'call_day0' && seq.status === 'active') {
    const delay = envMinutes('FOLLOWUP_VM_EMAIL_DELAY_MINUTES', 5, env);
    await dbClient.query(
      `INSERT INTO followup_sequence_steps (sequence_id, kind, seq_order, due_at, status)
       VALUES ($1, 'email_vm', 15, $2, 'pending')
       ON CONFLICT (sequence_id, kind) DO NOTHING`,
      [seq.id, new Date(now.getTime() + delay * MIN)],
    );
  }
  try {
    await recordOutcomeEvent({
      step, seq, outcome, actionId: null, slackUserId, dbClient,
    });
  } catch (err) {
    console.warn('[FollowupSeq] outcome event failed', { err: err.message });
  }
  return { applied: true, step, seq, claim };
}

function alreadyHandledNotice() {
  return 'Already handled. Nothing was done, no action needed.';
}

/** Slack route entry: handle one button click and redraw the card. */
async function handleCallButton(action, interaction, { dbClient = db, slackApi = slack, env = process.env } = {}) {
  const { sendEphemeralNotice } = require('./card-click-guard');
  let act = action || {};
  if (act.action_id === 'fseq_overflow') {
    const raw = (act.selected_option && act.selected_option.value) || '';
    const cut = raw.indexOf(':');
    const picked = cut >= 0 ? raw.slice(0, cut) : raw;
    const id = cut >= 0 ? raw.slice(cut + 1) : act.value;
    if (picked === 'wrong_number') act = { ...act, action_id: 'fseq_wrong_number', value: id };
    else if (picked === 'dq') act = { ...act, action_id: 'fseq_dq', value: id };
    else {
      await sendEphemeralNotice(interaction, 'That menu item is not active, so nothing was done.');
      return;
    }
  }
  const userId = interaction.user && interaction.user.id;
  if (act.action_id === 'fseq_snooze') {
    const opened = await openSnoozeModal({
      stepId: act.value, interaction, dbClient, slackApi,
    });
    if (!opened) await sendEphemeralNotice(interaction, alreadyHandledNotice());
    return;
  }
  if (act.action_id === 'fseq_call_instead') {
    await applyCallInstead({
      stepId: act.value, slackUserId: userId, interaction, dbClient, slackApi,
    });
    return;
  }
  if (act.action_id === 'fseq_call_back') {
    // Not recorded yet: the caller picks the time first.
    const opened = await openCallbackModal({ stepId: act.value, interaction, dbClient, slackApi });
    if (!opened) await sendEphemeralNotice(interaction, alreadyHandledNotice());
    return;
  }
  const outcome = OUTCOME_BY_ACTION[act.action_id];
  if (!outcome) {
    await sendEphemeralNotice(interaction, 'That button is not active anymore, so nothing was done.');
    return;
  }
  const res = await applyCallOutcome({
    stepId: act.value, outcome, slackUserId: userId, dbClient, slackApi, env,
  });
  if (!res.applied) {
    console.log('[FollowupSeq] call outcome ignored (already recorded or not posted)', { stepId: act.value });
    await sendEphemeralNotice(interaction, alreadyHandledNotice());
    return;
  }
  const payload = parseJson(res.step.payload) || {};
  if (!payload.card || !res.seq) return;
  const { rows: [client] } = await dbClient.query('SELECT slack_bot_token FROM clients WHERE id = $1', [res.seq.client_id]);
  if (!client || !client.slack_bot_token) return;
  try {
    await slackApi.getClient(client.slack_bot_token).chat.update({
      channel: res.step.slack_channel,
      ts: res.step.slack_ts,
      text: `${payload.card.label}: ${outcome}`,
      blocks: buildCallCardBlocks(payload.card, res.step.id, { outcome, outcomeBy: userId, note: claimNote(res.claim) }),
    });
  } catch (err) {
    console.warn('[FollowupSeq] could not redraw call card', { stepId: act.value, err: err.message });
  }
}

// ─── Callback scheduling ──────────────────────────────────────────────────────

const CALLBACK_MODAL_ID = 'fseq_callback_modal';

function formatInZone(date, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(date);
  } catch { return date.toISOString(); }
}

/** Next quarter hour at least an hour out, moved into the lead's call hours. */
function defaultCallbackTime(now, tz, env = process.env) {
  const q = 15 * MIN;
  const target = new Date(Math.ceil((now.getTime() + 60 * MIN) / q) * q);
  return time.nextCallWindowStart(target, tz, env);
}

/** Error text, or null when `when` is an acceptable callback time for the lead. */
function callbackTimeError(when, tz, now = new Date(), env = process.env) {
  if (!(when instanceof Date) || !Number.isFinite(when.getTime())) return 'Pick a date and time.';
  if (when.getTime() < now.getTime() + MIN) return 'That time has already passed. Pick a time in the future.';
  if (!time.inCallWindow(when, tz, env)) {
    const { start, end } = time.callHours(env);
    return `That is ${formatInZone(when, tz)} for the lead. Calls only go out ${start}:00 to ${end}:00 their time, Mon-Fri, not on holidays.`;
  }
  return null;
}

/** Pure: the callback modal. The picker shows in the Slack user's own time zone. */
function buildCallbackModal({ stepId, channel, ts, leadName, tz, now = new Date(), env = process.env }) {
  const { start, end } = time.callHours(env);
  const def = defaultCallbackTime(now, tz, env);
  return {
    type: 'modal',
    callback_id: CALLBACK_MODAL_ID,
    private_metadata: JSON.stringify({ stepId, channel, ts, tz }),
    title: { type: 'plain_text', text: 'Call back later' },
    submit: { type: 'plain_text', text: 'Set callback' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${leadName || 'This lead'}* is in *${tz}*.\nRight now it is *${formatInZone(now, tz)}* there.\nCalls only go out *${start}:00 AM to ${end > 12 ? end - 12 : end}:00 PM their time*, Mon-Fri, not on holidays.`,
        },
      },
      {
        type: 'input',
        block_id: 'when_block',
        label: { type: 'plain_text', text: 'When should the callback card come up?' },
        hint: { type: 'plain_text', text: 'The picker uses your own Slack time zone. Suggested time is the next open slot in the lead\'s business hours.' },
        element: {
          type: 'datetimepicker',
          action_id: 'when',
          initial_date_time: Math.floor(def.getTime() / 1000),
        },
      },
    ],
  };
}

/** Synchronous check for the modal submit. Returns Slack `errors` or null. */
function validateCallbackSubmission(interaction, { now = new Date(), env = process.env } = {}) {
  let meta = {};
  try { meta = JSON.parse(interaction.view?.private_metadata || '{}'); } catch { meta = {}; }
  const secs = interaction.view?.state?.values?.when_block?.when?.selected_date_time;
  const err = callbackTimeError(secs ? new Date(secs * 1000) : null, meta.tz || time.DEFAULT_TZ, now, env);
  return err ? { when_block: err } : null;
}

async function openCallbackModal({ stepId, interaction, dbClient = db, slackApi = slack, now = new Date(), env = process.env }) {
  const { rows: [step] } = await dbClient.query(
    `SELECT * FROM followup_sequence_steps WHERE id = $1 AND status = 'posted' AND outcome IS NULL`, [stepId]);
  if (!step) {
    console.log('[FollowupSeq] callback modal ignored (outcome already recorded or card not posted)', { stepId });
    return false;
  }
  const { rows: [seq] } = await dbClient.query('SELECT * FROM followup_sequences WHERE id = $1', [step.sequence_id]);
  if (!seq || seq.status === 'stopped') return false;
  const { rows: [source] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [seq.source_reply_id]);
  const { rows: [client] } = await dbClient.query('SELECT slack_bot_token, digest_timezone FROM clients WHERE id = $1', [seq.client_id]);
  if (!source || !client || !client.slack_bot_token) return false;
  const tz = time.resolveTimeZone(source.lead_timezone, seq.lead_timezone, client.digest_timezone);
  await slackApi.getClient(client.slack_bot_token).views.open({
    trigger_id: interaction.trigger_id,
    view: buildCallbackModal({
      stepId, channel: interaction.channel?.id || step.slack_channel, ts: interaction.message?.ts || step.slack_ts,
      leadName: source.lead_full_name || source.lead_name, tz, now, env,
    }),
  });
  return true;
}

/**
 * Record "call back later" and queue a callback call card for `when`.
 * The normal sequence is untouched and continues on its own timing. A booking,
 * reply, unsubscribe or DQ cancels the pending callback with everything else.
 */
async function scheduleCallback({ stepId, when, slackUserId = null, now = new Date(), dbClient = db, env = process.env }) {
  const { rows: [step] } = await dbClient.query(
    `UPDATE followup_sequence_steps
        SET outcome = 'call_back', outcome_by = $2, outcome_at = $3, updated_at = now()
      WHERE id = $1 AND outcome IS NULL AND status = 'posted'
      RETURNING *`,
    [stepId, slackUserId, now],
  );
  if (!step) return { applied: false };
  const { rows: [seq] } = await dbClient.query('SELECT * FROM followup_sequences WHERE id = $1', [step.sequence_id]);
  if (!seq) return { applied: true, step, seq, scheduled: false };
  const claim = await claimLead({ seqId: seq.id, slackUserId, dbClient, env });
  if (claim.nonCaller) {
    await dbClient.query(
      `UPDATE followup_sequence_steps SET payload = COALESCE(payload, '{}'::jsonb) || '{"nonCaller": true}'::jsonb WHERE id = $1`,
      [step.id]);
  }
  if (seq.status === 'stopped') return { applied: true, step, seq, scheduled: false, claim };
  if (seq.status === 'completed') {
    // The last scheduled step already went out; the callback still has to fire.
    try {
      await dbClient.query(`UPDATE followup_sequences SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'completed'`, [seq.id]);
    } catch (err) {
      if (err && err.code === '23505') return { applied: true, step, seq, scheduled: false, claim };
      throw err;
    }
  }
  const { rows: [{ n }] } = await dbClient.query(
    `SELECT count(*)::int AS n FROM followup_sequence_steps WHERE sequence_id = $1 AND kind LIKE 'call\\_callback\\_%'`,
    [seq.id],
  );
  const kind = `${text.CALLBACK_PREFIX}${n + 1}`;
  await dbClient.query(
    `INSERT INTO followup_sequence_steps (sequence_id, kind, seq_order, due_at, status, payload)
     VALUES ($1, $2, 25, $3, 'pending', $4::jsonb)`,
    [seq.id, kind, when, JSON.stringify({ callbackOf: stepId, setBy: slackUserId })],
  );
  return { applied: true, step, seq, scheduled: true, kind, claim };
}

/** Modal submit (after the 3s acknowledgement): schedule the callback and say so on the card. */
async function handleCallbackSubmit(interaction, { dbClient = db, slackApi = slack, now = new Date(), env = process.env } = {}) {
  let meta = {};
  try { meta = JSON.parse(interaction.view?.private_metadata || '{}'); } catch { meta = {}; }
  const secs = interaction.view?.state?.values?.when_block?.when?.selected_date_time;
  if (!meta.stepId || !secs) return { applied: false };
  const userId = interaction.user && interaction.user.id;
  const when = new Date(secs * 1000);
  const res = await scheduleCallback({ stepId: meta.stepId, when, slackUserId: userId, now, dbClient, env });
  if (!res.applied) {
    console.log('[FollowupSeq] callback ignored (outcome already recorded)', { stepId: meta.stepId });
    try {
      await require('./card-click-guard').sendEphemeralNotice(interaction, alreadyHandledNotice());
    } catch { /* private notice is best-effort */ }
    return res;
  }
  try {
    await recordOutcomeEvent({
      step: res.step, seq: res.seq, outcome: 'call_back', actionId: 'fseq_call_back',
      slackUserId: userId, dbClient,
    });
  } catch (err) {
    console.warn('[FollowupSeq] callback event failed', { err: err.message });
  }
  const payload = parseJson(res.step.payload) || {};
  const { rows: [client] } = res.seq
    ? await dbClient.query('SELECT slack_bot_token FROM clients WHERE id = $1', [res.seq.client_id])
    : { rows: [] };
  if (payload.card && client && client.slack_bot_token) {
    const tz = meta.tz || time.DEFAULT_TZ;
    const note = res.scheduled
      ? `🔁 *Callback set for* <!date^${secs}^{date_short_pretty} at {time}|${when.toISOString()}> (lead's time: ${formatInZone(when, tz)}). A new call card will come up then.`
      : '⚠️ The sequence is already stopped, so no callback was scheduled.';
    try {
      await slackApi.getClient(client.slack_bot_token).chat.update({
        channel: res.step.slack_channel,
        ts: res.step.slack_ts,
        text: `${payload.card.label}: call back later`,
        blocks: buildCallCardBlocks(payload.card, res.step.id, { outcome: 'call_back', outcomeBy: userId, note: [note, claimNote(res.claim)].filter(Boolean).join('\n') }),
      });
    } catch (err) {
      console.warn('[FollowupSeq] could not redraw call card', { stepId: meta.stepId, err: err.message });
    }
  }
  return res;
}

async function rememberCardPosted({ step, seq, client, source, pendingReplyId = null, dbClient = db }) {
  try {
    const events = require('./followup-card-events');
    await events.recordCardEvent({
      clientId: client && client.id,
      sequenceId: seq && seq.id,
      stepId: step && step.id,
      pendingReplyId: pendingReplyId || (step && step.pending_reply_id) || (source && source.id),
      leadKey: seq && seq.lead_key,
      eventType: 'posted',
      detail: { kind: step && step.kind },
    }, dbClient);
  } catch (err) {
    console.warn('[FollowupSeq] posted event failed', { err: err.message });
  }
}

async function recordOutcomeEvent({ step, seq, outcome, actionId, slackUserId, dbClient = db, detail = {} }) {
  const events = require('./followup-card-events');
  await events.recordCardEvent({
    clientId: seq && seq.client_id,
    sequenceId: seq && seq.id,
    stepId: step && step.id,
    pendingReplyId: (step && step.pending_reply_id) || (seq && seq.source_reply_id) || null,
    leadKey: seq && seq.lead_key,
    eventType: 'outcome',
    actionId: actionId || null,
    outcome,
    slackUserId,
    detail,
  }, dbClient);
}

/**
 * One open follow-up card per lead. The new step stays. Earlier posted call
 * cards are repainted. Earlier open FOLLOW_UP rows use the #189 supersede path.
 * A Slack failure leaves the old row open and does not fail the new post.
 */
async function supersedeEarlierLeadCards({
  keepStepId, keepReplyId = null, seq, client, source, channel, ts, dbClient = db, slackApi = slack,
} = {}) {
  if (!seq || !client) return;
  try {
    const { rows: calls } = await dbClient.query(
      `SELECT st.*
         FROM followup_sequence_steps st
         JOIN followup_sequences s ON s.id = st.sequence_id
        WHERE s.client_id = $1
          AND s.lead_key = $2
          AND st.id <> $3
          AND st.status = 'posted'
          AND st.slack_ts IS NOT NULL
          AND st.outcome IS NULL
          AND st.pending_reply_id IS NULL`,
      [seq.client_id, seq.lead_key || '', keepStepId],
    );
    let link = null;
    try {
      link = await slackApi.getPermalink(client.slack_bot_token, channel, ts);
    } catch { link = null; }
    for (const old of calls) {
      const payload = parseJson(old.payload) || {};
      if (!payload.card || !client.slack_bot_token) continue;
      try {
        await slackApi.getClient(client.slack_bot_token).chat.update({
          channel: old.slack_channel,
          ts: old.slack_ts,
          text: 'Superseded by newer card',
          blocks: buildCallCardBlocks(payload.card, old.id, {
            superseded: true, supersededPermalink: link,
          }),
        });
        await setStep(old.id, { outcome: 'superseded', outcome_at: new Date() }, dbClient);
        await recordOutcomeEvent({
          step: old, seq, outcome: 'superseded', actionId: null, slackUserId: null, dbClient,
        });
      } catch (err) {
        console.warn('[FollowupSeq] could not supersede call card', { stepId: old.id, err: err.message });
      }
    }

    const email = String((source && source.lead_email) || seq.lead_email || '').trim().toLowerCase();
    const leadId = source && source.lead_id != null ? String(source.lead_id) : '';
    if (email || leadId) {
      const { rows } = await dbClient.query(
        `SELECT *
           FROM pending_replies
          WHERE client_id = $1
            AND upper(COALESCE(classification, '')) = 'FOLLOW_UP'
            AND status = ANY($2::text[])
            AND slack_message_ts ~ '^[0-9]+[.][0-9]+$'
            AND ($3::uuid IS NULL OR id <> $3)
            AND (
              ($4::text <> '' AND lower(COALESCE(lead_email, '')) = $4)
              OR ($5::text <> '' AND COALESCE(lead_id, '') = $5)
            )`,
        [seq.client_id, ['pending', 'flagged', 'alert_only', 'failed'], keepReplyId, email, leadId],
      );
      if (rows.length) {
        const { supersedeRows } = require('./supersede-cards');
        const painted = await supersedeRows(rows, {
          keepId: keepReplyId, permalink: link, query: dbClient.query.bind(dbClient),
        });
        const retired = (painted && painted.retired) || [];
        if (retired.length) {
          await dbClient.query(
            `UPDATE followup_sequence_steps
                SET outcome = 'superseded', outcome_at = now(), updated_at = now()
              WHERE pending_reply_id = ANY($1::uuid[])
                AND outcome IS NULL
                AND id <> $2`,
            [retired, keepStepId],
          );
          await require('./followup-card-events').recordCardEvent({
            clientId: seq.client_id,
            sequenceId: seq.id,
            pendingReplyId: retired[0],
            leadKey: seq.lead_key,
            eventType: 'supersede',
            outcome: 'superseded',
            detail: { count: retired.length },
          }, dbClient);
        }
      }
    }
  } catch (err) {
    console.warn('[FollowupSeq] supersede failed', { err: err.message });
  }
}

function snoozeDueAt(ymd, tz, now = new Date(), env = process.env) {
  const [y, m, d] = String(ymd || '').split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return time.nextCallWindowStart(now, tz, env);
  let due = time.zonedToUtc(y, m, d, 9, 0, tz || time.DEFAULT_TZ);
  due = time.nextCallWindowStart(due, tz || time.DEFAULT_TZ, env);
  if (due.getTime() < now.getTime()) due = time.nextCallWindowStart(now, tz || time.DEFAULT_TZ, env);
  return due;
}

async function openSnoozeModal({
  stepId = null, replyId = null, interaction, dbClient = db, slackApi = slack, now = new Date(),
} = {}) {
  const layout = require('../utils/followup-card-layout');
  if (stepId) {
    const { rows: [step] } = await dbClient.query(
      `SELECT * FROM followup_sequence_steps WHERE id = $1 AND status = 'posted' AND outcome IS NULL`,
      [stepId],
    );
    if (!step) return false;
    const { rows: [seq] } = await dbClient.query('SELECT * FROM followup_sequences WHERE id = $1', [step.sequence_id]);
    if (!seq || seq.status === 'stopped') return false;
    const { rows: [source] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [seq.source_reply_id]);
    const { rows: [client] } = await dbClient.query(
      'SELECT slack_bot_token, digest_timezone FROM clients WHERE id = $1', [seq.client_id],
    );
    if (!source || !client || !client.slack_bot_token || !interaction?.trigger_id) return false;
    const tz = time.resolveTimeZone(source.lead_timezone, seq.lead_timezone, client.digest_timezone);
    await slackApi.getClient(client.slack_bot_token).views.open({
      trigger_id: interaction.trigger_id,
      view: layout.buildSnoozeModal({
        stepId, replyId: step.pending_reply_id || source.id,
        channel: interaction.channel?.id || step.slack_channel, ts: interaction.message?.ts || step.slack_ts,
        tz, now,
      }),
    });
    return true;
  }
  return openCadenceSnooze({ replyId, interaction, dbClient, slackApi, now });
}

async function openCadenceSnooze(replyIdOrOpts, interaction, deps = {}) {
  const opts = replyIdOrOpts && typeof replyIdOrOpts === 'object'
    ? replyIdOrOpts
    : { replyId: replyIdOrOpts, interaction, ...deps };
  return openCadenceSnoozeModal(opts);
}

async function openCadenceSnoozeModal({ replyId, interaction, dbClient = db, slackApi = slack, now = new Date() } = {}) {
  const layout = require('../utils/followup-card-layout');
  if (!replyId || !interaction?.trigger_id) return false;
  const { rows: [reply] } = await dbClient.query(
    `SELECT pr.*, c.slack_bot_token, c.digest_timezone
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.id = $1 AND pr.status IN ('pending', 'flagged')`,
    [replyId],
  );
  if (!reply || !reply.slack_bot_token) return false;
  const tz = time.resolveTimeZone(reply.lead_timezone, null, reply.digest_timezone);
  await slackApi.getClient(reply.slack_bot_token).views.open({
    trigger_id: interaction.trigger_id,
    view: layout.buildSnoozeModal({
      replyId,
      channel: interaction.channel?.id || reply.slack_channel_id,
      ts: interaction.message?.ts || reply.slack_message_ts,
      tz, now,
    }),
  });
  return true;
}

async function handleSnoozeSubmit(interaction, { dbClient = db, slackApi = slack, now = new Date(), env = process.env } = {}) {
  const layout = require('../utils/followup-card-layout');
  const { sendEphemeralNotice } = require('./card-click-guard');
  let meta = {};
  try { meta = JSON.parse(interaction.view?.private_metadata || '{}'); } catch { meta = {}; }
  const ymd = interaction.view?.state?.values?.snooze_block?.snooze_date?.selected_date;
  const zone = meta.tz || time.DEFAULT_TZ;
  if (layout.snoozeDateError(ymd, zone, now)) return { applied: false };
  const userId = interaction.user && interaction.user.id;
  const due = snoozeDueAt(ymd, zone, now, env);

  if (meta.stepId) {
    const { rows: [existing] } = await dbClient.query(
      'SELECT slack_channel, slack_ts, payload FROM followup_sequence_steps WHERE id = $1',
      [meta.stepId],
    );
    const { rows: [step] } = await dbClient.query(
      `UPDATE followup_sequence_steps
          SET outcome = 'snoozed', outcome_by = $2, outcome_at = $3, status = 'pending',
              due_at = $4, slack_ts = NULL, updated_at = now()
        WHERE id = $1 AND outcome IS NULL AND status = 'posted'
        RETURNING *`,
      [meta.stepId, userId, now, due],
    );
    if (!step) {
      await sendEphemeralNotice(interaction, alreadyHandledNotice());
      return { applied: false };
    }
    const prev = parseJson((existing && existing.payload) || step.payload) || {};
    await setStep(step.id, { payload: { ...prev, repost: true, snoozeUntil: due.toISOString() } }, dbClient);
    if (step.pending_reply_id) {
      await dbClient.query(
        `UPDATE pending_replies SET slack_message_ts = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('pending', 'flagged')`,
        [step.pending_reply_id],
      );
    }
    const { rows: [seq] } = await dbClient.query('SELECT * FROM followup_sequences WHERE id = $1', [step.sequence_id]);
    await recordOutcomeEvent({
      step, seq, outcome: 'snoozed', actionId: 'fseq_snooze', slackUserId: userId, dbClient,
      detail: { until: due.toISOString() },
    });
    const { rows: [client] } = seq
      ? await dbClient.query('SELECT slack_bot_token FROM clients WHERE id = $1', [seq.client_id])
      : { rows: [] };
    const oldChannel = (existing && existing.slack_channel) || meta.channel;
    const oldTs = (existing && existing.slack_ts) || meta.ts;
    if (prev.card && client && client.slack_bot_token && oldChannel && oldTs) {
      try {
        await slackApi.getClient(client.slack_bot_token).chat.update({
          channel: oldChannel,
          ts: oldTs,
          text: 'Snoozed',
          blocks: buildCallCardBlocks(prev.card, step.id, {
            outcome: 'snoozed', outcomeBy: userId,
            note: `Snoozed until ${ymd}. The card comes back then. Nothing was sent.`,
          }),
        });
      } catch (err) {
        console.warn('[FollowupSeq] could not close snoozed card', { err: err.message });
      }
    } else if (client && client.slack_bot_token && oldChannel && oldTs) {
      try {
        await slackApi.updateMessage(
          client.slack_bot_token, oldChannel, oldTs,
          `Snoozed until ${ymd}. Nothing was sent.`,
        );
      } catch (err) {
        console.warn('[FollowupSeq] could not close snoozed email card', { err: err.message });
      }
    }
    return { applied: true, due };
  }

  if (!meta.replyId) return { applied: false };
  const { rows: [reply] } = await dbClient.query(
    `SELECT pr.*, c.slack_bot_token FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id WHERE pr.id = $1`,
    [meta.replyId],
  );
  if (!reply) return { applied: false };
  await require('./followup-card-events').recordCardEvent({
    clientId: reply.client_id,
    pendingReplyId: reply.id,
    leadKey: reply.lead_email || null,
    eventType: 'snooze',
    actionId: 'fu_snooze',
    outcome: 'snoozed',
    slackUserId: userId,
    detail: { until: due.toISOString() },
  }, dbClient);
  if (reply.slack_bot_token && (meta.channel || reply.slack_channel_id)) {
    try {
      await slackApi.updateMessage(
        reply.slack_bot_token,
        meta.channel || reply.slack_channel_id,
        meta.ts || reply.slack_message_ts,
        `Snoozed until ${ymd}. Nothing was sent.`,
      );
    } catch (err) {
      console.warn('[FollowupSeq] could not close snoozed cadence card', { err: err.message });
    }
  }
  return { applied: true, due };
}

/**
 * No-show "Call instead": do not send the email. Queue a call card.
 * Idempotent on the step outcome.
 */
async function applyCallInstead({
  stepId, slackUserId = null, interaction = null, now = new Date(), dbClient = db, slackApi = slack,
} = {}) {
  const { sendEphemeralNotice } = require('./card-click-guard');
  let step = null;
  try {
    const { rows } = await dbClient.query(
      `UPDATE followup_sequence_steps
          SET outcome = 'call_instead', outcome_by = $2, outcome_at = $3, updated_at = now()
        WHERE id = $1 AND outcome IS NULL AND status = 'posted'
        RETURNING *`,
      [stepId, slackUserId, now],
    );
    step = rows[0] || null;
  } catch (err) {
    if (!(err && err.code === '22P02')) throw err;
  }
  if (!step) {
    if (stepId) {
      const skipped = await dbClient.query(
        `UPDATE pending_replies SET status = 'skipped', updated_at = now()
          WHERE id = $1 AND status IN ('pending', 'flagged')
          RETURNING id`,
        [stepId],
      ).catch((err) => (err && err.code === '22P02' ? { rows: [] } : Promise.reject(err)));
      if (skipped.rows && skipped.rows.length) {
        await sendEphemeralNotice(interaction, 'Call instead. This email will not send.');
        return { applied: true, queued: false };
      }
    }
    await sendEphemeralNotice(interaction, alreadyHandledNotice());
    return { applied: false };
  }
  if (step.pending_reply_id) {
    await dbClient.query(
      `UPDATE pending_replies SET status = 'skipped', updated_at = now()
        WHERE id = $1 AND status IN ('pending', 'flagged')`,
      [step.pending_reply_id],
    );
  }
  const { rows: [seq] } = await dbClient.query('SELECT * FROM followup_sequences WHERE id = $1', [step.sequence_id]);
  let queued = false;
  if (seq && seq.status === 'active') {
    const { rows: [ghostCall] } = await dbClient.query(
      `SELECT id, status FROM followup_sequence_steps WHERE sequence_id = $1 AND kind = 'ghost_call'`,
      [seq.id],
    );
    if (ghostCall && ['pending', 'held'].includes(ghostCall.status)) {
      await setStep(ghostCall.id, { due_at: now, status: 'pending' }, dbClient);
      queued = true;
    } else {
      const { rows: [{ n }] } = await dbClient.query(
        `SELECT count(*)::int AS n FROM followup_sequence_steps WHERE sequence_id = $1 AND kind LIKE 'call\\_callback\\_%'`,
        [seq.id],
      );
      const kind = `${text.CALLBACK_PREFIX}${n + 1}`;
      const ins = await dbClient.query(
        `INSERT INTO followup_sequence_steps (sequence_id, kind, seq_order, due_at, status, payload)
         VALUES ($1, $2, 25, $3, 'pending', $4::jsonb)
         ON CONFLICT (sequence_id, kind) DO NOTHING
         RETURNING id`,
        [seq.id, kind, now, JSON.stringify({ callInsteadOf: step.id })],
      );
      queued = ins.rows.length > 0;
    }
  }
  await recordOutcomeEvent({
    step, seq, outcome: 'call_instead', actionId: 'fseq_call_instead', slackUserId, dbClient,
  });
  const { rows: [client] } = seq
    ? await dbClient.query('SELECT slack_bot_token FROM clients WHERE id = $1', [seq.client_id])
    : { rows: [] };
  const channel = (interaction && interaction.channel && interaction.channel.id) || step.slack_channel;
  const ts = (interaction && interaction.message && interaction.message.ts) || step.slack_ts;
  if (client && client.slack_bot_token && channel && ts) {
    try {
      await slackApi.updateMessage(
        client.slack_bot_token, channel, ts,
        'Call instead. This email will not send. A call card is queued.',
      );
    } catch (err) {
      console.warn('[FollowupSeq] could not close call-instead card', { err: err.message });
    }
  }
  return { applied: true, queued };
}

module.exports = {
  enabled,
  enrollNewReplies,
  stopReasonForLead,
  stopSequence,
  stopSequencesForLead,
  runSequenceTick,
  applyStopRules,
  applyCallOutcome,
  handleCallButton,
  buildCallCardBlocks,
  offerFor,
  CALLBACK_MODAL_ID,
  claimLead,
  claimNote,
  buildCallbackModal,
  callbackTimeError,
  defaultCallbackTime,
  validateCallbackSubmission,
  openCallbackModal,
  scheduleCallback,
  handleCallbackSubmit,
  handleSnoozeSubmit,
  openSnoozeModal,
  openCadenceSnooze,
  applyCallInstead,
  snoozeDueAt,
  supersedeEarlierLeadCards,
  OUTCOME_BY_ACTION,
};
