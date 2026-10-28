-- Manual nurture enrolment: leads added by hand (no follow-up sequence, no pending_replies row),
-- with their own subject and body, and optionally no HubSpot contact.
-- Additive and idempotent. Existing rows keep origin 'sequence'. Inert while the nurture flags are off.

ALTER TABLE nurture_leads ALTER COLUMN source_sequence_id DROP NOT NULL;
ALTER TABLE nurture_leads ALTER COLUMN source_reply_id DROP NOT NULL;

ALTER TABLE nurture_leads ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'sequence';
ALTER TABLE nurture_leads ADD COLUMN IF NOT EXISTS custom_subject TEXT;
ALTER TABLE nurture_leads ADD COLUMN IF NOT EXISTS custom_body TEXT;
-- True when the lead has no HubSpot contact: the sync and the card lookup skip HubSpot for it.
ALTER TABLE nurture_leads ADD COLUMN IF NOT EXISTS hubspot_skip BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE nurture_leads ADD COLUMN IF NOT EXISTS phone TEXT;
-- Shown on the card as "Last reply or call" / "Note" when there is no source reply to summarise.
ALTER TABLE nurture_leads ADD COLUMN IF NOT EXISTS card_summary TEXT;
ALTER TABLE nurture_leads ADD COLUMN IF NOT EXISTS card_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nurture_leads_origin_check') THEN
    ALTER TABLE nurture_leads ADD CONSTRAINT nurture_leads_origin_check CHECK (origin IN ('sequence', 'manual'));
  END IF;
  -- A sequence row must still point at its source; a manual row has neither.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nurture_leads_source_check') THEN
    ALTER TABLE nurture_leads ADD CONSTRAINT nurture_leads_source_check CHECK (
      origin = 'manual' OR (source_sequence_id IS NOT NULL AND source_reply_id IS NOT NULL));
  END IF;
END $$;
