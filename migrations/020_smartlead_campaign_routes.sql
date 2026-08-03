-- Explicit SmartLead campaign -> client routing for account-wide recovery.
-- Never infer a route from campaign names and never post an unroutable row.

CREATE TABLE IF NOT EXISTS smartlead_campaign_routes (
  campaign_id TEXT PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  campaign_name TEXT,
  source TEXT NOT NULL CHECK (
    source IN ('seed_api', 'webhook', 'poller', 'manual')
  ),
  learned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smartlead_campaign_routes_client
  ON smartlead_campaign_routes(client_id);

-- Historical pending_replies are deliberately not trusted: an earlier
-- shared-master-key incident inserted some rows under the wrong client.
-- Routes are seeded from dedicated SmartLead keys at runtime and learned from
-- verified client-specific webhook URLs.
