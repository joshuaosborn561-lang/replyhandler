'use strict';

/**
 * Manual nurture enrolment: put a lead into Day-30 nurture by hand, with its own subject and body,
 * and no follow-up sequence or pending_replies row behind it.
 *
 * Nothing here sends or posts. It only writes nurture_leads rows (stage day30). The nurture flags
 * decide whether cards ever post, and a person still clicks Approve on each card. Dry run is the
 * default everywhere; a write needs apply: true.
 *
 * A lead is one object:
 *   { email, name, subject, body,                       required
 *     company, phone, summary, note,                    shown on the card
 *     last_outreach_at, due,                            ISO dates (due defaults to now, snapped into the send window)
 *     hubspot: false,                                   this lead has no HubSpot contact: skip every HubSpot call
 *     hubspot_contact_id,                               the contact, when already known
 *     override_prior_negative: true }                   enrol despite an earlier unsubscribe / not interested / wrong person
 *                                                       reply, for this lead only (a person decided it); a DQ still blocks
 * `flag` is accepted as a synonym for `note`; unknown fields are ignored.
 */

const db = require('../db');
const t = require('../utils/nurture-day30-text');
const nurture = require('./nurture-day30');
const { leadKey } = require('./follow-up-call-reminder');
const { snapDueToSendWindow } = require('./outbound-follow-up');

const MAX_LEADS = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NEGATIVE = ['REMOVE_ME', 'NOT_INTERESTED', 'WRONG_PERSON'];

function str(v) { return v == null ? '' : String(v).trim(); }

function parseDate(v) {
  if (v == null || v === '') return { value: null };
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? { value: d } : { error: true };
}

/**
 * Clean and check one lead. Pure. Returns { lead, errors, warnings }; a lead with errors is never written.
 */
