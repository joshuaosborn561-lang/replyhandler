-- Explicit SmartLead campaign -> client routing for account-wide recovery.
-- Never infer a route from campaign names and never post an unroutable row.

CREATE TABLE IF NOT EXISTS smartlead_campaign_routes (
  campaign_id TEXT PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  campaign_name TEXT,
  source TEXT NOT NULL CHECK (
    source IN ('seed_history', 'webhook', 'poller', 'manual')
  ),
  learned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smartlead_campaign_routes_client
  ON smartlead_campaign_routes(client_id);

-- Seed only unambiguous historical ownership. If one campaign has appeared
-- under multiple clients, leave it unrouted for explicit/manual correction.
INSERT INTO smartlead_campaign_routes (campaign_id, client_id, source)
SELECT
  campaign_id,
  min(client_id::text)::uuid,
  'seed_history'
FROM pending_replies
WHERE platform = 'smartlead'
  AND campaign_id IS NOT NULL
  AND btrim(campaign_id) <> ''
GROUP BY campaign_id
HAVING count(DISTINCT client_id) = 1
ON CONFLICT (campaign_id) DO NOTHING;
