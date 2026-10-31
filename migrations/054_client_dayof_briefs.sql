-- Client day-of meeting briefs (Josh, Oct 31 2026).
-- Built about 2 hours before meetings.confirmed_time and held for review.
-- status: held (waiting), released (may send), blocked (never send).
-- One row per meeting. A restart does not insert a second copy.
-- Nothing here emails a client. The sender only reads rows with status released.

CREATE TABLE IF NOT EXISTS client_dayof_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'blocked')),
  subject TEXT,
  html_body TEXT,
  text_body TEXT,
  facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  to_emails TEXT,
  cc_emails TEXT,
  meeting_starts_at TIMESTAMPTZ,
  held_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  send_error TEXT,
  reviewer_notified_at TIMESTAMPTZ,
  reviewer_notify_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id)
);

CREATE INDEX IF NOT EXISTS idx_client_dayof_briefs_held
  ON client_dayof_briefs (meeting_starts_at)
  WHERE status = 'held';

CREATE INDEX IF NOT EXISTS idx_client_dayof_briefs_unsent
  ON client_dayof_briefs (released_at)
  WHERE status = 'released' AND sent_at IS NULL;
