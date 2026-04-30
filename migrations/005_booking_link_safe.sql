-- Safe migration: ensure clients.booking_link exists.
-- Use when PATCH /admin/clients fails with "column booking_link does not exist"
-- (e.g. DB created before booking_link, or migrations/002 never applied because calcom_event_type_id was missing).
--
-- Run: psql "$DATABASE_URL" -f migrations/005_booking_link_safe.sql

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
