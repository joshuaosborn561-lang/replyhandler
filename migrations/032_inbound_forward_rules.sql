-- Campaign-mapped inbound forward (not client notify).
-- Rules: campaign id and/or name LIKE pattern → to_emails.
-- inbound_forwards is the once-per-reply claim so webhook + poller
-- cannot both send the same inbound.

CREATE TABLE IF NOT EXISTS inbound_forward_rules (
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

CREATE TABLE IF NOT EXISTS inbound_forwards (
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

CREATE INDEX IF NOT EXISTS inbound_forward_rules_campaign_id_idx
  ON inbound_forward_rules (campaign_id)
  WHERE campaign_id IS NOT NULL;

INSERT INTO inbound_forward_rules (campaign_id, campaign_name_pattern, to_emails, note)
VALUES
  ('4085158', NULL, 'gabriel.lopez@rocketbox.mx', 'Gabe Calls | SalesGlider'),
  ('4085159', NULL, 'gabriel.lopez@rocketbox.mx', 'Gabe Calls | EMCOR'),
  ('4085160', NULL, 'gabriel.lopez@rocketbox.mx', 'Gabe Calls | Deep Roots'),
  (NULL, 'Gabe Calls%', 'gabriel.lopez@rocketbox.mx', 'Future Gabe Calls campaigns by name');
