-- Persist contact enrichment as soon as an inbound reply is received.
-- Waterfall: GetLeads -> AI Ark -> LeadMagic.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS lead_phone TEXT,
  ADD COLUMN IF NOT EXISTS lead_phone_provider TEXT,
  ADD COLUMN IF NOT EXISTS lead_website TEXT,
  ADD COLUMN IF NOT EXISTS phone_enrichment_status TEXT,
  ADD COLUMN IF NOT EXISTS phone_enrichment_error TEXT,
  ADD COLUMN IF NOT EXISTS phone_enriched_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'pending_replies_phone_enrichment_status_check'
  ) THEN
    ALTER TABLE pending_replies
      ADD CONSTRAINT pending_replies_phone_enrichment_status_check
      CHECK (
        phone_enrichment_status IS NULL
        OR phone_enrichment_status IN ('processing', 'found', 'not_found', 'failed')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pending_replies_phone_enrichment_status
  ON pending_replies(phone_enrichment_status)
  WHERE phone_enrichment_status IS NULL OR phone_enrichment_status = 'failed';
