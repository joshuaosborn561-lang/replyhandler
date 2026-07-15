-- 013_client_cc_email.sql
-- Per-client CC email + per-reply toggle for SmartLead sends from Slack.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS cc_email TEXT;

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS cc_on_send BOOLEAN NOT NULL DEFAULT false;
