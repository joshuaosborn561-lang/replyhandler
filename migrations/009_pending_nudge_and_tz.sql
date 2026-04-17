-- 009_pending_nudge_and_tz.sql
-- Support the 5-minute "did you already reply?" nudge and per-client timezone for 8am digest.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS pending_nudge_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pending_replies_nudge_scan
  ON pending_replies(status, created_at)
  WHERE status = 'pending';

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS digest_timezone TEXT;

-- Track which client-days we've already sent a digest for so we don't duplicate.
CREATE TABLE IF NOT EXISTS morning_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  slack_message_ts TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, digest_date)
);
