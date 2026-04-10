-- Migration: Remove Cal.com, add booking_link
-- Run this against your Railway Postgres:
--   psql "$DATABASE_URL" -f migrations/002_booking_link.sql

ALTER TABLE clients RENAME COLUMN calcom_event_type_id TO booking_link;

ALTER TABLE meetings DROP COLUMN IF EXISTS calcom_booking_uid;
