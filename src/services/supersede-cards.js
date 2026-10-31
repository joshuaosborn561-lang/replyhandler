/**
 * One open card per client + lead + campaign. When a newer card is posted,
 * earlier open rows are marked superseded and their Slack messages lose
 * their buttons.
 */

const db = require('../db');
const slackService = require('./slack');

const OPEN_CARD_STATUSES = ['pending', 'flagged', 'alert_only', 'failed'];
const POSTED_TS = /^\d+\.\d+$/;

function leadKeys(row) {
  const base = [
    String(row.client_id || ''),
    String(row.platform || ''),
    String(row.campaign_id || ''),
  ].join('|');
  const keys = [];
  const leadId = String(row.lead_id || '').trim();
  const email = String(row.lead_email || '').trim().toLowerCase();
  if (leadId) keys.push(`${base}|id:${leadId}`);
  if (email) keys.push(`${base}|em:${email}`);
  return keys;
}

function groupOpenRows(rows) {
  const parent = new Map();
  function find(id) {
    let cur = id;
    while (parent.get(cur) && parent.get(cur) !== cur) cur = parent.get(cur);
    parent.set(id, cur);
    return cur;
  }
  function union(a, b) {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent.set(pa, pb);
  }

  const list = (Array.isArray(rows) ? rows : []).filter((row) => leadKeys(row).length);
  const keyOwner = new Map();
  for (const row of list) {
    parent.set(row.id, row.id);
    for (const key of leadKeys(row)) {
      if (keyOwner.has(key)) union(row.id, keyOwner.get(key));
      else keyOwner.set(key, row.id);
    }
  }

  const groups = new Map();
  for (const row of list) {
    const root = find(row.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(row);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

function newestFirst(rows) {
  return [...rows].sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    if (ta !== tb) return tb - ta;
    return String(b.id).localeCompare(String(a.id));
  });
}

function supersedeFooter(permalink) {
  if (!permalink) return 'Superseded by newer card';
  return `Superseded by newer card\n<${permalink}|Open the newer card>`;
}

async function loadClient(query, clientId, cache) {
  if (cache.has(clientId)) return cache.get(clientId);
  const { rows } = await query('SELECT * FROM clients WHERE id = $1', [clientId]);
  const client = rows[0] || null;
  cache.set(clientId, client);
  return client;
}

async function paintSuperseded(row, { permalink, query, updateCard, cardContext, clientCache }) {
  const client = await loadClient(query, row.client_id, clientCache);
  const token = client?.slack_bot_token;
  const channelId = row.slack_channel_id || client?.slack_channel_id;
  const ts = String(row.slack_message_ts || '');
  if (!token || !channelId || !POSTED_TS.test(ts)) {
    return { painted: false, reason: 'no_slack_target' };
  }
  const helpers = require('../routes/slack').cardHelpers;
  const ctx = cardContext
    ? await cardContext(row, client)
    : await helpers.slackCardContextFromReply(row, client);
  const update = updateCard || slackService.updateSentConfirmationCard;
  await update(
    token,
    channelId,
    ts,
    helpers.sentCardPayload(row, ctx, {
      sentReply: null,
      actionKind: 'superseded',
      userId: null,
      extraFooter: supersedeFooter(permalink),
    })
  );
  return { painted: true, channelId, ts };
}

async function markSuperseded(query, row, keepId) {
  const { rowCount } = await query(
    `UPDATE pending_replies
        SET status = 'superseded',
            superseded_by = $2,
            updated_at = now()
      WHERE id = $1
        AND status = ANY($3::text[])`,
    [row.id, keepId || null, OPEN_CARD_STATUSES]
  );
  return rowCount > 0;
}

/**
 * Mark these older open rows superseded and rewrite each Slack card.
 * Slack is updated first. A Slack failure leaves the row open so a later
 * run can try again. A second run is a no-op once the row is superseded.
 */
async function supersedeRows(rows, {
  keepId,
  permalink,
  dryRun = false,
  query,
  updateCard,
  cardContext,
} = {}) {
  const out = { retired: [], kept: keepId ? [keepId] : [], skipped: 0, failed: 0, dryRun: Boolean(dryRun) };
  const run = query || ((sql, params) => db.query(sql, params));
  const clientCache = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id || row.id === keepId) {
      out.skipped += 1;
      continue;
    }
    if (dryRun) {
      out.retired.push(row.id);
      continue;
    }
    try {
      await paintSuperseded(row, {
        permalink, query: run, updateCard, cardContext, clientCache,
      });
      const marked = await markSuperseded(run, row, keepId);
      if (marked) out.retired.push(row.id);
      else out.skipped += 1;
    } catch (err) {
      out.failed += 1;
      console.warn('[Supersede] Could not retire card', { replyId: row.id, err: err.message });
    }
  }
  return out;
}

