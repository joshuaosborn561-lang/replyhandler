-- Lease token prevents a crashed/old phone enrichment worker from leaving a
-- row permanently stuck or overwriting a newer retry.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS phone_enrichment_claim_token UUID;
