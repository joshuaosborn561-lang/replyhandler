-- Remind in Slack if prospect has not replied within N hours after our outbound message.
CREATE TABLE IF NOT EXISTS outbound_follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('smartlead', 'heyreach')),
  campaign_id TEXT,
  lead_id TEXT,
  conversation_id TEXT,
  lead_name TEXT,
  lead_email TEXT,
  linkedin_url TEXT,
  source_pending_reply_id UUID REFERENCES pending_replies(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'notified', 'cancelled')),
  slack_message_ts TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_follow_ups_due_pending
  ON outbound_follow_ups (due_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_outbound_follow_ups_match
  ON outbound_follow_ups (client_id, platform, campaign_id, lead_id);
