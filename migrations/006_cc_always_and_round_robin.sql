-- 006_cc_always_and_round_robin.sql
-- Always-forward list + round-robin reps for client notify emails.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS cc_emails TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS cc_round_robin_emails TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS cc_round_robin_index INTEGER NOT NULL DEFAULT 0;
