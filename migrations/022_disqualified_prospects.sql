-- Manual DQ from Slack: exclude a prospect from follow-up nudges.
-- Also allow pending_replies.status = 'disqualified' for the card that was DQ'd.

CREATE TABLE IF NOT EXISTS disqualified_prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  platform TEXT NOT NULL CHECK (platform IN ('smartlead', 'heyreach')),
  campaign_id TEXT,
  lead_id TEXT,
  conversation_id TEXT,
  lead_email TEXT,
  linkedin_url TEXT,
  lead_name TEXT,
  source_pending_reply_id UUID REFERENCES pending_replies(id) ON DELETE SET NULL,
  reason TEXT,
  created_by_slack_user TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disqualified_prospects_client
  ON disqualified_prospects(client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_disqualified_prospects_email
  ON disqualified_prospects(client_id, lower(lead_email))
  WHERE lead_email IS NOT NULL AND lead_email <> '';

CREATE INDEX IF NOT EXISTS idx_disqualified_prospects_lead
  ON disqualified_prospects(client_id, platform, COALESCE(campaign_id, ''), COALESCE(lead_id, ''))
  WHERE lead_id IS NOT NULL AND lead_id <> '';

CREATE INDEX IF NOT EXISTS idx_disqualified_prospects_conversation
  ON disqualified_prospects(client_id, platform, COALESCE(conversation_id, ''))
  WHERE conversation_id IS NOT NULL AND conversation_id <> '';

ALTER TABLE pending_replies
  DROP CONSTRAINT IF EXISTS pending_replies_status_check;

ALTER TABLE pending_replies
  ADD CONSTRAINT pending_replies_status_check
  CHECK (status IN (
    'pending', 'approved', 'rejected', 'sent', 'flagged',
    'alert_only', 'suppressed', 'disqualified'
  ));
