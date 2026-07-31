-- Suppressed replies must leave a trace.
--
-- Suppression ran before the INSERT, so a silenced reply produced nothing but a
-- counter in the poll log — no lead name, no body, no way to answer "why did we
-- never see Scott's reply?". Store them with status 'suppressed' and the rule
-- that silenced them, so they are auditable after the fact.
ALTER TABLE pending_replies
  DROP CONSTRAINT IF EXISTS pending_replies_status_check;

ALTER TABLE pending_replies
  ADD CONSTRAINT pending_replies_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'flagged', 'alert_only', 'suppressed'));

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS suppression_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_replies_suppressed
  ON pending_replies(created_at DESC)
  WHERE status = 'suppressed';
