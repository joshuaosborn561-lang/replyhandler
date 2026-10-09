-- Per-reply enrichment receipt + optional cellphone alt + client ceilings.
-- LeadMagic is gone; the job writes spend/tier onto enrichment_receipt.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS enrichment_receipt JSONB,
  ADD COLUMN IF NOT EXISTS lead_phone_alt TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS reply_enrich_ceiling_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS reply_enrich_ceiling_hot_usd NUMERIC;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pending_replies_phone_enrichment_status_check'
  ) THEN
    ALTER TABLE pending_replies
      DROP CONSTRAINT pending_replies_phone_enrichment_status_check;
  END IF;
END $$;

ALTER TABLE pending_replies
  ADD CONSTRAINT pending_replies_phone_enrichment_status_check
  CHECK (
    phone_enrichment_status IS NULL
    OR phone_enrichment_status IN ('processing', 'found', 'not_found', 'failed', 'skipped')
  );
