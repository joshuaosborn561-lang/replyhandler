-- Follow-up sequence: which caller claimed the lead (first caller to click any
-- call outcome). Later call cards use that caller's name and @-mention them.
ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS claimed_by_slack_id TEXT;
ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS claimed_by_name TEXT;
ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
