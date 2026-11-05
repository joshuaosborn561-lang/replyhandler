/**
 * Admin DQ for one prospect. Same write as the Slack DQ button and the call
 * card's DQ option: markDisqualified (disqualified_prospects, open cards,
 * follow-up sequence, thread + email follow-ups).
 *
 * dryRun defaults to true and only reports the rows that would change.
 */

const db = require('../db');
const { isDisqualified, markDisqualified, threadKeys } = require('./disqualified-prospects');
const { leadKey } = require('./follow-up-call-reminder');

const OPEN = new Set(['pending', 'alert_only', 'flagged']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 50;

function queryWith(deps) {
  if (deps && typeof deps.query === 'function') return deps.query;
  return (sql, params) => db.query(sql, params);
}

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function asText(value) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return String(value).trim();
}

function unique(list) {
  return [...new Set(list)];
}

function resolveDryRun(value) {
  if (value === undefined || value === null || value === '') return true;
  if (value === false || value === 0) return false;
  const s = String(value).trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return true;
}

function cleanReason(value) {
  const text = asText(value);
  if (text == null) return { error: 'reason must be a string' };
  if (!text) return { reason: 'admin_dq' };
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(text)) {
    return { error: 'reason must be 1-80 letters, numbers, or _.:-' };
  }
  return { reason: text };
}

function createdByOf({ actor, note, slackUserId }) {
  const who = asText(slackUserId) || asText(actor);
  const extra = asText(note);
  if (who == null || extra == null) return { error: 'actor, note, and slackUserId must be strings' };
  const whoClean = who.slice(0, 80);
  const extraClean = extra.slice(0, 180);
  if (whoClean && extraClean) return { createdBy: `${whoClean} | ${extraClean}`.slice(0, 300) };
  return { createdBy: whoClean || extraClean || null };
}

function idList(value) {
  if (value == null || value === '') return { ids: [] };
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length > MAX_ROWS) return { error: `pendingReplyIds accepts at most ${MAX_ROWS} ids` };
  const ids = [];
  for (const item of raw) {
    const id = asText(item);
    if (id == null || !id) continue;
    if (!UUID.test(id)) return { error: 'pendingReplyIds must be uuids' };
    ids.push(id.toLowerCase());
  }
  return { ids: unique(ids) };
}

function rowsConnect(a, b) {
  if (String(a.client_id) !== String(b.client_id)) return false;
  const ae = normEmail(a.lead_email);
  const be = normEmail(b.lead_email);
  if (ae && ae === be) return true;
  if (a.platform === 'smartlead' && b.platform === 'smartlead') {
    const al = String(a.lead_id || '');
    const bl = String(b.lead_id || '');
    if (al && al === bl) return true;
  }
  return false;
}

