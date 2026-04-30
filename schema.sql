CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  smartlead_api_key TEXT,
  heyreach_api_key TEXT,
  slack_bot_token TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  booking_link TEXT,
  calendly_personal_access_token TEXT,
  voice_prompt TEXT NOT NULL DEFAULT '',
  digest_timezone TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pending_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  platform TEXT NOT NULL CHECK (platform IN ('smartlead', 'heyreach')),
  campaign_id TEXT,
  lead_id TEXT,
  lead_name TEXT,
  lead_email TEXT,
  linkedin_url TEXT,
  inbound_message TEXT NOT NULL,
  thread_context JSONB,
  classification TEXT NOT NULL,
  draft_reply TEXT,
  sent_reply TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'flagged', 'alert_only')),
  slack_message_ts TEXT,
  smartlead_email_stats_id TEXT,
  pending_nudge_sent_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  pending_reply_id UUID REFERENCES pending_replies(id),
  lead_name TEXT,
  lead_email TEXT,
  linkedin_url TEXT,
  proposed_time TEXT,
  confirmed_time TIMESTAMPTZ,
  calendar_event_id TEXT,
  calendar_provider TEXT,
  meeting_link TEXT,
  reminder_sent BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'booked', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  email TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, provider)
);

CREATE INDEX idx_pending_replies_client_id ON pending_replies(client_id);
CREATE INDEX idx_pending_replies_status ON pending_replies(status);
CREATE INDEX idx_meetings_client_id ON meetings(client_id);
CREATE INDEX idx_meetings_status ON meetings(status);

CREATE TABLE outbound_follow_ups (
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

CREATE INDEX idx_outbound_follow_ups_due_pending ON outbound_follow_ups (due_at) WHERE status = 'pending';
CREATE INDEX idx_outbound_follow_ups_match ON outbound_follow_ups (client_id, platform, campaign_id, lead_id);
