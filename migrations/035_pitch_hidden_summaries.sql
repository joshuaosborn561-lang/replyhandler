-- Daily "N pitches hidden today" Slack line, once per client per calendar day.
CREATE TABLE IF NOT EXISTS pitch_hidden_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL,
  hidden_count INTEGER NOT NULL DEFAULT 0,
  slack_message_ts TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, digest_date)
);

CREATE INDEX IF NOT EXISTS idx_pitch_hidden_summaries_date
  ON pitch_hidden_summaries (digest_date DESC);
