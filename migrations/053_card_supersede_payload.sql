-- Card safety: a newer card supersedes older open ones, a failed send can be
-- retried, and the last rendered Slack payload lives on the row (not only in
-- process memory). Additive. Does not change campaign status.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS slack_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS card_payload JSONB,
  ADD COLUMN IF NOT EXISTS send_error TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by UUID;

ALTER TABLE pending_replies
  DROP CONSTRAINT IF EXISTS pending_replies_status_check;

ALTER TABLE pending_replies
  ADD CONSTRAINT pending_replies_status_check
  CHECK (status IN (
    'pending', 'approved', 'rejected', 'sent', 'flagged',
    'alert_only', 'suppressed', 'disqualified', 'meeting_booked',
    'sending', 'skipped', 'superseded', 'failed'
  ));

CREATE INDEX IF NOT EXISTS idx_pending_replies_open_lead
  ON pending_replies (client_id, platform, campaign_id, lead_id)
  WHERE status IN ('pending', 'flagged', 'alert_only', 'failed');
