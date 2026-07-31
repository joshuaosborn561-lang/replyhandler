-- Follow-ups can now resolve without a Slack card: the prospect booked, proposed
-- a time, or a recorded call showed the meeting was set. Record which.
ALTER TABLE outbound_follow_ups
  DROP CONSTRAINT IF EXISTS outbound_follow_ups_status_check;

ALTER TABLE outbound_follow_ups
  ADD CONSTRAINT outbound_follow_ups_status_check
  CHECK (status IN ('pending', 'notified', 'cancelled', 'skipped'));

ALTER TABLE outbound_follow_ups
  ADD COLUMN IF NOT EXISTS skip_reason TEXT,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
