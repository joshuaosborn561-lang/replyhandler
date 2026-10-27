-- Ghosted-meeting follow-up (GHOSTED_MEETING_ENABLED, off by default).
--
-- A booked meeting the prospect never showed up to is found, traced here, and
-- enrolled in the follow-up card sequence (origin = 'ghosted_meeting').
-- Nothing here sends to a lead; every outreach is a card a human approves.

-- A sequence now has an origin. One reply can have one sequence per origin
-- (the booked lead may already have had a normal positive-reply sequence).
ALTER TABLE followup_sequences ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'reply';
ALTER TABLE followup_sequences DROP CONSTRAINT IF EXISTS followup_sequences_source_reply_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_sequences_source_origin
  ON followup_sequences (source_reply_id, origin);

-- One row per booked meeting we looked at. `trail` is the stage-by-stage
-- history (candidate found, Fireflies checked, decided, posted, enrolled,
-- dropped) so any meeting can be traced after the fact.
CREATE TABLE IF NOT EXISTS ghosted_meeting_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  lead_key TEXT NOT NULL,
  lead_email TEXT,
  lead_name TEXT,
  meeting_start TIMESTAMPTZ NOT NULL,
  meeting_end TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  decision TEXT NOT NULL DEFAULT 'candidate'
    CHECK (decision IN ('candidate', 'held', 'ghosted', 'attended', 'enrolled', 'dropped')),
  reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  sequence_id UUID,
  trail JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, lead_key, meeting_start)
);

CREATE INDEX IF NOT EXISTS idx_ghosted_meeting_checks_open
  ON ghosted_meeting_checks (updated_at) WHERE decision IN ('candidate', 'held', 'ghosted');
