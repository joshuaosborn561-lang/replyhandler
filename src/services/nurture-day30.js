'use strict';

/**
 * Day-30 nurture for leads whose positive-reply follow-up sequence ran out.
 *
 * Everything is behind flags, all off by default:
 *   NURTURE_ENABLED                 enrol leads and watch for exits (database only)
 *   NURTURE_HUBSPOT_SYNC_ENABLED    write the four nurture properties on the HubSpot contact
 *   NURTURE_POST_ENABLED            post the Day 30 card in #nurture
 *   NURTURE_SEND_ENABLED            Approve queues the approved email in Smartlead
 *
 * Nothing here sends on its own: a person clicks Approve on the card.
 * Stages: none / day30 / day90 / quarterly / paused / exited. Only the day30
 * touch has copy; day90 and quarterly stay disabled until Research sends it.
 */

const db = require('../db');
const slackSvc = require('./slack');
const t = require('../utils/nurture-day30-text');
const { inSendWindow, snapDueToSendWindow } = require('./outbound-follow-up');

const DAY = 24 * 60 * 60 * 1000;
const LIVE_STAGES = ['day30', 'day90', 'quarterly'];

function log(stage, fields = {}) {
  console.log(`[Nurture] ${stage}`, fields);
}

/** Real dependencies, loaded lazily so tests can swap any of them. */
function defaultDeps() {
  return {
    hubspot: require('./hubspot-nurture'),
    slackApi: slackSvc,
    smartleadNurture: require('./smartlead-nurture'),
    isDisqualified: (...a) => require('./disqualified-prospects').isDisqualified(...a),
    isLeadClaimed: (...a) => require('./client-claimed').isLeadClaimed(...a),
    looksAlreadyBooked: (...a) => require('./booking-check').looksAlreadyBooked(...a),
    hasUpcomingMeeting: (...a) => require('./booking-check').calendarHasEventWith(...a),
    phoneForFollowUp: (...a) => require('./follow-up-call-reminder').phoneForFollowUp(...a),
    enrichPhone: (...a) => require('./reply-phone-enrichment').enrichPendingReplyPhone(...a),
  };
}

function withDeps(deps) {
  return { ...defaultDeps(), ...(deps || {}) };
}

// ─── Lookups ──────────────────────────────────────────────────────────────────

async function loadSource(replyId, dbClient = db) {
  const { rows: [row] } = await dbClient.query('SELECT * FROM pending_replies WHERE id = $1', [replyId]);
  return row || null;
}

async function loadClient(clientId, dbClient = db) {
  const { rows: [row] } = await dbClient.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  return row || null;
}

function slackTokenFor(client, env = process.env) {
  return String(env.NURTURE_SLACK_BOT_TOKEN || '').trim() || (client && client.slack_bot_token) || '';
}

function smartleadKeyFor(client, env = process.env) {
  return String(env.NURTURE_SMARTLEAD_API_KEY || '').trim() || (client && client.smartlead_api_key) || '';
}

// ─── Exit rules ───────────────────────────────────────────────────────────────

/**
 * Should this lead still be in nurture?
 *   { action: 'ok' }
 *   { action: 'pause', reason }   a positive reply or a booked meeting: the follow-up flow owns them
 *   { action: 'exit',  reason }   DQ, not interested, unsubscribe, no-show rebook, client took the lead
 * Exits are checked before pauses.
 */
async function evaluateLead(lead, { dbClient = db, deps } = {}) {
  if (!lead.source_reply_id) {
    // A hand-enrolled lead has no source reply: judge it by its email alone.
    if (lead.origin === 'manual') return evaluateManual(lead, { dbClient, deps });
    return { action: 'exit', reason: 'source_reply_missing' };
  }
  const d = withDeps(deps);
  const source = await loadSource(lead.source_reply_id, dbClient);
  if (!source) return { action: 'exit', reason: 'source_reply_missing' };

  const keys = {
    platform: source.platform,
    campaignId: source.campaign_id,
    leadId: source.lead_id,
    leadEmail: source.lead_email,
    linkedinUrl: source.linkedin_url,
  };
  if (source.status === 'disqualified' || await d.isDisqualified(lead.client_id, keys)) {
    return { action: 'exit', reason: 'disqualified' };
  }
  if (await d.isLeadClaimed({ leadEmail: source.lead_email, campaignId: source.campaign_id })) {
    return { action: 'exit', reason: 'client_claimed' };
  }

  const email = String(source.lead_email || '').trim().toLowerCase();
  const li = String(source.linkedin_url || '').trim();
  const leadId = source.lead_id != null ? String(source.lead_id) : '';
  const { rows: later } = await dbClient.query(
    `SELECT upper(pr.classification) AS classification, pr.status
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
        )`,
    [lead.client_id, source.id, source.created_at, String(source.inbound_message || ''), email, li, leadId, source.platform],
  );
  for (const cls of ['REMOVE_ME', 'NOT_INTERESTED', 'WRONG_PERSON']) {
    if (later.some((r) => r.classification === cls)) {
      return { action: 'exit', reason: t.EXIT_CLASSIFICATIONS[cls] };
    }
  }

  const { rows: ghost } = await dbClient.query(
    `SELECT 1 FROM followup_sequences
      WHERE client_id = $1 AND lead_key = $2 AND origin = 'ghosted_meeting' AND created_at > $3
      LIMIT 1`,
    [lead.client_id, lead.lead_key, source.created_at],
  );
  if (ghost.length) return { action: 'exit', reason: 'no_show_rebook' };

  if (later.some((r) => t.POSITIVE_CLASSIFICATIONS.includes(r.classification))) {
    return { action: 'pause', reason: 'positive_reply' };
  }
  if (source.status === 'meeting_booked' || later.some((r) => r.status === 'meeting_booked')) {
    return { action: 'pause', reason: 'booked_meeting' };
  }
  const booked = await d.looksAlreadyBooked(lead.client_id, {
    platform: source.platform,
    leadEmail: source.lead_email,
    leadName: source.lead_name,
    leadId: source.lead_id,
    since: source.created_at,
  });
  if (booked) return { action: 'pause', reason: 'booked_meeting' };
  return { action: 'ok' };
}


