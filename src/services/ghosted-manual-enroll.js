'use strict';

/**
 * Hand-enroll one ghosted meeting into the existing ghosted-meeting follow-up flow.
 *
 * Same pipeline as the scanner: a ghosted_meeting_checks row, then enrollGhost() which writes
 * a followup_sequences row (origin 'ghosted_meeting') and its steps. The sequence runner posts
 * the existing approval cards; a human clicks them. This file never sends to a lead and never
 * posts to Slack. The scanner's Fireflies / calendar attendance guess is skipped because a
 * person already decided the meeting was missed.
 *
 * manual:true is for a lead with no SmartLead / HeyReach reply (booked through Allo calls or Calendly):
 * it creates one inert context row in pending_replies (campaign_id 'manual-ghost', status skipped,
 * classification OTHER, so no recap, digest, scan or resurface job picks it up) and enrolls through the
 * same pipeline. Its approval card sends, once approved, as a new email from the SalesGlider Gmail
 * mailbox (see the send step in the reply sender). A lead that does have a real reply uses that reply instead.
 *
 * Idempotent: a lead (client + lead key) that already has a ghosted_meeting sequence, in any
 * status, is returned as already enrolled and nothing is written.
 */
const db = require('../db');
const ghost = require('./ghosted-meetings');
const { leadKey } = require('./follow-up-call-reminder');
const { isDisqualified } = require('./disqualified-prospects');
const { isLeadClaimed } = require('./client-claimed');
const { slugFromClientName, normalizeEmail } = require('./booking-bridge');
const crypto = require('crypto');
const manual = require('../utils/manual-ghost');

const MIN = 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

function fail(status, error, extra = {}) {
  return { status, body: { ok: false, error, ...extra } };
}

function parseWhen(raw, label) {
  if (raw == null || raw === '') return { value: null };
  const s = String(raw).trim();
  if (!HAS_OFFSET.test(s)) return { error: `${label} needs a timezone offset, e.g. 2026-10-30T15:00:00-05:00` };
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return { error: `${label} is not a valid time` };
  return { value: d };
}

async function resolveClient({ clientId, client, email }, dbClient) {
  if (clientId) {
    if (!UUID.test(String(clientId))) return { error: fail(400, 'clientId must be a uuid') };
    const { rows: [c] } = await dbClient.query('SELECT * FROM clients WHERE id = $1', [clientId]);
    return c ? { client: c } : { error: fail(404, 'client_not_found') };
  }
  if (client) {
    const wanted = String(client).trim().toLowerCase();
    const { rows } = await dbClient.query(`SELECT * FROM clients WHERE active IS DISTINCT FROM false`);
    const hits = rows.filter((c) => String(c.name || '').trim().toLowerCase() === wanted
      || slugFromClientName(c.name) === wanted);
    if (hits.length === 1) return { client: hits[0] };
    return { error: hits.length ? fail(409, 'client_ambiguous') : fail(404, 'client_not_found') };
  }
  // No client given: use the one client that has a reply from this lead.
  const { rows } = await dbClient.query(
    `SELECT DISTINCT c.* FROM pending_replies pr JOIN clients c ON c.id = pr.client_id
      WHERE lower(coalesce(pr.lead_email, '')) = $1 AND c.active IS DISTINCT FROM false`,
    [email],
  );
  if (rows.length === 1) return { client: rows[0] };
  return { error: rows.length ? fail(409, 'client_ambiguous', { hint: 'pass clientId or client' }) : fail(404, 'lead_not_found') };
}

function sendPathFor(kind) {
  return kind === 'manual'
    ? 'card approval, then a new email from the connected SalesGlider Gmail mailbox'
    : 'card approval, then a reply on the existing SmartLead / HeyReach thread';
}

/**
 * @returns {Promise<{status:number, body:object}>}
 */
