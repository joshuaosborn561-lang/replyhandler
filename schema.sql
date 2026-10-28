CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  smartlead_api_key TEXT,
  heyreach_api_key TEXT,
  allo_api_key TEXT,
  slack_bot_token TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  booking_link TEXT,
  booking_destination_url TEXT,
  voice_prompt TEXT NOT NULL DEFAULT '',
  digest_timezone TEXT,
  cc_email TEXT,
  cc_emails TEXT,
  cc_round_robin_emails TEXT,
  contact_email TEXT,
  reply_enrich_ceiling_usd NUMERIC,
  reply_enrich_ceiling_hot_usd NUMERIC,
  cc_round_robin_index INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  icp_profile JSONB,
  icp_status TEXT,
  icp_reason TEXT,
  icp_source TEXT,
  icp_transcript_count INTEGER NOT NULL DEFAULT 0,
  icp_built_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE client_claimed_leads (
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

CREATE OR REPLACE FUNCTION prevent_clients_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Deleting client rows is disabled; set active=false instead.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_clients_delete
BEFORE DELETE ON clients
FOR EACH ROW EXECUTE FUNCTION prevent_clients_delete();

CREATE TABLE pending_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  platform TEXT NOT NULL CHECK (platform IN ('smartlead', 'heyreach')),
  campaign_id TEXT,
  campaign_name TEXT,
  lead_id TEXT,
  lead_name TEXT,
  lead_email TEXT,
  linkedin_url TEXT,
  lead_phone TEXT,
  lead_phone_provider TEXT,
  lead_phone_alt TEXT,
  lead_website TEXT,
  lead_full_name TEXT,
  lead_location TEXT,
  lead_timezone TEXT,
  enrichment_receipt JSONB,
  phone_enrichment_status TEXT CHECK (
    phone_enrichment_status IS NULL
    OR phone_enrichment_status IN ('processing', 'found', 'not_found', 'failed', 'skipped')
  ),
  phone_enrichment_error TEXT,
  phone_enriched_at TIMESTAMPTZ,
  inbound_message TEXT NOT NULL,
  thread_context JSONB,
  classification TEXT NOT NULL,
  draft_reply TEXT,
  sent_reply TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'rejected', 'sent', 'flagged',
    'alert_only', 'suppressed', 'disqualified', 'meeting_booked',
    'sending', 'skipped'
  )),
  suppression_reason TEXT,
  client_note TEXT,
  slack_message_ts TEXT,
  smartlead_email_stats_id TEXT,
  follow_up_id UUID,
  follow_up_step INTEGER,
  follow_up_source_id UUID,
  cc_on_send BOOLEAN NOT NULL DEFAULT false,
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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posting', 'notified', 'cancelled', 'skipped')),
  slack_message_ts TEXT,
  skip_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  step INTEGER NOT NULL DEFAULT 1,
  sequence_hours NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbound_follow_ups_due_pending ON outbound_follow_ups (due_at) WHERE status = 'pending';
CREATE INDEX idx_outbound_follow_ups_match ON outbound_follow_ups (client_id, platform, campaign_id, lead_id);

CREATE UNIQUE INDEX idx_pending_replies_one_follow_up_card
  ON pending_replies (follow_up_id)
  WHERE follow_up_id IS NOT NULL;

CREATE UNIQUE INDEX idx_outbound_follow_ups_step_by_email
  ON outbound_follow_ups (
    client_id,
    platform,
    COALESCE(campaign_id, ''),
    lower(lead_email),
    COALESCE(conversation_id, ''),
    step,
    COALESCE(source_pending_reply_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status IN ('pending', 'posting', 'notified')
    AND lead_email IS NOT NULL AND lead_email <> '';

CREATE UNIQUE INDEX idx_outbound_follow_ups_step_by_lead
  ON outbound_follow_ups (
    client_id,
    platform,
    COALESCE(campaign_id, ''),
    lead_id,
    COALESCE(conversation_id, ''),
    step,
    COALESCE(source_pending_reply_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status IN ('pending', 'posting', 'notified')
    AND lead_id IS NOT NULL AND lead_id <> '';

CREATE TABLE disqualified_prospects (
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

CREATE INDEX idx_disqualified_prospects_client
  ON disqualified_prospects(client_id, created_at DESC);

CREATE TABLE attention_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL,
  digest_type TEXT NOT NULL CHECK (digest_type IN ('morning', 'afternoon')),
  pending_count INTEGER NOT NULL DEFAULT 0,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  slack_message_ts TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, digest_date, digest_type)
);

-- Weekly voice learning (see migrations/027_voice_profiles.sql).
ALTER TABLE pending_replies ADD COLUMN IF NOT EXISTS original_draft TEXT;

-- Every run appends a row; rows are never updated or deleted (trigger below).
-- Drafts read the newest row. A revert copies an earlier row forward as the
-- new newest (restored_from), so weekly auto-updates continue from it.
CREATE TABLE voice_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'client')),
  client_id UUID REFERENCES clients(id),
  week_ending DATE NOT NULL,
  profile JSONB NOT NULL,
  examples_used INTEGER NOT NULL DEFAULT 0,
  edited_used INTEGER NOT NULL DEFAULT 0,
  manual_used INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  trigger TEXT,
  restored_from UUID REFERENCES voice_profiles(id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT voice_profiles_scope_client CHECK (
    (scope = 'global' AND client_id IS NULL) OR (scope = 'client' AND client_id IS NOT NULL)
  )
);

CREATE INDEX voice_profiles_latest_idx
  ON voice_profiles (scope, client_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_voice_profiles_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Deleting voice_profiles rows is disabled; pin an earlier version instead.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_voice_profiles_delete
BEFORE DELETE ON voice_profiles
FOR EACH ROW EXECUTE FUNCTION prevent_voice_profiles_delete();

CREATE TRIGGER protect_voice_profiles_truncate
BEFORE TRUNCATE ON voice_profiles
FOR EACH STATEMENT EXECUTE FUNCTION prevent_voice_profiles_delete();

CREATE TABLE voice_learning_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  lookback_hours INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'cron',
  dry_run BOOLEAN NOT NULL DEFAULT false,
  summary JSONB,
  error TEXT
);

CREATE TABLE inbound_forward_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id TEXT,
  campaign_name_pattern TEXT,
  to_emails TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inbound_forward_rules_match CHECK (
    campaign_id IS NOT NULL OR campaign_name_pattern IS NOT NULL
  )
);

