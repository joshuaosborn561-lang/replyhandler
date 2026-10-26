-- Optional SmartLead client id. When set on a master-key client, new campaigns
-- under that SmartLead client can be auto-routed (AUTO_ROUTE_SMARTLEAD_CLIENTS).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS smartlead_client_id TEXT;
