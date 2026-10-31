/**
 * Keep every active client on an ICP: startup sweep + weekday hourly
 * window (6am–8pm America/Chicago). Empty / missing / never-built
 * statuses always run. needs_review retries once a day in case new
 * Fireflies calls appeared. Counts only.
 */

const {
  ensureClientIcp,
  needsIcpWork,
} = require('./client-icp-profile');
const { regradeNoIcpCards } = require('./regrade-no-icp-cards');

const ICP_BUILD_TZ = 'America/Chicago';
const ICP_BUILD_START_HOUR = 6;
const ICP_BUILD_END_HOUR = 20;
const RETRY_NEEDS_REVIEW_MS = 24 * 60 * 60 * 1000;
const ICP_CALL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

function icpAutoBuildEnabled(env = process.env) {
  return !/^(1|true|yes|on)$/i.test(String(env.DISABLE_ICP_AUTO_BUILD || '').trim());
}

function inIcpBuildWindow(date = new Date(), tz = ICP_BUILD_TZ) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return false;
  let weekday = 'Mon';
  let hour = 0;
  try {
    weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
    const raw = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false,
    }).format(d);
    hour = parseInt(raw, 10);
    if (hour === 24) hour = 0;
  } catch {
    weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] || 'Mon';
    hour = d.getHours();
  }
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return hour >= ICP_BUILD_START_HOUR && hour <= ICP_BUILD_END_HOUR;
}

async function runAutomaticIcpBuilds({
  db,
  firefliesApi,
  extractFn,
  fetchImpl,
  env = process.env,
  now = Date.now(),
  regradeFn = regradeNoIcpCards,
  ensureFn = ensureClientIcp,
} = {}) {
  if (!db) throw new Error('db is required');
  const { rows } = await db.query(
    `SELECT * FROM clients
      WHERE active IS DISTINCT FROM false
      ORDER BY created_at ASC`
  );

  const counts = {
    total: rows.length,
    considered: 0,
    skipped_existing: 0,
    ready: 0,
    needs_review: 0,
    missing_credentials: 0,
    no_calls: 0,
    no_facts: 0,
    regraded: 0,
    cards_updated: 0,
  };

  for (const client of rows) {
    if (!needsIcpWork(client, {
      includeNeedsReview: true,
      retryNeedsReviewAfterMs: RETRY_NEEDS_REVIEW_MS,
      now,
    })) {
      counts.skipped_existing += 1;
      continue;
    }
    counts.considered += 1;
    const result = await ensureFn(client, {
      db, firefliesApi, extractFn, fetchImpl, env,
      callLookbackMs: ICP_CALL_LOOKBACK_MS,
      now,
    });
    if (result.status === 'skipped_existing') counts.skipped_existing += 1;
    else if (result.status === 'ready') {
      counts.ready += 1;
      if (result.reason !== 'existing_profile') {
        try {
          const regrade = await regradeFn({ clientId: client.id, dbClient: db });
          counts.regraded += 1;
          counts.cards_updated += Number(regrade.updated) || 0;
        } catch (err) {
          console.warn('[IcpAuto] regrade skipped', { err: err.message });
        }
      }
    } else if (result.status === 'needs_review') {
      counts.needs_review += 1;
      if (result.reason === 'missing_credentials') counts.missing_credentials += 1;
      if (result.reason === 'no_calls') counts.no_calls += 1;
      if (result.reason === 'no_facts') counts.no_facts += 1;
    }
  }

  return counts;
}

module.exports = {
  ICP_BUILD_TZ,
  ICP_BUILD_START_HOUR,
  ICP_BUILD_END_HOUR,
  ICP_CALL_LOOKBACK_MS,
  icpAutoBuildEnabled,
  inIcpBuildWindow,
  runAutomaticIcpBuilds,
};
