const db = require('../db');
const slack = require('./slack');
const { PITCH_INBOUND_REASON, suppressPitchesEnabled } = require('../utils/slack-channel-policy');

const SUMMARY_TZ = process.env.PITCH_HIDDEN_SUMMARY_TIMEZONE || 'America/Chicago';

function dateInTimezone(tz, when = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = fmt.formatToParts(when);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
    return when.toISOString().slice(0, 10);
  } catch {
    return when.toISOString().slice(0, 10);
  }
}

function pitchHiddenSummaryText(n) {
  return slack.pitchHiddenSummaryText(n);
}

/**
 * One line per Slack channel: "N pitches hidden today", only when N > 0.
 * Idempotent per client per calendar day (America/Chicago unless overridden).
 */
async function postPitchHiddenSummaries({
  now = new Date(),
  dbClient = db,
  postFn = slack.postPitchHiddenSummary,
} = {}) {
  if (!suppressPitchesEnabled()) {
    return { posted: 0, skipped: 0, reason: 'flag_off' };
  }
  const digestDate = dateInTimezone(SUMMARY_TZ, now);
  const { rows } = await dbClient.query(
    `SELECT c.id AS client_id,
            c.slack_bot_token,
            c.slack_channel_id,
            COUNT(*)::int AS n
       FROM pending_replies pr
       JOIN clients c ON c.id = pr.client_id
      WHERE pr.status = 'suppressed'
        AND pr.suppression_reason = $1
        AND (pr.created_at AT TIME ZONE $2)::date = $3::date
        AND c.active IS DISTINCT FROM false
        AND c.slack_bot_token IS NOT NULL
        AND c.slack_bot_token <> ''
        AND c.slack_channel_id IS NOT NULL
        AND c.slack_channel_id <> ''
      GROUP BY c.id, c.slack_bot_token, c.slack_channel_id
     HAVING COUNT(*) > 0`,
    [PITCH_INBOUND_REASON, SUMMARY_TZ, digestDate],
  );

  const totals = { posted: 0, skipped: 0, date: digestDate };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    if (n <= 0) continue;
    const claimed = await dbClient.query(
      `INSERT INTO pitch_hidden_summaries (client_id, digest_date, hidden_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, digest_date) DO NOTHING
       RETURNING id`,
      [row.client_id, digestDate, n],
    );
    if (!claimed.rows.length) {
      totals.skipped += 1;
      continue;
    }
    try {
      const posted = await postFn(row.slack_bot_token, row.slack_channel_id, n);
      const ts = posted && typeof posted === 'object' ? (posted.ts || posted.message_ts || null) : null;
      await dbClient.query(
        `UPDATE pitch_hidden_summaries
            SET hidden_count = $1, slack_message_ts = $2
          WHERE id = $3`,
        [n, ts, claimed.rows[0].id],
      );
      totals.posted += 1;
    } catch (err) {
      console.error('[PitchHidden] Slack summary failed', {
        clientId: row.client_id, err: err.message,
      });
    }
  }
  return totals;
}

module.exports = {
  postPitchHiddenSummaries,
  pitchHiddenSummaryText,
  dateInTimezone,
  SUMMARY_TZ,
};
