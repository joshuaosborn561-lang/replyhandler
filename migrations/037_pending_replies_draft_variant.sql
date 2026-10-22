-- CALL_NOW_TEST (2026-10-21): tag which draft variant a card used so
-- meeting-booked rates can be compared against the prior week.
ALTER TABLE pending_replies ADD COLUMN IF NOT EXISTS draft_variant TEXT;
CREATE INDEX IF NOT EXISTS idx_pending_replies_draft_variant
  ON pending_replies (draft_variant) WHERE draft_variant IS NOT NULL;