async function permalinkFor(token, channelId, ts, getPermalink) {
  const fn = getPermalink || slackService.getPermalink;
  try {
    return await fn(token, channelId, ts);
  } catch (err) {
    console.warn('[Supersede] Permalink failed', { err: err.message });
    return null;
  }
}

/**
 * After a new card is posted, retire earlier open rows for the same
 * client + lead + campaign.
 */
async function supersedeEarlierOpenCards({
  clientId,
  platform,
  campaignId,
  leadId,
  leadEmail,
  keepId,
  newTs,
  channelId,
  token,
  query,
  updateCard,
  cardContext,
  getPermalink,
} = {}) {
  const run = query || ((sql, params) => db.query(sql, params));
  const lid = leadId != null ? String(leadId).trim() : '';
  const email = leadEmail != null ? String(leadEmail).trim().toLowerCase() : '';
  if (!clientId || !keepId || (!lid && !email)) {
    return { retired: [], kept: keepId ? [keepId] : [], skipped: 0, failed: 0 };
  }
  const { rows } = await run(
    `SELECT *
       FROM pending_replies
      WHERE client_id = $1
        AND platform = $2
        AND COALESCE(campaign_id, '') = COALESCE($3::text, '')
        AND status = ANY($4::text[])
        AND COALESCE(classification, '') <> 'FOLLOW_UP'
        AND id <> $5
        AND slack_message_ts ~ '^[0-9]+[.][0-9]+$'
        AND (
          ($6::text <> '' AND COALESCE(lead_id, '') = $6)
          OR ($7::text <> '' AND lower(COALESCE(lead_email, '')) = $7)
        )
      ORDER BY created_at ASC`,
    [clientId, platform || '', campaignId != null ? String(campaignId) : '', OPEN_CARD_STATUSES, keepId, lid, email]
  );
  const link = await permalinkFor(token, channelId, newTs, getPermalink);
  return supersedeRows(rows, {
    keepId,
    permalink: link,
    query: run,
    updateCard,
    cardContext,
  });
}

async function fetchOpenCards(query) {
  const { rows } = await query(
    `SELECT *
       FROM pending_replies
      WHERE status = ANY($1::text[])
        AND COALESCE(classification, '') <> 'FOLLOW_UP'
        AND slack_message_ts ~ '^[0-9]+[.][0-9]+$'
        AND (
          COALESCE(NULLIF(lead_id, ''), '') <> ''
          OR COALESCE(NULLIF(lead_email, ''), '') <> ''
        )`,
    [OPEN_CARD_STATUSES]
  );
  return rows;
}

/**
 * Find open duplicate cards and retire every row except the newest in
 * each client + lead + campaign group.
 *
 * dryRun (default when the caller asks) changes nothing.
 */
async function retireDuplicateOpenCards({
  dryRun = true,
  query,
  updateCard,
  cardContext,
  getPermalink,
} = {}) {
  const run = query || ((sql, params) => db.query(sql, params));
  const rows = await fetchOpenCards(run);
  const groups = groupOpenRows(rows);
  const summary = {
    ok: true,
    dryRun: Boolean(dryRun),
    groups: groups.length,
    keep: [],
    retire: [],
    failed: 0,
    skipped: 0,
  };
  const clientCache = new Map();

  for (const group of groups) {
    const ordered = newestFirst(group);
    const keep = ordered[0];
    const older = ordered.slice(1);
    summary.keep.push(keep.id);
    if (dryRun) {
      for (const row of older) summary.retire.push(row.id);
      continue;
    }
    const client = await loadClient(run, keep.client_id, clientCache);
    const token = client?.slack_bot_token;
    const channelId = keep.slack_channel_id || client?.slack_channel_id;
    const link = await permalinkFor(token, channelId, keep.slack_message_ts, getPermalink);
    const result = await supersedeRows(older, {
      keepId: keep.id,
      permalink: link,
      dryRun: false,
      query: run,
      updateCard,
      cardContext,
    });
    summary.retire.push(...result.retired);
    summary.failed += result.failed;
    summary.skipped += result.skipped;
  }
  return summary;
}

module.exports = {
  OPEN_CARD_STATUSES,
  leadKeys,
  groupOpenRows,
  supersedeFooter,
  supersedeRows,
  supersedeEarlierOpenCards,
  retireDuplicateOpenCards,
};
