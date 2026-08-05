-- Company one-liner for Slack DQ (website-first), and allow phone_enrichment_status='skipped'
-- so non-positive replies can be marked without burning waterfall credits.

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS lead_company_description TEXT,
  ADD COLUMN IF NOT EXISTS lead_company_category TEXT,
  ADD COLUMN IF NOT EXISTS company_description_status TEXT,
  ADD COLUMN IF NOT EXISTS company_description_error TEXT,
  ADD COLUMN IF NOT EXISTS company_described_at TIMESTAMPTZ;

ALTER TABLE pending_replies
  DROP CONSTRAINT IF EXISTS pending_replies_phone_enrichment_status_check;

ALTER TABLE pending_replies
  ADD CONSTRAINT pending_replies_phone_enrichment_status_check
  CHECK (
    phone_enrichment_status IS NULL
    OR phone_enrichment_status IN ('processing', 'found', 'not_found', 'failed', 'skipped')
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'pending_replies_company_description_status_check'
  ) THEN
    ALTER TABLE pending_replies
      ADD CONSTRAINT pending_replies_company_description_status_check
      CHECK (
        company_description_status IS NULL
        OR company_description_status IN ('processing', 'found', 'failed', 'skipped')
      );
  END IF;
END $$;