CREATE TABLE pitch_hidden_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL,
  hidden_count INTEGER NOT NULL DEFAULT 0,
  slack_message_ts TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, digest_date)
);

CREATE INDEX idx_pitch_hidden_summaries_date
  ON pitch_hidden_summaries (digest_date DESC);

CREATE TABLE inbound_forwards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id TEXT NOT NULL,
  lead_key TEXT NOT NULL,
  inbound_prefix TEXT NOT NULL,
  to_emails TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent')),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_key, inbound_prefix)
);

CREATE TABLE IF NOT EXISTS follow_up_call_reminders (
  lead_key TEXT NOT NULL,
  day DATE NOT NULL,
  reply_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_key, day)
);

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
  claimed_by_slack_id TEXT,
  claimed_by_name TEXT,
  claimed_at TIMESTAMPTZ,
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
-- Day-30 nurture (NURTURE_ENABLED, off by default).
--
-- A lead whose positive-reply follow-up sequence ran to the end with no reply,
-- no meeting and no DQ enters nurture. The Day 30 touch is a Slack card in
-- #nurture that a human approves; nothing here sends on its own.
-- Tables are inert until the flags are turned on.

CREATE TABLE IF NOT EXISTS nurture_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  -- Plain ids, no foreign keys: nurture history must outlive (and never block) changes to the
  -- follow-up tables it was read from.
  source_sequence_id UUID NOT NULL,
  source_reply_id UUID NOT NULL,
  lead_key TEXT NOT NULL,
  lead_name TEXT,
  lead_email TEXT,
  linkedin_url TEXT,
  company TEXT,
  -- Mirrors the HubSpot contact property nurture_stage.
  stage TEXT NOT NULL DEFAULT 'none'
    CHECK (stage IN ('none', 'day30', 'day90', 'quarterly', 'paused', 'exited')),
  next_touch_at TIMESTAMPTZ,
  last_outreach_at TIMESTAMPTZ,
  exit_reason TEXT,
  touch_count INTEGER NOT NULL DEFAULT 0,
  hubspot_contact_id TEXT,
  hubspot_synced_state TEXT,
  hubspot_synced_at TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_sequence_id)
);

-- One live nurture row per lead per client.
CREATE UNIQUE INDEX IF NOT EXISTS idx_nurture_leads_live_lead
  ON nurture_leads (client_id, lead_key) WHERE stage IN ('day30', 'day90', 'quarterly', 'paused');

CREATE INDEX IF NOT EXISTS idx_nurture_leads_due
  ON nurture_leads (next_touch_at) WHERE stage IN ('day30', 'day90', 'quarterly');

CREATE TABLE IF NOT EXISTS nurture_touches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nurture_lead_id UUID NOT NULL REFERENCES nurture_leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('day30', 'day90', 'quarterly')),
  status TEXT NOT NULL DEFAULT 'posting'
    CHECK (status IN ('posting', 'posted', 'sending', 'queued', 'skipped', 'cancelled', 'failed')),
  subject TEXT,
  body TEXT,
  phone TEXT,
  phone_status TEXT,
  slack_channel TEXT,
  slack_ts TEXT,
  smartlead_campaign_id TEXT,
  smartlead_lead_id TEXT,
  actor_slack_id TEXT,
  detail TEXT,
  posted_at TIMESTAMPTZ,
  acted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nurture_lead_id, kind)
);
