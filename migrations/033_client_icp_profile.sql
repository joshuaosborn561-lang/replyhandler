-- Per-client ICP profile used when topup.icp_variants / DEFAULT_CLIENT_VARIANTS
-- have no row. Built from Josh's Fireflies call transcripts (fact-grounded).
-- icp_status: ready | needs_review | skipped_existing
-- needs_review = no matching calls, missing FIREFLIES_API_KEY, or no grounded facts.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS icp_profile JSONB,
  ADD COLUMN IF NOT EXISTS icp_status TEXT,
  ADD COLUMN IF NOT EXISTS icp_reason TEXT,
  ADD COLUMN IF NOT EXISTS icp_source TEXT,
  ADD COLUMN IF NOT EXISTS icp_transcript_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS icp_built_at TIMESTAMPTZ;
