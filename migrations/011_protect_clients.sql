-- Protect client configuration rows from accidental deletion.
-- Client rows contain routing, Slack, SmartLead, and HeyReach configuration.
-- Losing them causes all webhooks to be skipped/unknown.

CREATE OR REPLACE FUNCTION prevent_clients_delete_or_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Deleting or truncating clients is disabled. Deactivate with active=false instead.';
END;
$$;

DROP TRIGGER IF EXISTS protect_clients_delete ON clients;
DROP TRIGGER IF EXISTS protect_clients_truncate ON clients;

CREATE TRIGGER protect_clients_delete
  BEFORE DELETE ON clients
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_clients_delete_or_truncate();

CREATE TRIGGER protect_clients_truncate
  BEFORE TRUNCATE ON clients
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_clients_delete_or_truncate();
