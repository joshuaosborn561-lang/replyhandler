/**
 * One card for Ariel Isaac Franco, posted once on deploy.
 *
 * Her reply is outside the poller lookback, so the inbox sweep never sees it.
 * This reads the stored row and posts only when that row has no Slack card.
 * A later boot sees the timestamp and does nothing. It does not send.
 */

const db = require('../db');
const { hasPostedSlackCard, refreshReferralDrafts } = require('./refresh-referral-draft');

const ARIEL_LEAD_EMAIL = 'ariel@orioncityscape.com';
const ARIEL_CAMPAIGN_ID = '4242292';
const ARIEL_MESSAGE_ID = '<CAMG6zTKkBAhuQ_EcpbKWUS9fFeENOT4XNA+We9WZoiWWm9ry6w@mail.gmail.com>';

const ACTIONED = new Set([
  'sent', 'approved', 'sending', 'rejected', 'disqualified', 'meeting_booked',
]);

function isArielRow(row) {
  if (!row) return false;
  const email = String(row.lead_email || '').trim().toLowerCase();
  const campaign = String(row.campaign_id || '').trim();
  return email === ARIEL_LEAD_EMAIL && campaign === ARIEL_CAMPAIGN_ID;
}

function pickArielRow(rows) {
  const hers = (rows || []).filter(isArielRow);
  if (!hers.length) return null;
  const byMessage = hers.find((row) => String(row.inbound_message_id || '').trim() === ARIEL_MESSAGE_ID);
  return byMessage || hers[0];
}

async function ensureArielReferralCard({
  query = (...args) => db.query(...args),
  refresh = refreshReferralDrafts,
} = {}) {
  const { rows } = await query(
    `SELECT id, lead_email, campaign_id, inbound_message_id, slack_message_ts, status
       FROM pending_replies
      WHERE lower(lead_email) = $1
        AND campaign_id::text = $2
        AND COALESCE(classification, '') <> 'FOLLOW_UP'
      ORDER BY created_at ASC`,
    [ARIEL_LEAD_EMAIL, ARIEL_CAMPAIGN_ID]
  );
  const hers = (rows || []).filter(isArielRow);
  if (!hers.length) return { action: 'no_row' };
  if (hers.some((row) => hasPostedSlackCard(row.slack_message_ts) || ACTIONED.has(String(row.status || '').toLowerCase()))) {
    return { action: 'already_posted' };
  }
  const target = pickArielRow(hers);
  const result = await refresh({
    dry: false,
    leadEmail: ARIEL_LEAD_EMAIL,
    campaignId: ARIEL_CAMPAIGN_ID,
    replyId: target.id,
    missingOnly: true,
  });
  const posted = (result.rows || []).find((row) => row.action === 'posted');
  return {
    action: posted ? 'posted' : 'skipped',
    replyId: target.id,
    result,
  };
}

module.exports = {
  ARIEL_LEAD_EMAIL,
  ARIEL_CAMPAIGN_ID,
  ARIEL_MESSAGE_ID,
  isArielRow,
  ensureArielReferralCard,
};
