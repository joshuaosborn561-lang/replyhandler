-- MeetStream attendance tracking (MEETSTREAM_ATTENDANCE_ENABLED, off by default).
--
-- One row per meeting we may send the silent "Attendance" bot into. The bot
-- records nothing; it only reports who joined so a meeting can be marked
-- showed / no_show. Additive; nothing here touches campaigns or sends.

CREATE TABLE IF NOT EXISTS meeting_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,                 -- calendly_josh | booking_bridge | test
  booking_ref TEXT NOT NULL,            -- stable id from the source (Calendly event, TidyCal booking id)
  scope TEXT NOT NULL DEFAULT 'client'  -- josh | client
    CHECK (scope IN ('josh', 'client')),
  client_slug TEXT,
  meeting_url TEXT,
  platform TEXT,                        -- google_meet | zoom | teams | other
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  internal_names TEXT[] NOT NULL DEFAULT '{}',  -- display names that are not the prospect (host side)
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'creating', 'bot_requested', 'in_meeting',
                      'showed', 'no_show', 'unverified', 'failed', 'cancelled', 'skipped')),
  reason TEXT,
  bot_id TEXT,
  bot_status TEXT,
  bot_created_at TIMESTAMPTZ,
  bot_joined_at TIMESTAMPTZ,
  bot_left_at TIMESTAMPTZ,
  prospect_joined_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,  -- role + state only, no names
  events JSONB NOT NULL DEFAULT '[]'::jsonb,        -- capped webhook / decision trail
  est_cost_usd NUMERIC(8,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, booking_ref)
);

CREATE INDEX IF NOT EXISTS idx_meeting_attendance_status_start
  ON meeting_attendance (status, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_attendance_bot
  ON meeting_attendance (bot_id) WHERE bot_id IS NOT NULL;
