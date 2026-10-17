-- Allo cold-call bookings: source, confidence, call id, phone, Slack card.
-- Confirmed = Meeting Booked tag. Likely = transcript fallback (not recap-confirmed).

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS source_confidence TEXT NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS allo_call_id TEXT,
  ADD COLUMN IF NOT EXISTS lead_phone TEXT,
  ADD COLUMN IF NOT EXISTS allo_webhook_id TEXT,
  ADD COLUMN IF NOT EXISTS allo_user_email TEXT,
  ADD COLUMN IF NOT EXISTS allo_tags TEXT[],
  ADD COLUMN IF NOT EXISTS prospect_kind TEXT,
  ADD COLUMN IF NOT EXISTS proposed_times JSONB,
  ADD COLUMN IF NOT EXISTS slack_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS slack_message_ts TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS meetings_allo_call_id_uidx
  ON meetings (allo_call_id)
  WHERE allo_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS meetings_source_created_idx
  ON meetings (source, created_at DESC);

CREATE INDEX IF NOT EXISTS meetings_lead_phone_idx
  ON meetings (lead_phone)
  WHERE lead_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS meetings_lead_email_lower_idx
  ON meetings (lower(lead_email))
  WHERE lead_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS allo_webhook_events (
  webhook_id TEXT PRIMARY KEY,
  topic TEXT,
  call_id TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS allo_webhook_events_call_idx
  ON allo_webhook_events (call_id, processed_at DESC);
