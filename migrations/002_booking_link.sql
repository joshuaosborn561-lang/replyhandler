-- Migration: Remove Cal.com, add booking_link (idempotent — safe if 002 was never run or partially applied).
-- Prefer this over a bare RENAME, which fails when calcom_event_type_id is already gone.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'calcom_event_type_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'booking_link'
  ) THEN
    ALTER TABLE clients RENAME COLUMN calcom_event_type_id TO booking_link;
  END IF;
END $$;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS booking_link TEXT;

ALTER TABLE meetings DROP COLUMN IF EXISTS calcom_booking_uid;