/**
 * Exit rules for a hand-enrolled lead (no source reply, so everything is keyed on the email).
 * Only what happens after enrolment can pause or stop the lead: it was enrolled on purpose, so
 * its earlier replies are expected. A DQ counts at any time; a meeting counts only when it is still upcoming
 * (a booked meeting that never happened does not exclude the lead) or was booked after enrolment.
 */
async function evaluateManual(lead, { dbClient = db, deps } = {}) {
  const d = withDeps(deps);
  const email = String(lead.lead_email || '').trim().toLowerCase();
  const since = lead.enrolled_at || new Date();
  if (await d.isDisqualified(lead.client_id, { leadEmail: email })) return { action: 'exit', reason: 'disqualified' };

  const { rows: later } = await dbClient.query(
    `SELECT upper(pr.classification) AS classification, pr.status
       FROM pending_replies pr
      WHERE pr.client_id = $1
        AND $2::text <> '' AND lower(coalesce(pr.lead_email, '')) = $2
        AND upper(pr.classification) <> 'FOLLOW_UP'
        AND pr.created_at > $3`,
    [lead.client_id, email, since],
  );
  for (const cls of ['REMOVE_ME', 'NOT_INTERESTED', 'WRONG_PERSON']) {
    if (later.some((r) => r.classification === cls)) return { action: 'exit', reason: t.EXIT_CLASSIFICATIONS[cls] };
  }
  const { rows: ghost } = await dbClient.query(
    `SELECT 1 FROM followup_sequences
      WHERE client_id = $1 AND lead_key = $2 AND origin = 'ghosted_meeting' AND created_at > $3 LIMIT 1`,
    [lead.client_id, lead.lead_key, since],
  );
  if (ghost.length) return { action: 'exit', reason: 'no_show_rebook' };
  if (later.some((r) => t.POSITIVE_CLASSIFICATIONS.includes(r.classification))) return { action: 'pause', reason: 'positive_reply' };
  if (later.some((r) => r.status === 'meeting_booked')) return { action: 'pause', reason: 'booked_meeting' };
  // A meeting that was booked and never held (a no-show, a cancelled or moved slot) is why a manual lead
  // is here, so a past booking never excludes it (Josh, Oct 29). Only a meeting still ahead of us does.
  const upcoming = await d.hasUpcomingMeeting(lead.client_id, { leadEmail: email, leadName: lead.lead_name });
  if (upcoming) return { action: 'pause', reason: 'booked_meeting' };
  return { action: 'ok' };
}

// ─── HubSpot ──────────────────────────────────────────────────────────────────

/** Write the lead's four properties when HubSpot sync is on and the state changed. */
async function flushHubSpot(lead, { env = process.env, dbClient = db, deps } = {}) {
  if (!t.hubspotSyncEnabled(env)) return 'flag_off';
  if (lead.hubspot_skip) return 'skipped'; // no HubSpot contact for this lead: nothing to write
  const d = withDeps(deps);
  const key = t.hubspotStateKey(lead);
  if (lead.hubspot_synced_state === key) return 'in_sync';
  try {
    let contactId = lead.hubspot_contact_id;
    if (!contactId) {
      const contact = await d.hubspot.findContactByEmail(lead.lead_email, { env });
      contactId = contact && contact.id;
      if (contact && contact.company && !lead.company) {
        await dbClient.query('UPDATE nurture_leads SET company = $2 WHERE id = $1', [lead.id, contact.company]);
      }
    }
    if (!contactId) {
      await dbClient.query(
        'UPDATE nurture_leads SET hubspot_synced_at = now() WHERE id = $1', [lead.id]);
      return 'no_contact';
    }
    await d.hubspot.updateNurtureProperties(contactId, lead, { env });
    await dbClient.query(
      `UPDATE nurture_leads
          SET hubspot_contact_id = $2, hubspot_synced_state = $3, hubspot_synced_at = now()
        WHERE id = $1`,
      [lead.id, contactId, key],
    );
    return 'synced';
  } catch (err) {
    log('hubspot_sync_failed', { leadId: lead.id, status: err.status || null, err: err.message });
    return 'error';
  }
}

/** Push every lead whose state changed since its last sync. */
async function flushAllHubSpot({ env = process.env, dbClient = db, deps, limit = 100 } = {}) {
  if (!t.hubspotSyncEnabled(env)) return { skipped: 'flag_off' };
  const { rows } = await dbClient.query(
    `SELECT * FROM nurture_leads
      WHERE NOT hubspot_skip
        AND (hubspot_synced_at IS NULL
         OR hubspot_synced_at < updated_at
         OR (hubspot_synced_state IS NULL AND hubspot_synced_at < now() - interval '1 day'))
      ORDER BY updated_at LIMIT $1`,
    [limit],
  );
  const totals = { synced: 0, no_contact: 0, error: 0, in_sync: 0, skipped: 0 };
  for (const lead of rows) {
    const r = await flushHubSpot(lead, { env, dbClient, deps });
    if (totals[r] !== undefined) totals[r]++;
  }
  return totals;
}

