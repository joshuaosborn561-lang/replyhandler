-- Track morning / afternoon attention digests so we post at most once per window per client.
CREATE TABLE IF NOT EXISTS attention_digests (
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
