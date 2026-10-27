-- Follow-up card sequence for positive replies (FOLLOWUP_SEQUENCE_ENABLED, off by default).
--
-- One sequence per positive reply; each step is a Slack card a human clicks.
-- Nothing here sends to a lead. Tables are inert until the flag is turned on.

CREATE TABLE IF NOT EXISTS followup_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  source_reply_id UUID NOT NULL REFERENCES pending_replies(id),
  platform TEXT NOT NULL,
  campaign_id TEXT,
  lead_key TEXT NOT NULL,
  lead_name TEXT,
  lead_email TEXT,
  linkedin_url TEXT,
  lead_timezone TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'stopped')),
  stop_reason TEXT,
  offered_starts JSONB NOT NULL DEFAULT '[]'::jsonb,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_reply_id)
);

-- A lead has at most one live sequence per client.
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_sequences_active_lead
  ON followup_sequences (client_id, lead_key) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS followup_sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  seq_order INTEGER NOT NULL,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'posting', 'posted', 'skipped', 'held', 'cancelled')),
  skip_reason TEXT,
  slack_channel TEXT,
  slack_ts TEXT,
  pending_reply_id UUID,
  outcome TEXT,
  outcome_by TEXT,
  outcome_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_followup_sequence_steps_due
  ON followup_sequence_steps (due_at) WHERE status IN ('pending', 'held');

-- Offer line + proof point per client/campaign, read from the campaign's own
-- email copy. source = 'campaign_copy' (extracted) or 'manual' (human override).
-- campaign_id '' means the client-wide default.
CREATE TABLE IF NOT EXISTS followup_sequence_copy (
  client_id UUID NOT NULL REFERENCES clients(id),
  campaign_id TEXT NOT NULL DEFAULT '',
  offer_line TEXT,
  proof_point TEXT,
  source TEXT NOT NULL DEFAULT 'campaign_copy',
  source_hash TEXT,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, campaign_id)
);