// ─── Stage changes ────────────────────────────────────────────────────────────

/** Close any open Day 30 card for a lead and say why. */
async function closeOpenTouches(lead, reason, { env = process.env, dbClient = db, deps } = {}) {
  const d = withDeps(deps);
  const { rows } = await dbClient.query(
    `UPDATE nurture_touches
        SET status = 'cancelled', detail = $2, acted_at = now(), updated_at = now()
      WHERE nurture_lead_id = $1 AND status IN ('posting', 'posted')
      RETURNING id, slack_channel, slack_ts, status`,
    [lead.id, reason],
  );
  let closed = 0;
  for (const touch of rows) {
    if (!touch.slack_ts || !t.postEnabled(env)) continue;
    try {
      const client = await loadClient(lead.client_id, dbClient);
      const token = slackTokenFor(client, env);
      if (!token) continue;
      await d.slackApi.updateMessage(
        token, touch.slack_channel, touch.slack_ts,
        `Nurture closed (${String(reason).replace(/_/g, ' ')}). This card is closed.`,
      );
      closed++;
    } catch (err) {
      log('card_close_failed', { touchId: touch.id, err: err.message });
    }
  }
  return { cancelled: rows.length, closed };
}

/** Move a lead to paused or exited, stop its sends, and sync HubSpot. */
async function applyExit(lead, evaluation, { env = process.env, dbClient = db, deps } = {}) {
  const stage = evaluation.action === 'pause' ? 'paused' : 'exited';
  const { rows: [updated] } = await dbClient.query(
    `UPDATE nurture_leads
        SET stage = $2, exit_reason = $3, next_touch_at = NULL, updated_at = now()
      WHERE id = $1 AND stage IN ('day30', 'day90', 'quarterly', 'none', 'paused')
      RETURNING *`,
    [lead.id, stage, evaluation.reason],
  );
  if (!updated) return null;
  await closeOpenTouches(updated, evaluation.reason, { env, dbClient, deps });
  await flushHubSpot(updated, { env, dbClient, deps });
  log('lead_stopped', { leadId: lead.id, stage, reason: evaluation.reason });
  return updated;
}

// ─── Entry ────────────────────────────────────────────────────────────────────

/**
 * Enrol completed follow-up sequences. A sequence enters when it finished with
 * no stop, at least one follow-up went out, and the lead has not since replied,
 * booked, been DQ'd or unsubscribed.
 */
async function scanEntries({ now = new Date(), env = process.env, dbClient = db, deps, limit = 50 } = {}) {
  const totals = { enrolled: 0, paused: 0, exited: 0, skipped: 0 };
  const clientIds = t.nurtureClientIds(env);
  if (!clientIds.length) return { ...totals, note: 'NURTURE_CLIENT_IDS is empty' };
  const start = t.enrollStart(env);
  if (!start) return { ...totals, note: 'NURTURE_ENROLL_START is not set' };

  const { rows } = await dbClient.query(
    `SELECT s.id, s.client_id, s.source_reply_id, s.lead_key, s.lead_name, s.lead_email, s.linkedin_url,
            s.updated_at,
            (SELECT max(COALESCE(st.outcome_at,
                                 CASE WHEN st.pending_reply_id IS NOT NULL THEN pr.updated_at END,
                                 st.posted_at))
               FROM followup_sequence_steps st
               LEFT JOIN pending_replies pr ON pr.id = st.pending_reply_id
              WHERE st.sequence_id = s.id AND st.status = 'posted'
                AND ((st.pending_reply_id IS NOT NULL AND pr.status IN ('sent', 'approved', 'sending'))
                     OR (st.pending_reply_id IS NULL AND st.outcome IS NOT NULL))
            ) AS last_outreach_at
       FROM followup_sequences s
      WHERE s.status = 'completed' AND s.origin = 'reply'
        AND s.client_id = ANY($1::uuid[])
        AND s.updated_at >= $2
        AND NOT EXISTS (SELECT 1 FROM nurture_leads n WHERE n.source_sequence_id = s.id)
      ORDER BY s.updated_at
      LIMIT $3`,
    [clientIds, start, limit],
  );

  for (const seq of rows) {
    const base = {
      client_id: seq.client_id,
      source_sequence_id: seq.id,
      source_reply_id: seq.source_reply_id,
      lead_key: seq.lead_key,
      lead_name: seq.lead_name,
      lead_email: seq.lead_email,
      linkedin_url: seq.linkedin_url,
      last_outreach_at: seq.last_outreach_at,
    };
    let stage;
    let reason = null;
    let nextTouch = null;
    if (!seq.last_outreach_at) {
      stage = 'exited';
      reason = 'no_followup_sent';
    } else {
      const verdict = await evaluateLead({ ...base, id: null }, { dbClient, deps });
      if (verdict.action === 'exit') { stage = 'exited'; reason = verdict.reason; }
      else if (verdict.action === 'pause') { stage = 'paused'; reason = verdict.reason; }
      else {
        stage = 'day30';
        nextTouch = snapDueToSendWindow(t.addDays(seq.last_outreach_at, t.day30DelayDays(env)));
      }
    }
    try {
      // A paused row for this lead is superseded by a newer finished sequence.
      if (stage === 'day30' || stage === 'paused') {
        await dbClient.query(
          `UPDATE nurture_leads SET stage = 'exited', exit_reason = 'superseded', next_touch_at = NULL, updated_at = now()
            WHERE client_id = $1 AND lead_key = $2 AND stage = 'paused'`,
          [base.client_id, base.lead_key],
        );
      }
      const { rows: live } = await dbClient.query(
        `SELECT 1 FROM nurture_leads WHERE client_id = $1 AND lead_key = $2
            AND stage IN ('day30', 'day90', 'quarterly', 'paused') LIMIT 1`,
        [base.client_id, base.lead_key],
      );
      if (live.length && (stage === 'day30' || stage === 'paused')) {
        stage = 'exited';
        reason = 'already_in_nurture';
        nextTouch = null;
      }
      const { rows: [row] } = await dbClient.query(
        `INSERT INTO nurture_leads
           (client_id, source_sequence_id, source_reply_id, lead_key, lead_name, lead_email, linkedin_url,
            stage, next_touch_at, last_outreach_at, exit_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (source_sequence_id) DO NOTHING
         RETURNING *`,
        [base.client_id, base.source_sequence_id, base.source_reply_id, base.lead_key, base.lead_name,
          base.lead_email, base.linkedin_url, stage, nextTouch, base.last_outreach_at, reason],
      );
      if (!row) { totals.skipped++; continue; }
      if (stage === 'day30') totals.enrolled++;
      else if (stage === 'paused') totals.paused++;
      else totals.exited++;
      log('lead_entered', { leadId: row.id, stage, reason, nextTouch: nextTouch ? nextTouch.toISOString() : null });
    } catch (err) {
      totals.skipped++;
      log('enroll_failed', { sequenceId: seq.id, err: err.message });
    }
  }
  return totals;
}