async function enrollManual(input = {}, { now = new Date(), env = process.env, dbClient = db } = {}) {
  const email = normalizeEmail(input.leadEmail || input.lead_email);
  if (!email || !email.includes('@')) return fail(400, 'leadEmail required');
  const dryRun = input.dryRun === true || input.dryRun === 'true' || input.dry_run === true;

  const startP = parseWhen(input.meetingStart || input.meeting_start, 'meetingStart');
  const endP = parseWhen(input.meetingEnd || input.meeting_end, 'meetingEnd');
  if (startP.error) return fail(400, startP.error);
  if (endP.error) return fail(400, endP.error);
  const cfg = ghost.config(env);
  const start = startP.value || now;
  if (start > now) return fail(400, 'meetingStart is in the future; a meeting can only be missed after it starts');
  const end = endP.value || new Date(start.getTime() + (startP.value ? cfg.defaultDurationMs : 0));
  if (end <= start && startP.value) return fail(400, 'meetingEnd must be after meetingStart');

  const isManual = input.manual === true || input.manual === 'true';
  const leadName = String(input.leadName || input.lead_name || '').trim().slice(0, 120);
  const phone = String(input.phone || '').trim().slice(0, 40);
  const company = String(input.company || '').trim().slice(0, 120);
  if (isManual) {
    if (!leadName) return fail(400, 'manual mode needs leadName');
    if (!(input.clientId || input.client_id)) return fail(400, 'manual mode needs clientId');
    if (!startP.value) return fail(400, 'manual mode needs meetingStart');
  }

  const found = await resolveClient({ clientId: input.clientId || input.client_id, client: input.client, email }, dbClient);
  if (found.error) return found.error;
  const client = found.client;
  if (client.active === false) return fail(409, 'client_inactive');

  let source = await ghost.sourceReplyFor(client, email);
  let sourceKind = 'reply';
  let existingManual = null;
  if (isManual && !source) {
    sourceKind = 'manual';
    const { rows: [m] } = await dbClient.query(
      `SELECT * FROM pending_replies
        WHERE client_id = $1 AND campaign_id = $2 AND lower(coalesce(lead_email, '')) = $3
        ORDER BY created_at DESC LIMIT 1`,
      [client.id, manual.MANUAL_CAMPAIGN_ID, email],
    );
    existingManual = m || null;
    source = existingManual;
  }
  if (!source && !isManual) return fail(409, 'no_source_reply', { clientId: client.id, hint: 'pass manual:true for a lead without a SmartLead or HeyReach reply' });
  if (isManual && !source && !manual.clientMayManualSend(client)) {
    return fail(409, 'manual_send_not_supported_for_client', { clientId: client.id });
  }
  if (source && manual.isManualGhostReply(source)) sourceKind = 'manual';
  if (sourceKind === 'manual' && !manual.clientMayManualSend(client)) {
    return fail(409, 'manual_send_not_supported_for_client', { clientId: client.id });
  }
  const key = leadKey({ clientId: client.id, leadEmail: (source && source.lead_email) || email, linkedinUrl: source && source.linkedin_url, leadId: source && source.lead_id });

  const flag = { ghostedMeetingEnabled: ghost.enabled(env) };
  const note = flag.ghostedMeetingEnabled ? undefined
    : 'GHOSTED_MEETING_ENABLED is off: the sequence is enrolled but its card will not post until the flag is on.';

  // Idempotency: any ghosted_meeting sequence for this lead, in any status.
  const { rows: [prior] } = await dbClient.query(
    `SELECT id, status, enrolled_at FROM followup_sequences
      WHERE client_id = $1 AND origin = $2 AND (lead_key = $3 OR source_reply_id = $4::uuid)
      ORDER BY created_at DESC LIMIT 1`,
    [client.id, ghost.ORIGIN, key, source ? source.id : null],
  );
  if (prior) {
    return { status: 200, body: { ok: true, enrolled: false, alreadyEnrolled: true, sequenceId: prior.id, sequenceStatus: prior.status, ...flag } };
  }

  if (await isDisqualified(client.id, { leadEmail: email })) return fail(409, 'disqualified');
  if (source && !manual.isManualGhostReply(source)
    && await isLeadClaimed({ leadEmail: email, campaignId: source.campaign_id })) return fail(409, 'client_claimed');
  const { rows: [active] } = await dbClient.query(
    `SELECT id FROM followup_sequences WHERE client_id = $1 AND lead_key = $2 AND status = 'active' LIMIT 1`,
    [client.id, key],
  );
  if (active) return fail(409, 'sequence_already_active', { sequenceId: active.id });

  const warnings = [];
  const { rows: replied } = await dbClient.query(
    `SELECT 1 FROM pending_replies
      WHERE client_id = $1 AND upper(classification) <> 'FOLLOW_UP'
        AND lower(coalesce(lead_email, '')) = $2 AND created_at > $3 AND id IS DISTINCT FROM $4::uuid
        AND campaign_id IS DISTINCT FROM $5 LIMIT 1`,
    [client.id, email, start, source ? source.id : null, manual.MANUAL_CAMPAIGN_ID],
  );
  if (replied.length) warnings.push('prospect_replied_since_meeting');
  const { rows: openCard } = await dbClient.query(
    `SELECT 1 FROM pending_replies
      WHERE client_id = $1 AND upper(classification) = 'FOLLOW_UP' AND status IN ('pending', 'flagged')
        AND lower(coalesce(lead_email, '')) = $2 LIMIT 1`,
    [client.id, email],
  );
  if (openCard.length) warnings.push('open_follow_up_card_exists');
  if (note) warnings.push('ghosted_meeting_flag_off');

  if (dryRun) {
    return { status: 200, body: { ok: true, enrolled: false, dryRun: true, wouldEnroll: true, clientId: client.id, clientName: client.name, sourceKind, sendPath: sendPathFor(sourceKind), warnings, ...flag } };
  }

  if (!source) {
    // manual: no reply anywhere. One inert context row for the sequence and its cards to hang off.
    const leadId = `${manual.MANUAL_CAMPAIGN_ID}:${crypto.createHash('sha1').update(`${client.id}|${email}`).digest('hex').slice(0, 12)}`;
    const { rows: [row] } = await dbClient.query(
      `INSERT INTO pending_replies
         (client_id, platform, campaign_id, campaign_name, lead_id, lead_name, lead_full_name, lead_email,
          lead_phone, lead_phone_provider, phone_enrichment_status, lead_company,
          inbound_message, classification, status, suppression_reason, created_at)
       VALUES ($1, 'smartlead', $2, 'Manual ghosted meeting', $3, $4, $4, $5, $6, $7, $8, $9,
               '(no new reply from prospect)', 'OTHER', 'skipped', 'manual_ghost_context', $10)
       RETURNING *`,
      [client.id, manual.MANUAL_CAMPAIGN_ID, leadId, leadName, email, phone || null,
        phone ? 'manual' : null, phone ? 'found' : null, company || null, start],
    );
    source = row;
  }

  const reason = 'manual_enroll';
  const { rows: [inserted] } = await dbClient.query(
    `INSERT INTO ghosted_meeting_checks
       (client_id, lead_key, lead_email, lead_name, meeting_start, meeting_end, source, source_ref, decision, reason, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', NULL, 'ghosted', $7, $8::jsonb)
     ON CONFLICT (client_id, lead_key, meeting_start) DO NOTHING
     RETURNING *`,
    [client.id, key, email, source.lead_name || null, start, end,
      reason, JSON.stringify({ manual: true, meeting_time_given: Boolean(startP.value) })],
  );
  let check = inserted;
  if (!check) {
    const { rows: [existing] } = await dbClient.query(
      'SELECT * FROM ghosted_meeting_checks WHERE client_id = $1 AND lead_key = $2 AND meeting_start = $3', [client.id, key, start]);
    check = existing;
    if (check.sequence_id) {
      return { status: 200, body: { ok: true, enrolled: false, alreadyEnrolled: true, sequenceId: check.sequence_id, checkId: check.id, ...flag } };
    }
  }
  check.client_name = client.name;
  check.reason = reason; // the step payload carries it onto the cards
  ghost.log('manual_enroll', { check_id: check.id, client: client.name, warnings });

  const res = await ghost.enrollGhost(check, client, source, { now, env, dbClient });
  if (!res.ok) {
    await ghost.decide(dbClient, check, 'dropped', res.reason, { manual: true });
    if (res.reason === 'already_enrolled' || res.reason === 'sequence_already_active') {
      return { status: 200, body: { ok: true, enrolled: false, alreadyEnrolled: true, reason: res.reason, checkId: check.id, ...flag } };
    }
    return fail(409, res.reason, { checkId: check.id });
  }
  await ghost.decide(dbClient, check, 'enrolled', reason, { steps: res.steps, manual: true }, { sequenceId: res.sequenceId });
  return {
    status: 201,
    body: {
      ok: true, enrolled: true, alreadyEnrolled: false,
      sequenceId: res.sequenceId, checkId: check.id, steps: res.steps,
      clientId: client.id, clientName: client.name, meetingStart: start.toISOString(),
      sourceKind, sendPath: sendPathFor(sourceKind), warnings, ...flag, ...(note ? { note } : {}),
    },
  };
}

module.exports = { enrollManual };
