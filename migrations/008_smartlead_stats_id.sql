-- 008_smartlead_stats_id.sql
-- Capture SmartLead email_stats_id at webhook ingestion for reliable threaded replies.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS smartlead_email_stats_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_replies_smartlead_stats_id
  ON pending_replies(smartlead_email_stats_id);