/** Re-check every live lead and stop the ones that replied, booked, were DQ'd, unsubscribed or no-showed. */
async function syncExits({ env = process.env, dbClient = db, deps, limit = 200 } = {}) {
  const totals = { checked: 0, paused: 0, exited: 0 };
  const { rows } = await dbClient.query(
    `SELECT * FROM nurture_leads WHERE stage = ANY($1::text[]) ORDER BY updated_at LIMIT $2`,
    [LIVE_STAGES, limit],
  );
  for (const lead of rows) {
    totals.checked++;
    let verdict;
    try {
      verdict = await evaluateLead(lead, { dbClient, deps });
    } catch (err) {
      log('exit_check_failed', { leadId: lead.id, err: err.message });
      continue;
    }
    if (verdict.action === 'ok') continue;
    const updated = await applyExit(lead, verdict, { env, dbClient, deps });
    if (updated) totals[verdict.action === 'pause' ? 'paused' : 'exited']++;
  }
  return totals;
}

// ─── The card ─────────────────────────────────────────────────────────────────

function replySummary(source, lastCall) {
  const parts = [];
  if (source && source.inbound_message) {
    const cleaned = String(source.inbound_message)
      .split('\n').filter((l) => !/^\s*>/.test(l)).join(' ')
      .replace(/\s+/g, ' ').trim();
    if (cleaned) {
      const when = source.created_at ? t.chicagoDateLabel(source.created_at) : '';
      parts.push(`${when ? `Replied ${when}: ` : 'Replied: '}"${cleaned.slice(0, 260)}"`);
    }
  }
  if (lastCall && lastCall.outcome) {
    const when = lastCall.outcome_at ? ` (${t.chicagoDateLabel(lastCall.outcome_at)})` : '';
    parts.push(`Last call: ${String(lastCall.outcome).replace(/_/g, ' ')}${when}`);
  }
  return parts.join(' | ');
}

/**
 * Phone for the card: the reply's own number, then HubSpot, then one lookup.
 * The lookup is the existing reply-phone waterfall. It only runs for someone
 * who replied positively (FullEnrich is for people who replied), and it carries
 * its own spend ceiling.
 */
async function resolvePhone(lead, source, contact, { dbClient = db, deps } = {}) {
  const d = withDeps(deps);
  const found = await d.phoneForFollowUp(dbClient, {
    clientId: lead.client_id, sourceReplyId: lead.source_reply_id,
    leadEmail: lead.lead_email, linkedinUrl: lead.linkedin_url,
  });
  if (found && found.phone) return { phone: found.phone, note: null, source: 'reply' };
  if (lead.phone) return { phone: lead.phone, note: null, source: 'manual' };
  if (contact && contact.phone) return { phone: contact.phone, note: null, source: 'hubspot' };

  if (!source) return { phone: null, note: 'no lookup: no reply record on file', source: null };
  const replied = source && t.POSITIVE_CLASSIFICATIONS.includes(String(source.classification || '').toUpperCase());
  if (!replied) return { phone: null, note: 'no lookup: lead has not replied', source: null };
  const status = source.phone_enrichment_status;
  if (status === 'not_found' || status === 'skipped') {
    return { phone: null, note: `lookup already ran: ${status.replace('_', ' ')}`, source: null };
  }
  try {
    const result = await d.enrichPhone(lead.source_reply_id);
    const phone = result && (result.phone || result.phoneAlt);
    if (phone) return { phone, note: null, source: 'lookup' };
    return { phone: null, note: `lookup ran: ${(result && result.status) || 'not found'}`.replace('_', ' '), source: null };
  } catch (err) {
    log('phone_lookup_failed', { leadId: lead.id, err: err.message });
    return { phone: null, note: 'lookup failed', source: null };
  }
}

