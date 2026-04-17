-- 010_pending_nudge_snooze.sql
-- Replace single-fire nudge with recurring nudge + snooze support.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS pending_nudge_next_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_nudge_snoozed_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_nudge_count INTEGER NOT NULL DEFAULT 0;

-- Seed schedule for any existing pending rows so they start getting recurring nudges.
UPDATE pending_replies
SET pending_nudge_next_at = created_at + interval '5 minutes'
WHERE status = 'pending'
  AND pending_nudge_next_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_replies_nudge_next
  ON pending_replies(pending_nudge_next_at)
  WHERE status = 'pending';
