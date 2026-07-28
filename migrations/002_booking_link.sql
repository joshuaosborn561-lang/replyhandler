-- Migration: Remove Cal.com, add booking_link
-- Idempotent: only renames if the legacy column exists (fresh DBs already have booking_link
-- from schema.sql and don't need renaming).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'calcom_event_type_id'
  ) THEN
    ALTER TABLE clients RENAME COLUMN calcom_event_type_id TO booking_link;
  END IF;
END $$;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS booking_link TEXT;

ALTER TABLE meetings DROP COLUMN IF EXISTS calcom_booking_uid;