function normalizeLead(raw, { now = new Date() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const warnings = [];
  const email = str(r.email).toLowerCase();
  if (!email) errors.push('missing_email');
  else if (!EMAIL_RE.test(email)) errors.push('bad_email');
  const name = str(r.name);
  if (!name) warnings.push('no_name');
  const subject = str(r.subject);
  const body = str(r.body).replace(/\r\n?/g, '\n');
  if (!subject) errors.push('missing_subject');
  if (!body) errors.push('missing_body');
  if (subject && body) {
    for (const code of t.validateDay30Draft({ subject, body, leadName: name }).errors) errors.push(`copy_${code}`);
    const greeting = /^hey\s+([^,\n]+),/i.exec(body);
    if (greeting && name) {
      const first = t.firstNameOf(greeting[1]).toLowerCase();
      const known = name.toLowerCase().split(/[\s,]+/).filter(Boolean);
      if (first && first !== 'there' && !known.some((k) => k.replace(/[^a-z'’.-]/g, '') === first)) warnings.push('greeting_name_differs_from_name');
    }
  }
  const last = parseDate(r.last_outreach_at != null ? r.last_outreach_at : r.lastOutreachAt);
  if (last.error) errors.push('bad_last_outreach_at');
  else if (last.value && last.value.getTime() > now.getTime() + 60000) errors.push('last_outreach_in_future');
  const due = parseDate(r.due != null ? r.due : r.next_touch_at);
  if (due.error) errors.push('bad_due');
  const hubspotSkip = r.hubspot === false || r.no_hubspot === true;
  const contactId = str(r.hubspot_contact_id);
  if (hubspotSkip && contactId) errors.push('hubspot_false_but_contact_id_given');
  return {
    lead: {
      email, name, subject, body,
      company: str(r.company), phone: str(r.phone),
      summary: str(r.summary), note: str(r.note != null ? r.note : r.flag),
      lastOutreachAt: last.value || null, due: due.value || null,
      hubspotSkip, hubspotContactId: contactId,
      ref: str(r.key || r.ref),
      overridePriorNegative: r.override_prior_negative === true,
    },
    errors,
    warnings,
  };
}

/**
 * Check a batch against the database and (only with apply: true) write it.
 *   clientId  the client the leads belong to (must exist)
 *   leads     array of lead objects (see the top of this file)
 *   apply     false = report only, nothing is written
 *   allowPartial  apply only the clean leads; default false = one problem blocks the whole batch
 * Returns { ok, applied, clientId, flags, summary, results: [{ index, ref, email, name, status, errors, warnings }] }.
 * status: ok | enrolled | invalid | blocked | already_in_nurture | duplicate_in_batch
 */
async function enrolManual({
  clientId, leads, apply = false, allowPartial = false, now = new Date(), env = process.env, dbClient = db, deps,
} = {}) {
  if (!clientId) return { ok: false, error: 'clientId_required' };
  if (!Array.isArray(leads) || !leads.length) return { ok: false, error: 'leads_required' };
  if (leads.length > MAX_LEADS) return { ok: false, error: `too_many_leads_max_${MAX_LEADS}` };
  const { rows: [client] } = await dbClient.query('SELECT id FROM clients WHERE id = $1', [clientId]);
  if (!client) return { ok: false, error: 'client_not_found' };

  const inEnv = t.nurtureClientIds(env).includes(String(clientId));
  const batchWarnings = [];
  if (!inEnv) batchWarnings.push('client_not_in_NURTURE_CLIENT_IDS');
  if (apply && !inEnv) return { ok: false, error: 'client_not_in_NURTURE_CLIENT_IDS' };

  const seen = new Set();
  const results = [];
  for (let i = 0; i < leads.length; i++) {
    const { lead, errors, warnings } = normalizeLead(leads[i], { now });
    const res = {
      index: i, ref: lead.ref || null, email: lead.email, name: lead.name,
      status: 'ok', errors: [...errors], warnings: [...warnings], _lead: lead,
    };
    results.push(res);
    if (errors.length) { res.status = 'invalid'; continue; }
    if (seen.has(lead.email)) { res.status = 'duplicate_in_batch'; res.errors.push('duplicate_in_batch'); continue; }
    seen.add(lead.email);

    const key = leadKey({ clientId, leadEmail: lead.email });
    const { rows: live } = await dbClient.query(
      `SELECT 1 FROM nurture_leads WHERE client_id = $1 AND lead_key = $2
          AND stage IN ('day30', 'day90', 'quarterly', 'paused') LIMIT 1`,
      [clientId, key]);
    if (live.length) { res.status = 'already_in_nurture'; res.warnings.push('already_in_nurture'); continue; }

    // Blocks that mean "do not nurture this person".
    const d = nurture_deps(deps);
    if (await d.isDisqualified(clientId, { leadEmail: lead.email })) { res.status = 'blocked'; res.errors.push('disqualified'); continue; }
    const { rows: neg } = await dbClient.query(
      `SELECT DISTINCT upper(classification) AS c FROM pending_replies
        WHERE client_id = $1 AND lower(coalesce(lead_email, '')) = $2 AND upper(classification) = ANY($3::text[])`,
      [clientId, lead.email, NEGATIVE]);
    if (neg.length && lead.overridePriorNegative) res.warnings.push(`prior_${neg[0].c.toLowerCase()}_reply_overridden`);
    else if (neg.length) { res.status = 'blocked'; res.errors.push(`prior_${neg[0].c.toLowerCase()}_reply`); continue; }
    const verdict = await nurture.evaluateManual(
      { client_id: clientId, lead_key: key, lead_email: lead.email, lead_name: lead.name, enrolled_at: now },
      { dbClient, deps });
    if (verdict.action !== 'ok') { res.status = 'blocked'; res.errors.push(`would_${verdict.action}_${verdict.reason}`); continue; }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  const problems = results.filter((r) => ['invalid', 'blocked', 'duplicate_in_batch'].includes(r.status)).length;
  const clean = results.filter((r) => r.status === 'ok');
  const summary = {
    total: results.length, ok: clean.length, invalid: count('invalid'), blocked: count('blocked'),
    duplicateInBatch: count('duplicate_in_batch'), alreadyInNurture: count('already_in_nurture'),
    withWarnings: results.filter((r) => r.warnings.length).length,
    hubspotSkipped: results.filter((r) => r._lead.hubspotSkip).length,
    hubspotContactKnown: results.filter((r) => r._lead.hubspotContactId).length,
    hubspotUnknown: results.filter((r) => !r._lead.hubspotSkip && !r._lead.hubspotContactId).length,
  };

  let applied = false;
  if (apply) {
    if (problems && !allowPartial) {
      for (const r of results) delete r._lead;
      return { ok: false, applied: false, error: 'batch_has_problems_nothing_written', clientId, flags: flagsOf(env), batchWarnings, summary, results };
    }
    for (const r of clean) {
      const l = r._lead;
      const key = leadKey({ clientId, leadEmail: l.email });
      const next = snapDueToSendWindow(l.due || now);
      const { rows: [row] } = await dbClient.query(
        `INSERT INTO nurture_leads
           (client_id, source_sequence_id, source_reply_id, origin, lead_key, lead_name, lead_email, company,
            stage, next_touch_at, last_outreach_at, custom_subject, custom_body, hubspot_skip, hubspot_contact_id,
            phone, card_summary, card_note, enrolled_at)
         VALUES ($1, NULL, NULL, 'manual', $2, $3, $4, $5, 'day30', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT DO NOTHING RETURNING id`,
        [clientId, key, l.name || null, l.email, l.company || null, next, l.lastOutreachAt, l.subject, l.body,
          l.hubspotSkip, l.hubspotContactId || null, l.phone || null, l.summary || null, l.note || null, now]);
      if (row) { r.status = 'enrolled'; r.leadId = row.id; r.nextTouchAt = next.toISOString(); applied = true; }
      else { r.status = 'already_in_nurture'; r.warnings.push('already_in_nurture'); }
    }
    summary.enrolled = results.filter((r) => r.status === 'enrolled').length;
  }
  for (const r of results) delete r._lead;
  return { ok: true, applied, apply, clientId, flags: flagsOf(env), batchWarnings, summary, results };
}

function nurture_deps(deps) {
  return {
    isDisqualified: (...a) => require('./disqualified-prospects').isDisqualified(...a),
    ...(deps || {}),
  };
}

function flagsOf(env) {
  return {
    NURTURE_ENABLED: t.enabled(env),
    NURTURE_HUBSPOT_SYNC_ENABLED: t.hubspotSyncEnabled(env),
    NURTURE_POST_ENABLED: t.postEnabled(env),
    NURTURE_SEND_ENABLED: t.sendEnabled(env),
  };
}

module.exports = { normalizeLead, enrolManual, MAX_LEADS };
