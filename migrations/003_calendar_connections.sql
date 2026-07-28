-- Migration: Add calendar connections and meeting reminders
-- Run: psql "$DATABASE_URL" -f migrations/003_calendar_connections.sql

CREATE TABLE IF NOT EXISTS calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  email TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, provider)
);

-- Add columns to meetings for calendar event tracking and reminders
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS calendar_provider TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_link TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;