function clusterRows(rows) {
  const parent = rows.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (rowsConnect(rows[i], rows[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  rows.forEach((row, i) => {
    const key = find(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.values()];
}

function summarizeGroup(group) {
  return {
    clientId: group[0].client_id,
    replyCount: group.length,
    leadEmails: unique(group.map((r) => normEmail(r.lead_email)).filter(Boolean)).slice(0, 5),
    leadIds: unique(group
      .filter((r) => r.platform === 'smartlead')
      .map((r) => String(r.lead_id || ''))
      .filter(Boolean)).slice(0, 5),
  };
}

function threadOf(reply) {
  const keys = threadKeys(reply);
  return {
    platform: keys.platform || '',
    campaignId: keys.campaignId || '',
    leadId: keys.leadId || '',
    conversationId: keys.conversationId || '',
  };
}

function sameThread(row, thread) {
  return String(row.platform || '') === String(thread.platform || '')
    && String(row.campaign_id || '') === String(thread.campaignId || '')
    && String(row.lead_id || '') === String(thread.leadId || '')
    && String(row.conversation_id || '') === String(thread.conversationId || '');
}

function pickPrimary(rows, pendingIds) {
  const open = rows.filter((r) => OPEN.has(r.status));
  const wanted = new Set(pendingIds);
  const preferred = open.filter((r) => wanted.has(String(r.id).toLowerCase()));
  const pool = preferred.length ? preferred : (open.length ? open : rows);
  return pool.slice().sort((a, b) => {
    const ae = normEmail(a.lead_email) ? 1 : 0;
    const be = normEmail(b.lead_email) ? 1 : 0;
    if (ae !== be) return be - ae;
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  })[0];
}

function result(status, body) {
  return { status, body };
}

async function loadIdentifierRows(q, { email, leadId, clientId }) {
  const { rows } = await q(
    `SELECT * FROM pending_replies
      WHERE (
        ($1::text <> '' AND lower(coalesce(lead_email, '')) = $1)
        OR ($2::text <> '' AND platform = 'smartlead' AND coalesce(lead_id, '') = $2)
      )
      AND ($3::uuid IS NULL OR client_id = $3)`,
    [email, leadId, clientId],
  );
  return rows || [];
}

async function loadExpanded(q, clientId, emails, leadIds) {
  if (!emails.length && !leadIds.length) return [];
  const { rows } = await q(
    `SELECT * FROM pending_replies
      WHERE client_id = $1
        AND (
          (cardinality($2::text[]) > 0 AND lower(coalesce(lead_email, '')) = ANY($2::text[]))
          OR (
            cardinality($3::text[]) > 0
            AND platform = 'smartlead'
            AND coalesce(lead_id, '') = ANY($3::text[])
          )
        )`,
    [clientId, emails, leadIds],
  );
  return rows || [];
}

async function preview(q, ctx) {
  const keys = threadKeys(ctx.primary);
  const already = await isDisqualified(ctx.clientId, keys, { query: q });
  const tables = {
    disqualified_prospects: already ? [] : [{
      action: 'insert',
      client_id: ctx.clientId,
      platform: keys.platform,
      campaign_id: keys.campaignId,
      lead_id: keys.leadId,
      conversation_id: keys.conversationId,
      lead_email: keys.leadEmail,
      linkedin_url: keys.linkedinUrl,
      lead_name: keys.leadName,
      source_pending_reply_id: ctx.primary.id,
      reason: ctx.reason,
      created_by_slack_user: ctx.createdBy,
    }],
    pending_replies: ctx.open.map((r) => ({
      action: 'update',
      id: r.id,
      from: r.status,
      to: 'disqualified',
      slack_message_ts: r.slack_message_ts || null,
    })),
    followup_sequences: [],
    followup_sequence_steps: [],
    outbound_follow_ups: [],
  };

  const { rows: sequences } = await q(
    `SELECT id, source_reply_id, lead_key, status
       FROM followup_sequences
      WHERE client_id = $1 AND status = 'active'`,
    [ctx.clientId],
  );
  const replyIds = new Set(ctx.rows.map((r) => String(r.id)));
  const keysForLead = new Set(ctx.rows.map((r) => leadKey({
    clientId: r.client_id,
    leadEmail: r.lead_email,
    linkedinUrl: r.linkedin_url,
    leadId: r.lead_id,
  })).filter(Boolean));
  const stopping = (sequences || []).filter((seq) => (
    replyIds.has(String(seq.source_reply_id)) || keysForLead.has(seq.lead_key)
  ));
  tables.followup_sequences = stopping.map((seq) => ({
    action: 'update',
    id: seq.id,
    from: 'active',
    to: 'stopped',
    stop_reason: 'disqualified',
  }));

  if (stopping.length) {
    const { rows: steps } = await q(
      `SELECT id, sequence_id, kind, status
         FROM followup_sequence_steps
        WHERE sequence_id = ANY($1::uuid[])
          AND status IN ('pending', 'held', 'posting')`,
      [stopping.map((seq) => seq.id)],
    );
    tables.followup_sequence_steps = (steps || []).map((step) => ({
      action: 'update',
      id: step.id,
      sequence_id: step.sequence_id,
      kind: step.kind,
      from: step.status,
      to: 'cancelled',
      skip_reason: 'sequence_disqualified',
    }));
  }

  const threads = [];
  const seen = new Set();
  for (const reply of ctx.rows) {
    const thread = threadOf(reply);
    const sig = [thread.platform, thread.campaignId, thread.leadId, thread.conversationId].join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    threads.push(thread);
  }
  const emails = new Set(ctx.rows.map((r) => normEmail(r.lead_email)).filter(Boolean));
  const { rows: followUps } = await q(
    `SELECT id, platform, campaign_id, lead_id, conversation_id, lead_email, status
       FROM outbound_follow_ups
      WHERE client_id = $1 AND status = 'pending'`,
    [ctx.clientId],
  );
  tables.outbound_follow_ups = (followUps || []).flatMap((row) => {
    if (threads.some((thread) => sameThread(row, thread))) {
      return [{ action: 'update', id: row.id, from: 'pending', to: 'cancelled', skip_reason: null }];
    }
    if (emails.has(normEmail(row.lead_email))) {
      return [{
        action: 'update', id: row.id, from: 'pending', to: 'skipped', skip_reason: 'disqualified',
      }];
    }
    return [];
  });

  const counts = {};
  for (const [table, rows] of Object.entries(tables)) counts[table] = rows.length;
  return { tables, counts, already };
}

async function applyDq(q, ctx, deps) {
  const cancelPendingForThread = deps.cancelPendingForThread
    || require('./outbound-follow-up').cancelPendingForThread;
  const stopSequencesForLead = deps.stopSequencesForLead
    || require('./followup-sequence').stopSequencesForLead;
  const retireSlackCards = deps.retireSlackCards
    || require('./retire-slack-cards').retireSlackCards;
  const mark = deps.markDisqualified || markDisqualified;
  const queryable = { query: q };

  const seen = new Set();
  for (const reply of ctx.rows) {
    const thread = threadOf(reply);
    const sig = [thread.platform, thread.campaignId, thread.leadId, thread.conversationId].join('|');
    if (!thread.platform || seen.has(sig)) continue;
    seen.add(sig);
    await cancelPendingForThread(ctx.clientId, {
      platform: thread.platform,
      campaignId: thread.campaignId || null,
      leadId: thread.leadId || null,
      conversationId: thread.conversationId || null,
    }, queryable);
  }

  const emails = unique(ctx.rows.map((r) => normEmail(r.lead_email)).filter(Boolean));
  for (const email of emails) {
    await q(
      `UPDATE outbound_follow_ups
          SET status = 'skipped',
              skip_reason = 'disqualified',
              updated_at = now()
        WHERE client_id = $1
          AND status = 'pending'
          AND lower(lead_email) = $2`,
      [ctx.clientId, email],
    );
  }

  const marked = await mark({
    clientId: ctx.clientId,
    reply: ctx.primary,
    reason: ctx.reason,
    slackUserId: ctx.createdBy,
  });

  const openIds = ctx.open.map((r) => r.id);
  if (openIds.length) {
    await q(
      `UPDATE pending_replies
          SET status = 'disqualified',
              draft_reply = NULL,
              updated_at = now()
        WHERE client_id = $1
          AND id = ANY($2::uuid[])
          AND status IN ('pending', 'alert_only', 'flagged')
        RETURNING id`,
      [ctx.clientId, openIds],
    );
  }

  const slackCards = await retireSlackCards(ctx.open, { actionKind: 'disqualified' });
  for (const reply of ctx.rows) {
    await stopSequencesForLead(reply, 'disqualified');
  }
  return { marked, slackCards };
}

async function dqProspect(raw, deps = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const emailText = asText(src.leadEmail ?? src.email ?? src.lead_email);
  const leadText = asText(src.leadId ?? src.lead_id ?? src.smartleadLeadId ?? src.smartlead_lead_id);
  const clientText = asText(src.clientId ?? src.client_id);
  if (emailText == null || leadText == null || clientText == null) {
    return result(400, { error: 'bad_request', message: 'Identifiers must be strings.' });
  }
  const email = normEmail(emailText);
  const leadId = leadText;
  const clientId = clientText || null;
  if (!email && !leadId) {
    return result(400, { error: 'bad_request', message: 'lead email or Smartlead lead id is required.' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return result(400, { error: 'bad_request', message: 'lead email is not a valid email.' });
  }
  if (leadId && !/^[A-Za-z0-9_-]{1,80}$/.test(leadId)) {
    return result(400, { error: 'bad_request', message: 'Smartlead lead id is not valid.' });
  }
  if (clientId && !UUID.test(clientId)) {
    return result(400, { error: 'bad_request', message: 'clientId must be a uuid.' });
  }
  const ids = idList(src.pendingReplyIds ?? src.pending_reply_ids ?? src.replyIds ?? src.reply_ids);
  if (ids.error) return result(400, { error: 'bad_request', message: ids.error });
  const reason = cleanReason(src.reason);
  if (reason.error) return result(400, { error: 'bad_request', message: reason.error });
  const actor = createdByOf(src);
  if (actor.error) return result(400, { error: 'bad_request', message: actor.error });

  const dryRun = resolveDryRun(src.dryRun !== undefined ? src.dryRun : src.dry_run !== undefined ? src.dry_run : src.dry);
  const q = queryWith(deps);

  const matched = await loadIdentifierRows(q, { email, leadId, clientId });
  if (!matched.length) {
    return result(404, { error: 'no_match', message: 'No pending reply matches that lead.' });
  }
  if (matched.length > MAX_ROWS) {
    return result(409, {
      error: 'ambiguous_lead',
      message: 'Identifier matches too many replies. Pass clientId and a Smartlead lead id.',
    });
  }
  if (email && leadId) {
    const emailHit = matched.some((r) => normEmail(r.lead_email) === email);
    const idHit = matched.some((r) => r.platform === 'smartlead' && String(r.lead_id || '') === leadId);
    if (!emailHit || !idHit) {
      return result(409, {
        error: 'ambiguous_lead',
        message: 'Email and Smartlead lead id do not match the same lead.',
      });
    }
  }

  const groups = clusterRows(matched);
  if (groups.length !== 1) {
    const clients = unique(groups.map((g) => String(g[0].client_id)));
    return result(409, {
      error: 'ambiguous_lead',
      message: clients.length > 1 && !clientId
        ? 'Identifier matches more than one client. Pass clientId.'
        : 'Identifier matches more than one lead.',
      clients: groups.map(summarizeGroup),
    });
  }

  const seed = groups[0];
  const resolvedClientId = String(seed[0].client_id);
  const emails = unique(seed.map((r) => normEmail(r.lead_email)).filter(Boolean));
  const leadIds = unique(seed
    .filter((r) => r.platform === 'smartlead')
    .map((r) => String(r.lead_id || ''))
    .filter(Boolean));
  const expanded = await loadExpanded(q, resolvedClientId, emails, leadIds);
  const byId = new Map();
  for (const row of [...seed, ...expanded]) byId.set(String(row.id).toLowerCase(), row);
  const rows = [...byId.values()];
  if (rows.length > MAX_ROWS) {
    return result(409, {
      error: 'ambiguous_lead',
      message: 'That lead has too many reply rows to DQ in one call.',
    });
  }

  if (ids.ids.length) {
    const { rows: named } = await q(
      'SELECT id, client_id, platform, lead_id, lead_email FROM pending_replies WHERE id = ANY($1::uuid[])',
      [ids.ids],
    );
    const found = new Set((named || []).map((r) => String(r.id).toLowerCase()));
    const missing = ids.ids.filter((id) => !found.has(id));
    if (missing.length) {
      return result(404, { error: 'pending_reply_not_found', ids: missing });
    }
    const outside = ids.ids.filter((id) => !byId.has(id));
    if (outside.length) {
      return result(409, {
        error: 'pending_reply_not_this_lead',
        message: 'pendingReplyIds must be the same lead as the identifier.',
        ids: outside,
      });
    }
  }

  const primary = pickPrimary(rows, ids.ids);
  const open = rows.filter((r) => OPEN.has(r.status));
  const ctx = {
    clientId: resolvedClientId,
    rows,
    open,
    primary,
    reason: reason.reason,
    createdBy: actor.createdBy,
  };
  const plan = await preview(q, ctx);
  const lead = {
    clientId: resolvedClientId,
    leadEmail: normEmail(primary.lead_email) || email || null,
    leadId: (primary.platform === 'smartlead' && primary.lead_id) ? String(primary.lead_id) : (leadId || null),
    leadName: primary.lead_name || null,
    replyIds: rows.map((r) => r.id),
    openReplyIds: open.map((r) => r.id),
  };
  const body = {
    ok: true,
    dryRun,
    already: plan.already,
    reason: ctx.reason,
    actor: ctx.createdBy,
    lead,
    counts: plan.counts,
    tables: plan.tables,
  };

  if (dryRun) {
    console.log('[Admin] prospect dq dry run', { clientId: resolvedClientId, counts: plan.counts });
    return result(200, body);
  }

  const applied = await applyDq(q, ctx, deps);
  const followUps = plan.tables.outbound_follow_ups;
  body.result = {
    already: Boolean(applied.marked && applied.marked.already),
    cancelledFollowUps: followUps.filter((row) => row.to === 'cancelled').length,
    skippedFollowUps: followUps.filter((row) => row.to === 'skipped').length,
    slackCards: applied.slackCards || null,
  };
  console.log('[Admin] prospect dq', {
    clientId: resolvedClientId,
    replyId: primary.id,
    counts: plan.counts,
    already: body.result.already,
  });
  return result(200, body);
}

module.exports = {
  dqProspect,
  resolveDryRun,
};
