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
const { inSendWindow, snapDueToSendWindow } = require('./outbound-follow-up');
const { isDisqualified } = require('./disqualified-prospects');
const { isLeadClaimed } = require('./client-claimed');
const { looksAlreadyBooked } = require('./booking-check');
const { isSlackTestFixtureReply } = require('./reply-send');
const { prospectBookingLink } = require('../utils/public-booking-link');
const { prefersInPersonMeeting, prefersCallbackCall } = require('../utils/meeting-modality');
const { formatCampaignDisplay, campaignNameFromReply } = require('../utils/campaign-display');
const time = require('../utils/followup-sequence-time');
const text = require('../utils/followup-sequence-text');

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
        AND NOT EXISTS (SELECT 1 FROM followup_sequences s WHERE s.source_reply_id = pr.id)
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
       ON CONFLICT (source_reply_id) DO NOTHING
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
  if (await isDisqualified(clientId, keys)) return 'disqualified';
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

/** Pure: the Slack blocks for a call card. `outcome` replaces the buttons. */
function buildCallCardBlocks(card, stepId, { outcome = null, outcomeBy = null, stopped = null, note = null } = {}) {
  const blocks = [];
  if (card.mention) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: card.mention } });
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📞 ${card.label}: ${card.leadName || 'Lead'}`.slice(0, 150) },
  });
  const facts = [
    `*Phone:* ${card.phone}`,
    `*Client:* ${card.clientName}`,
    card.localTime ? `*Their time now:* ${card.localTime}` : null,
    card.campaignDisplay ? `*Campaign:* ${card.campaignDisplay}` : null,
    card.linkedinUrl ? `*LinkedIn:* ${card.linkedinUrl}` : null,
    card.permalink ? `<${card.permalink}|Original reply card>` : null,
  ].filter(Boolean).join('\n');
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: facts } });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Say this:*\n>${String(card.script).replace(/\n/g, '\n>')}` },
  });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: card.voicemail
        ? `*If it goes to voicemail, say:*\n>${String(card.voicemail).replace(/\n/g, '\n>')}`
        : '_No voicemail on this call. Just hang up if no one answers._',
    },
  });
  if (outcome || stopped) {
    const label = stopped
      ? `🛑 Sequence stopped (${String(stopped).replace(/_/g, ' ')})`
      : (OUTCOME_LABELS[outcome] || outcome);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${label}${outcomeBy ? ` · <@${outcomeBy}>` : ''}` }],
    });
    if (note) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: note } });
  } else {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'When the call is over, click the one that happened. If you spoke to them, pick what they said. Emails to send show up as their own cards with Approve & Send / Edit.' }],
    });
    blocks.push({
      type: 'actions',
      elements: OUTCOME_BUTTONS.map((b) => ({
        type: 'button',
        text: { type: 'plain_text', text: b.text },
        action_id: b.actionId,
        value: stepId,
        ...(b.style ? { style: b.style } : {}),
      })),
    });
  }
  return blocks;
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
    return r;
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
  const caller = text.callerName(env);
  const args = { firstName: first, callerName: caller, clientName: client.name, offerLine, proofPoint };
  const script = text.callScript(args);
  const voicemail = text.voicemailScript(step.kind, args);
  let permalink = null;
  try {
    permalink = await slackApi.getPermalink(client.slack_bot_token, client.slack_channel_id, source.slack_message_ts);
  } catch { /* link is optional */ }
  const mention = String(env.FOLLOWUP_CALLER_SLACK_ID || '').trim();
  const card = {
    label: text.stepLabel(step.kind),
    leadName: source.lead_full_name || source.lead_name,
    phone: found.phone,
    clientName: client.name,
    localTime: leadLocalTime(now, tz),
    campaignDisplay: formatCampaignDisplay(campaignNameFromReply(source), source.campaign_id) || null,
    linkedinUrl: source.linkedin_url || null,
    permalink,
    script,
    voicemail,
    mention: mention ? `<@${mention}>` : null,
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
    payload: { card },
  }, dbClient);
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
    if (reply && isPostedSlackTs(reply.slack_message_ts)) {
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
      leadPhone: found.phone || undefined,
      phoneProvider: found.provider || undefined,
      reasoning: notes.join(' · '),
      needsClient: false,
      ccEmails: client.cc_emails || client.cc_email || undefined,
      inboundMessage: source.inbound_message || '(no new reply from prospect)',
      campaignDisplay: formatCampaignDisplay(campaignNameFromReply(source), source.campaign_id) || undefined,
      lastOutboundMessage: source.sent_reply || undefined,
      contextLabel: 'You sent',
      threadPermalink: permalink || undefined,
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
  await setStep(step.id, { status: 'posted', skip_reason: null, slack_channel: channel, slack_ts: posted.ts, posted_at: now }, dbClient);
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
async function applyStopRules({ dbClient = db, slackApi = slack, limit = 200 } = {}) {
  const { rows } = await dbClient.query(
    `SELECT s.id AS seq_id, pr.*
       FROM followup_sequences s
       JOIN pending_replies pr ON pr.id = s.source_reply_id
      WHERE s.status = 'active'
      ORDER BY s.created_at ASC
      LIMIT $1`,
    [limit],
  );
  let stopped = 0;
  for (const row of rows) {
    const { seq_id: seqId, ...source } = row;
    let reason = null;
    if (['meeting_booked'].includes(source.status)) reason = 'booked';
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
  if (!enabled(env)) return { ...totals, disabled: true };
  if (tickActive) return { ...totals, overlap: true };
  tickActive = true;
  try {
    await releaseStalePosting(dbClient);
    totals.stopped = await applyStopRules({ dbClient, slackApi });
    const e = await enrollNewReplies({ now, dbClient, env });
    totals.enrolled = e.enrolled;

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
        ORDER BY st.due_at ASC, st.seq_order ASC
        LIMIT $2`,
      [now, limit],
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
        const reason = await stopReasonForLead(source, { dbClient });
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

const OUTCOME_BY_ACTION = Object.fromEntries(OUTCOME_BUTTONS.map((b) => [b.actionId, b.outcome]));

/**
 * Record what happened on a call.
 *  - Meeting booked: marks the meeting booked, stops the sequence, closes unsent cards.
 *  - Not interested: stops the sequence and closes unsent cards.
 *  - No answer / voicemail: logged; on the Day 0 call it queues the voicemail email 5 min out.
 *  - Call back later: logged, sequence continues.
 *  - Wrong number: no more call cards for this lead; email steps continue.
 */
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
  return { applied: true, step, seq };
}

