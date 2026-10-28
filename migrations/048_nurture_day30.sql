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
