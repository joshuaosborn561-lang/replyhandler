-- Portal takeover: a client claimed this lead (email + campaign).
-- Follow-ups and pending drafts stop. Classification is not changed.

CREATE TABLE IF NOT EXISTS client_claimed_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_email TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  status TEXT,
  claimed BOOLEAN NOT NULL DEFAULT true,
  last_note TEXT,
  client_id UUID REFERENCES clients(id),
  claimed_at TIMESTAMPTZ,
  cleared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_email, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_client_claimed_leads_claimed
  ON client_claimed_leads (lead_email, campaign_id)
  WHERE claimed = true;

ALTER TABLE pending_replies
  ADD COLUMN IF NOT EXISTS client_note TEXT;