/** Slack route entry: handle one button click and redraw the card. */
async function handleCallButton(action, interaction, { dbClient = db, slackApi = slack } = {}) {
  const outcome = OUTCOME_BY_ACTION[action.action_id];
  if (!outcome) return;
  const userId = interaction.user && interaction.user.id;
  if (outcome === 'call_back') {
    // Not recorded yet: Gabe picks the callback time first, and the outcome is
    // recorded when the modal is submitted.
    await openCallbackModal({ stepId: action.value, interaction, dbClient, slackApi });
    return;
  }
  const res = await applyCallOutcome({ stepId: action.value, outcome, slackUserId: userId, dbClient, slackApi });
  if (!res.applied) {
    console.log('[FollowupSeq] call outcome ignored (already recorded or not posted)', { stepId: action.value });
    return;
  }
  const payload = parseJson(res.step.payload) || {};
  if (!payload.card) return;
  const { rows: [client] } = await dbClient.query('SELECT slack_bot_token FROM clients WHERE id = $1', [res.seq.client_id]);
  if (!client || !client.slack_bot_token) return;
  try {
    await slackApi.getClient(client.slack_bot_token).chat.update({
      channel: res.step.slack_channel,
      ts: res.step.slack_ts,
      text: `${payload.card.label}: ${outcome}`,
      blocks: buildCallCardBlocks(payload.card, res.step.id, { outcome, outcomeBy: userId }),
    });
  } catch (err) {
    console.warn('[FollowupSeq] could not redraw call card', { stepId: action.value, err: err.message });
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
async function scheduleCallback({ stepId, when, slackUserId = null, now = new Date(), dbClient = db }) {
  const { rows: [step] } = await dbClient.query(
    `UPDATE followup_sequence_steps
        SET outcome = 'call_back', outcome_by = $2, outcome_at = $3, updated_at = now()
      WHERE id = $1 AND outcome IS NULL AND status = 'posted'
      RETURNING *`,
    [stepId, slackUserId, now],
  );
  if (!step) return { applied: false };
  const { rows: [seq] } = await dbClient.query('SELECT * FROM followup_sequences WHERE id = $1', [step.sequence_id]);
  if (!seq || seq.status === 'stopped') return { applied: true, step, seq, scheduled: false };
  if (seq.status === 'completed') {
    // The last scheduled step already went out; the callback still has to fire.
    try {
      await dbClient.query(`UPDATE followup_sequences SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'completed'`, [seq.id]);
    } catch (err) {
      if (err && err.code === '23505') return { applied: true, step, seq, scheduled: false };
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
  return { applied: true, step, seq, scheduled: true, kind };
}

/** Modal submit (after the 3s acknowledgement): schedule the callback and say so on the card. */
async function handleCallbackSubmit(interaction, { dbClient = db, slackApi = slack, now = new Date() } = {}) {
  let meta = {};
  try { meta = JSON.parse(interaction.view?.private_metadata || '{}'); } catch { meta = {}; }
  const secs = interaction.view?.state?.values?.when_block?.when?.selected_date_time;
  if (!meta.stepId || !secs) return { applied: false };
  const userId = interaction.user && interaction.user.id;
  const when = new Date(secs * 1000);
  const res = await scheduleCallback({ stepId: meta.stepId, when, slackUserId: userId, now, dbClient });
  if (!res.applied) {
    console.log('[FollowupSeq] callback ignored (outcome already recorded)', { stepId: meta.stepId });
    return res;
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
        blocks: buildCallCardBlocks(payload.card, res.step.id, { outcome: 'call_back', outcomeBy: userId, note }),
      });
    } catch (err) {
      console.warn('[FollowupSeq] could not redraw call card', { stepId: meta.stepId, err: err.message });
    }
  }
  return res;
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
  CALLBACK_MODAL_ID,
  buildCallbackModal,
  callbackTimeError,
  defaultCallbackTime,
  validateCallbackSubmission,
  openCallbackModal,
  scheduleCallback,
  handleCallbackSubmit,
  OUTCOME_BY_ACTION,
};
