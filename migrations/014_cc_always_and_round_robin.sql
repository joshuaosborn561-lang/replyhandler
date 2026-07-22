-- 014_cc_always_and_round_robin.sql
-- Always-CC list + round-robin reps for SmartLead replies.
-- Legacy clients.cc_email is backfilled into cc_emails and kept in sync from the dashboard.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS cc_emails TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS cc_round_robin_emails TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS cc_round_robin_index INTEGER NOT NULL DEFAULT 0;

UPDATE clients
   SET cc_emails = cc_email
 WHERE cc_email IS NOT NULL
   AND btrim(cc_email) <> ''
   AND (cc_emails IS NULL OR btrim(cc_emails) = '');
