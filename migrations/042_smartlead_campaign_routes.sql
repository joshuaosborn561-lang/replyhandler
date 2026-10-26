-- Per-campaign client override for campaigns on a shared SmartLead account.
-- A client with smartlead_use_master_key = true and no key of its own uses
-- SMARTLEAD_MASTER_API_KEY from env at runtime. The key is never stored on it.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS smartlead_use_master_key BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS smartlead_campaign_routes (
  campaign_id TEXT PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
