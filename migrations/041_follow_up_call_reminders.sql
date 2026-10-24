-- One "call before sending" reminder per lead per Central day on follow-up cards.
CREATE TABLE IF NOT EXISTS follow_up_call_reminders (
  lead_key TEXT NOT NULL,
  day DATE NOT NULL,
  reply_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_key, day)
);
