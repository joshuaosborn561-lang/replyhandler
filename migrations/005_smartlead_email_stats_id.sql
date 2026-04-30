-- Persist SmartLead email_stats_id for reply-email-thread API
ALTER TABLE pending_replies ADD COLUMN IF NOT EXISTS smartlead_email_stats_id TEXT;
