-- Multi-step follow-up cadence (2h → 24h → 48h → 1 week) after we propose a meeting.
ALTER TABLE outbound_follow_ups
  ADD COLUMN IF NOT EXISTS step INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sequence_hours NUMERIC;