function callMention(env = process.env) {
  const raw = String(env.NURTURE_CALL_MENTIONS || env.FOLLOWUP_CALLERS || '').trim();
  const ids = [];
  for (const piece of raw.split(',')) {
    const id = piece.split(':')[0].trim();
    if (/^U[A-Z0-9]{6,}$/.test(id)) ids.push(id);
  }
  return ids.map((id) => `<@${id}>`).join(' ') || null;
}

function companyFor(lead, contact, source) {
  if (contact && contact.company) return contact.company;
  if (lead.company) return lead.company;
  const host = String(source && source.lead_website || lead.lead_email || '')
    .replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].split('@').pop();
  const stem = host.split('.')[0] || '';
  return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : '';
}

async function countPostedToday(now, dbClient = db) {
  const { rows: [r] } = await dbClient.query(
    `SELECT count(*)::int AS n FROM nurture_touches
      WHERE posted_at IS NOT NULL
        AND (posted_at AT TIME ZONE 'America/Chicago')::date = ($1::timestamptz AT TIME ZONE 'America/Chicago')::date`,
    [now],
  );
  return r ? r.n : 0;
}

async function dueLeads(now, limit, dbClient = db) {
  const { rows } = await dbClient.query(
    `SELECT l.* FROM nurture_leads l
      WHERE l.stage = ANY($1::text[]) AND l.next_touch_at IS NOT NULL AND l.next_touch_at <= $2
      ORDER BY l.next_touch_at LIMIT $3`,
    [LIVE_STAGES, now, limit],
  );
  return rows;
}

/** Build the card inputs for one lead (reads only, apart from the phone lookup). */
async function buildCard(lead, { env = process.env, dbClient = db, deps, lookupPhone = true } = {}) {
  const d = withDeps(deps);
  const source = lead.source_reply_id ? await loadSource(lead.source_reply_id, dbClient) : null;
  let contact = null;
  // A lead flagged as having no HubSpot contact is never looked up.
  if (!lead.hubspot_skip && (String(env.HUBSPOT_ACCESS_TOKEN || '').trim() || (deps && deps.hubspot))) {
    try { contact = await d.hubspot.findContactByEmail(lead.lead_email, { env }); }
    catch (err) { log('hubspot_lookup_failed', { leadId: lead.id, err: err.message }); }
  }
  const { rows: [lastCall] } = await dbClient.query(
    `SELECT kind, outcome, outcome_at FROM followup_sequence_steps
      WHERE sequence_id = $1 AND outcome IS NOT NULL ORDER BY outcome_at DESC NULLS LAST LIMIT 1`,
    [lead.source_sequence_id],
  );
  const phone = lookupPhone
    ? await resolvePhone(lead, source, contact, { dbClient, deps })
    : { phone: null, note: 'not looked up (preview)', source: null };
  // A lead enrolled by hand carries its own copy; it replaces the template (and stays editable on the card).
  const draft = lead.custom_subject && lead.custom_body
    ? { subject: lead.custom_subject, body: lead.custom_body }
    : t.composeDay30Draft({ leadName: lead.lead_name, repliedAt: source && source.created_at });
  const contactId = contact ? contact.id : (lead.hubspot_contact_id || null);
  return {
    card: {
      name: lead.lead_name,
      company: companyFor(lead, contact, source),
      lastOutreach: lead.last_outreach_at ? t.chicagoDateLabel(lead.last_outreach_at) : null,
      phone: phone.phone,
      phoneNote: phone.note,
      summary: lead.card_summary || replySummary(source, lastCall),
      note: lead.card_note || null,
      hubspotUrl: contactId ? t.hubspotContactUrl(contactId, env) : null,
      callMention: callMention(env),
      email: lead.lead_email,
      subject: draft.subject,
      body: draft.body,
    },
    contactId: contact ? contact.id : null,
    phone,
    draft,
  };
}

/** Post due Day 30 cards. With NURTURE_POST_ENABLED off this only reports what would post. */
async function runTouches({ now = new Date(), env = process.env, dbClient = db, deps, dryRun = false } = {}) {
  const totals = { due: 0, posted: 0, stopped: 0, disabled: 0, failed: 0, waited: 0, wouldPost: [] };
  const live = t.postEnabled(env) && !dryRun;
  if (live && !inSendWindow(now)) { totals.waited = 1; return totals; }
  const cap = t.maxCardsPerDay(env);
  const room = live ? Math.max(0, cap - await countPostedToday(now, dbClient)) : cap;
  if (live && room === 0) { totals.waited = 1; return totals; }

  const d = withDeps(deps);
  const leads = await dueLeads(now, 50, dbClient);
  for (const lead of leads) {
    if (lead.stage !== 'day30') { totals.disabled++; continue; } // day90 / quarterly have no copy yet
    const { rows: [existing] } = await dbClient.query(
      `SELECT id FROM nurture_touches WHERE nurture_lead_id = $1 AND kind = 'day30'`, [lead.id]);
    if (existing) continue;
    totals.due++;
    if (live && totals.posted >= room) { totals.waited++; continue; }

    const verdict = await evaluateLead(lead, { dbClient, deps });
    if (verdict.action !== 'ok') {
      await applyExit(lead, verdict, { env, dbClient, deps });
      totals.stopped++;
      continue;
    }
    if (!live) {
      const built = await buildCard(lead, { env, dbClient, deps, lookupPhone: false });
      totals.wouldPost.push({ leadId: lead.id, subject: built.draft.subject, valid: t.validateDay30Draft({ ...built.draft, leadName: lead.lead_name }).ok });
      continue;
    }

    const { rows: [claim] } = await dbClient.query(
      `INSERT INTO nurture_touches (nurture_lead_id, kind, status) VALUES ($1, 'day30', 'posting')
       ON CONFLICT (nurture_lead_id, kind) DO NOTHING RETURNING id`,
      [lead.id],
    );
    if (!claim) continue;
    try {
      const built = await buildCard(lead, { env, dbClient, deps });
      const check = t.validateDay30Draft({ ...built.draft, leadName: lead.lead_name });
      if (!check.ok) {
        await dbClient.query(
          `UPDATE nurture_touches SET status = 'failed', detail = $2, updated_at = now() WHERE id = $1`,
          [claim.id, `draft_invalid: ${check.errors.join(',')}`]);
        totals.failed++;
        continue;
      }
      const client = await loadClient(lead.client_id, dbClient);
      const token = slackTokenFor(client, env);
      if (!token) throw new Error('no Slack token for the nurture channel');
      const channel = t.nurtureChannel(env);
      const res = await d.slackApi.getClient(token).chat.postMessage({
        channel,
        text: `NURTURE: Day 30 touch for ${lead.lead_name || 'lead'}`,
        blocks: t.buildNurtureCardBlocks(built.card, claim.id),
      });
      await dbClient.query(
        `UPDATE nurture_touches
            SET status = 'posted', subject = $2, body = $3, phone = $4, phone_status = $5,
                slack_channel = $6, slack_ts = $7, posted_at = $8, updated_at = now()
          WHERE id = $1`,
        [claim.id, built.draft.subject, built.draft.body, built.phone.phone, built.phone.source || built.phone.note,
          channel, res.ts, now],
      );
      if (built.contactId && !lead.hubspot_contact_id) {
        await dbClient.query('UPDATE nurture_leads SET hubspot_contact_id = $2 WHERE id = $1', [lead.id, built.contactId]);
      }
      totals.posted++;
      log('card_posted', { leadId: lead.id, touchId: claim.id });
    } catch (err) {
      // Free the claim so the next tick retries; nothing was posted.
      await dbClient.query(`DELETE FROM nurture_touches WHERE id = $1 AND status = 'posting'`, [claim.id]);
      totals.failed++;
      log('card_post_failed', { leadId: lead.id, err: err.message });
    }
  }
  return totals;
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

async function loadTouch(touchId, dbClient = db) {
  const { rows: [touch] } = await dbClient.query(
    `SELECT tt.*, l.client_id AS lead_client_id FROM nurture_touches tt
       JOIN nurture_leads l ON l.id = tt.nurture_lead_id WHERE tt.id = $1`, [touchId]);
  return touch || null;
}

async function cardState(touch, label, by, { env, dbClient, deps }) {
  const d = withDeps(deps);
  const { rows: [lead] } = await dbClient.query('SELECT * FROM nurture_leads WHERE id = $1', [touch.nurture_lead_id]);
  const client = await loadClient(lead.client_id, dbClient);
  const token = slackTokenFor(client, env);
  if (!token || !touch.slack_ts) return;
  try {
    const built = await buildCard(lead, { env, dbClient, deps, lookupPhone: false });
    const card = { ...built.card, phone: touch.phone, phoneNote: null, subject: touch.subject, body: touch.body };
    await d.slackApi.getClient(token).chat.update({
      channel: touch.slack_channel, ts: touch.slack_ts,
      text: `${label}: ${lead.lead_name || lead.lead_email}`,
      blocks: t.buildNurtureCardBlocks(card, touch.id, { label, by }),
    });
  } catch (err) {
    log('card_update_failed', { touchId: touch.id, err: err.message });
  }
}

async function ephemeral(touch, userId, message, { env, dbClient, deps }) {
  const d = withDeps(deps);
  try {
    const { rows: [lead] } = await dbClient.query('SELECT client_id FROM nurture_leads WHERE id = $1', [touch.nurture_lead_id]);
    const client = await loadClient(lead.client_id, dbClient);
    const token = slackTokenFor(client, env);
    if (!token) return;
    await d.slackApi.getClient(token).chat.postEphemeral({
      channel: touch.slack_channel || t.nurtureChannel(env), user: userId, text: message,
    });
  } catch (err) {
    log('ephemeral_failed', { err: err.message });
  }
}

/**
 * Approve: queue the email in Smartlead. Every guard fails closed.
 * Returns { ok, outcome, reason? }.
 */
async function approveTouch(touchId, userId, { env = process.env, dbClient = db, deps, now = new Date(), edited = null } = {}) {
  const d = withDeps(deps);
  const ctx = { env, dbClient, deps };
  const peek = await loadTouch(touchId, dbClient);
  if (!peek) return { ok: false, outcome: 'not_found' };
  if (!t.isApprover(userId, env)) {
    await ephemeral(peek, userId, 'Only Josh or Cayden can approve nurture emails.', ctx);
    return { ok: false, outcome: 'denied' };
  }
  if (!t.sendEnabled(env)) {
    await ephemeral(peek, userId, 'Sending is switched off (NURTURE_SEND_ENABLED). Nothing was queued.', ctx);
    return { ok: false, outcome: 'send_disabled' };
  }

  const { rows: [touch] } = await dbClient.query(
    `UPDATE nurture_touches SET status = 'sending', actor_slack_id = $2, acted_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'posted' RETURNING *`,
    [touchId, userId],
  );
  if (!touch) {
    await ephemeral(peek, userId, 'This card was already handled.', ctx);
    return { ok: false, outcome: 'already_handled' };
  }
  const release = async (message, outcome, status = 'posted') => {
    await dbClient.query(`UPDATE nurture_touches SET status = $2, detail = $3, updated_at = now() WHERE id = $1`,
      [touchId, status, message]);
    await ephemeral(touch, userId, message, ctx);
    return { ok: false, outcome, reason: message };
  };
  const block = async (reason) => {
    await dbClient.query(`UPDATE nurture_touches SET status = 'cancelled', detail = $2, updated_at = now() WHERE id = $1`,
      [touchId, `blocked: ${reason}`]);
    await cardState(touch, `Blocked: ${String(reason).replace(/_/g, ' ')}`, userId, ctx);
    return { ok: false, outcome: 'blocked', reason };
  };

  const { rows: [lead] } = await dbClient.query('SELECT * FROM nurture_leads WHERE id = $1', [touch.nurture_lead_id]);
  const subject = edited ? edited.subject : touch.subject;
  const body = edited ? edited.body : touch.body;
  const check = t.validateDay30Draft({ subject, body, leadName: lead.lead_name });
  if (!check.ok) return release(`The email failed checks: ${check.errors.join(', ')}. Edit it and try again.`, 'invalid_draft');

  const verdict = await evaluateLead(lead, { dbClient, deps });
  if (verdict.action !== 'ok') {
    await applyExit(lead, verdict, ctx);
    return block(verdict.reason);
  }

  const client = await loadClient(lead.client_id, dbClient);
  const apiKey = smartleadKeyFor(client, env);
  const campaignId = t.smartleadCampaignId(env);
  if (!apiKey) return release('No Smartlead key is configured for nurture.', 'no_key');
  const sl = d.smartleadNurture;
  try {
    if (!await sl.sequenceUsesNurtureFields(apiKey, campaignId)) {
      return release(`Campaign ${campaignId} does not render the approved email (its sequence must use {{nurture_subject}} and {{nurture_body}}). Nothing was queued.`,
        'campaign_not_ready');
    }
    const pre = await sl.checkLeadBeforeImport(apiKey, lead.lead_email, campaignId);
    if (!pre.ok) {
      if (pre.reason === 'lookup_failed') return release('Could not check the lead in Smartlead. Try again.', 'lookup_failed');
      if (pre.reason === 'unsubscribed') {
        await applyExit(lead, { action: 'exit', reason: 'unsubscribed' }, ctx);
      }
      return block(pre.reason);
    }
    const imported = await sl.importNurtureLead(apiKey, campaignId, {
      email: lead.lead_email, name: lead.lead_name, company: lead.company || '',
      subject, body, touchId, kind: 'day30', hubspotContactId: lead.hubspot_contact_id || '',
    });
    if (!imported.ok) {
      if (imported.reason === 'unsubscribed') await applyExit(lead, { action: 'exit', reason: 'unsubscribed' }, ctx);
      return block(imported.reason);
    }
  } catch (err) {
    log('smartlead_queue_failed', { touchId, status: err.status || null, err: err.message });
    return release('Smartlead did not accept the email. Nothing was queued; try again.', 'smartlead_error');
  }

  await dbClient.query(
    `UPDATE nurture_touches
        SET status = 'queued', subject = $2, body = $3, smartlead_campaign_id = $4, detail = NULL, updated_at = now()
      WHERE id = $1`,
    [touchId, subject, body, campaignId],
  );
  const { rows: [after] } = await dbClient.query(
    `UPDATE nurture_leads
        SET last_outreach_at = $2, touch_count = touch_count + 1, stage = 'day90',
            next_touch_at = $3, exit_reason = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [lead.id, now, t.addDays(now, t.DAY90_GAP_DAYS)],
  );
  await flushHubSpot(after, ctx);
  await cardState({ ...touch, subject, body }, 'Queued in Smartlead', userId, ctx);
  log('touch_queued', { touchId, leadId: lead.id });
  return { ok: true, outcome: 'queued' };
}

/** Skip: no email for this touch. The lead moves on to day90 (disabled until it has copy). */
async function skipTouch(touchId, userId, { env = process.env, dbClient = db, deps, now = new Date() } = {}) {
  const ctx = { env, dbClient, deps };
  const peek = await loadTouch(touchId, dbClient);
  if (!peek) return { ok: false, outcome: 'not_found' };
  if (!t.isApprover(userId, env)) {
    await ephemeral(peek, userId, 'Only Josh or Cayden can skip nurture emails.', ctx);
    return { ok: false, outcome: 'denied' };
  }
  const { rows: [touch] } = await dbClient.query(
    `UPDATE nurture_touches SET status = 'skipped', actor_slack_id = $2, acted_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'posted' RETURNING *`, [touchId, userId]);
  if (!touch) return { ok: false, outcome: 'already_handled' };
  const { rows: [after] } = await dbClient.query(
    `UPDATE nurture_leads SET stage = 'day90', next_touch_at = $2, updated_at = now()
      WHERE id = $1 RETURNING *`, [touch.nurture_lead_id, t.addDays(now, t.DAY90_GAP_DAYS)]);
  await flushHubSpot(after, ctx);
  await cardState(touch, 'Skipped', userId, ctx);
  return { ok: true, outcome: 'skipped' };
}

async function openEditModal(touchId, interaction, { env = process.env, dbClient = db, deps } = {}) {
  const d = withDeps(deps);
  const userId = interaction.user && interaction.user.id;
  const touch = await loadTouch(touchId, dbClient);
  if (!touch) return { ok: false, outcome: 'not_found' };
  if (!t.isApprover(userId, env)) {
    await ephemeral(touch, userId, 'Only Josh or Cayden can edit nurture emails.', { env, dbClient, deps });
    return { ok: false, outcome: 'denied' };
  }
  if (touch.status !== 'posted') return { ok: false, outcome: 'already_handled' };
  const { rows: [lead] } = await dbClient.query('SELECT client_id FROM nurture_leads WHERE id = $1', [touch.nurture_lead_id]);
  const token = slackTokenFor(await loadClient(lead.client_id, dbClient), env);
  await d.slackApi.getClient(token).views.open({
    trigger_id: interaction.trigger_id,
    view: t.buildEditModal({
      touchId: touch.id, channel: touch.slack_channel, ts: touch.slack_ts, subject: touch.subject, body: touch.body,
    }),
  });
  return { ok: true, outcome: 'modal_opened' };
}

function readEditSubmission(interaction) {
  const values = (interaction.view && interaction.view.state && interaction.view.state.values) || {};
  const subject = (((values.subject_block || {}).subject_input) || {}).value || '';
  const body = (((values.body_block || {}).body_input) || {}).value || '';
  let meta = {};
  try { meta = JSON.parse(interaction.view.private_metadata || '{}'); } catch { meta = {}; }
  return { subject: subject.trim(), body: body.trim(), touchId: meta.touchId };
}

/** Validate an edit before closing the modal. Returns Slack `errors` or null. */
function validateEditSubmission(interaction, leadName = '') {
  const { subject, body } = readEditSubmission(interaction);
  const check = t.validateDay30Draft({ subject, body, leadName });
  if (check.ok) return null;
  return { body_block: `Fix before sending: ${check.errors.join(', ')}` };
}

async function handleEditSubmit(interaction, opts = {}) {
  const { subject, body, touchId } = readEditSubmission(interaction);
  const userId = interaction.user && interaction.user.id;
  return approveTouch(touchId, userId, { ...opts, edited: { subject, body } });
}

/** Slack route entry for the three buttons. */
async function handleButton(action, interaction, opts = {}) {
  const userId = interaction.user && interaction.user.id;
  const touchId = action.value;
  if (action.action_id === t.ACTION_APPROVE) return approveTouch(touchId, userId, opts);
  if (action.action_id === t.ACTION_SKIP) return skipTouch(touchId, userId, opts);
  if (action.action_id === t.ACTION_EDIT) return openEditModal(touchId, interaction, opts);
  return { ok: false, outcome: 'unknown_action' };
}

// ─── Tick and status ──────────────────────────────────────────────────────────

/** One scheduler pass. Does nothing at all unless NURTURE_ENABLED. */
async function runNurtureTick({ now = new Date(), env = process.env, dbClient = db, deps } = {}) {
  if (!t.enabled(env)) return { disabled: true };
  const result = { disabled: false };
  result.entries = await scanEntries({ now, env, dbClient, deps });
  result.exits = await syncExits({ env, dbClient, deps });
  result.touches = await runTouches({ now, env, dbClient, deps });
  result.hubspot = await flushAllHubSpot({ env, dbClient, deps });
  return result;
}

async function status({ dbClient = db, env = process.env } = {}) {
  const { rows: byStage } = await dbClient.query(
    `SELECT stage, count(*)::int AS n FROM nurture_leads GROUP BY stage ORDER BY stage`);
  const { rows: byOrigin } = await dbClient.query(
    `SELECT origin, count(*)::int AS n FROM nurture_leads GROUP BY origin ORDER BY origin`);
  const { rows: byReason } = await dbClient.query(
    `SELECT exit_reason, count(*)::int AS n FROM nurture_leads WHERE exit_reason IS NOT NULL GROUP BY exit_reason ORDER BY n DESC`);
  const { rows: touches } = await dbClient.query(
    `SELECT status, count(*)::int AS n FROM nurture_touches GROUP BY status ORDER BY status`);
  return {
    flags: {
      NURTURE_ENABLED: t.enabled(env),
      NURTURE_HUBSPOT_SYNC_ENABLED: t.hubspotSyncEnabled(env),
      NURTURE_POST_ENABLED: t.postEnabled(env),
      NURTURE_SEND_ENABLED: t.sendEnabled(env),
    },
    clientsConfigured: t.nurtureClientIds(env).length,
    enrollStart: t.enrollStart(env),
    byStage,
    byOrigin,
    exitReasons: byReason,
    touches,
  };
}

module.exports = {
  evaluateLead,
  evaluateManual,
  scanEntries,
  syncExits,
  runTouches,
  buildCard,
  resolvePhone,
  approveTouch,
  skipTouch,
  openEditModal,
  validateEditSubmission,
  handleEditSubmit,
  handleButton,
  flushHubSpot,
  flushAllHubSpot,
  applyExit,
  runNurtureTick,
  status,
  enabled: t.enabled,
  EDIT_MODAL_ID: t.EDIT_MODAL_ID,
};
